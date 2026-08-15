/**
 * AI IPC for the slides main process, extracted from slides-main.ts:
 * settings persistence, the streaming proxy (main process does the networking
 * to avoid renderer CORS), search tools, and the slides-only ai:* channels
 * (image generation, media analysis, style templates).
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell, webContents } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AiCreditsError,
  AiTimeoutError,
  decodeSettingsSecrets,
  defaultAiSettings,
  encodeSettingsSecrets,
  makeSafeStorageCodec,
  resolveAiSettings,
  streamForProvider,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type LegacyAiSettings,
} from '@genoffice/ai-provider'
import { aiReplyLanguageDirective, getUiLang } from '@genoffice/i18n'
import { registerSkillIpc } from '@genoffice/skill-loader/main'
import { registerTemplateIpc } from '@genoffice/template-store'
import { fetchRemoteImage } from '@genoffice/electron-utils'
import { webSearch, imageSearch } from '@genoffice/ai-search'
import { addElement, addPicture, deleteElement } from '@genoffice/pptx-engine'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'
import { tm } from './i18n-main'
import { pushHistory, rebuildSlide, sessions } from './session-state'

// ---- AI settings + streaming proxy (the main process does the networking to avoid renderer CORS; implementation shared via @genoffice/ai-provider) ----

/**
 * DOM walker executed inside the hidden conversion window (see
 * 'slides:html-to-native'). Fidelity contract with the emit side:
 *
 * 1. Line baking — the browser is the authority on line breaking. Every text
 *    block is extracted as one paragraph per VISUAL line (per-character rect
 *    binary search), with runs carrying the inline span styling. PowerPoint
 *    never re-wraps (wrap="none"), so browser/PPT font-metric differences can
 *    no longer reshuffle lines or rescale fonts.
 * 2. Coordinates are relative to the .slide origin and rescaled to 1280×720,
 *    so body margins / centering / scrollbar squish cannot shift the page.
 * 3. Translucency is resolved by alpha-compositing onto the ancestor backdrop
 *    (effective alpha = fill alpha × element opacity chain) instead of the old
 *    "drop anything below 0.55" rule that left visual holes.
 * 4. Font family + line-height + letter-spacing travel with the runs, keeping
 *    browser, editor-renderer, and PowerPoint on the same metrics.
 */
const HTML_DOM_WALKER = `(() => {
  const page = document.querySelector('.slide') || document.body
  const pageRect = page.getBoundingClientRect()
  const SX = 1280 / Math.max(1, pageRect.width)
  const SY = 720 / Math.max(1, pageRect.height)
  const px = (v) => Math.round(v * 10) / 10
  const toPage = (x, y, w, h) => ({ x: px((x - pageRect.x) * SX), y: px((y - pageRect.y) * SY), w: px(w * SX), h: px(h * SY) })

  const RGBA = /^rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s]+([\\d.]+))?\\)$/
  const col = (c) => {
    const m = RGBA.exec(String(c || '').trim())
    if (!m) return null
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : parseFloat(m[4]) }
  }
  const WHITE = { r: 255, g: 255, b: 255, a: 1 }
  const blend = (fg, bg) => fg.a >= 0.999 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 }
  const hexOf = (p) => '#' + [p.r, p.g, p.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

  // effective backdrop behind el (el itself excluded): translucent ancestors folded onto the page background
  const backdropOf = (el) => {
    const chain = []
    let node = el && el.parentElement
    while (node) {
      const p = col(getComputedStyle(node).backgroundColor)
      if (p) { chain.unshift(p); if (p.a >= 0.999) break }
      if (node === page) break
      node = node.parentElement
    }
    let acc = col(getComputedStyle(page).backgroundColor)
    acc = acc && acc.a >= 0.999 ? acc : acc ? blend(acc, WHITE) : WHITE
    for (const p of chain) acc = blend(p, acc)
    return acc
  }

  const serifish = (f) => /serif|songti|song|宋/i.test(f) && !/sans/i.test(f)
  const fontOf = (family) => serifish(String(family || '')) ? 'Songti SC' : 'PingFang SC'
  const INLINE_TAGS = { SPAN: 1, B: 1, STRONG: 1, I: 1, EM: 1, MARK: 1, A: 1, SMALL: 1, U: 1, S: 1, DEL: 1, INS: 1, CODE: 1, ABBR: 1, SUB: 1, SUP: 1, FONT: 1, TIME: 1 }
  const isInline = (el, cs) => !!INLINE_TAGS[el.tagName] || cs.display === 'inline' || cs.display === 'inline-block'
  const isBold = (w) => w === 'bold' || parseInt(w, 10) >= 600

  // split one text node's characters across its rendered line boxes; the rect
  // of each segment is that line's ink box (x1/x2/top/bottom, viewport px)
  const splitNodeLines = (node) => {
    const text = node.textContent
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = Array.from(range.getClientRects()).filter((rr) => rr.width > 0 && rr.height > 0).sort((a, b) => a.top - b.top || a.x - b.x)
    if (!rects.length) return []
    const buckets = []
    for (const rr of rects) {
      const last = buckets[buckets.length - 1]
      if (last && Math.abs(rr.top - last.top) < Math.max(2.5, Math.min(rr.height, last.bottom - last.top) * 0.6)) {
        last.bottom = Math.max(last.bottom, rr.y + rr.height)
        last.x1 = Math.min(last.x1, rr.x); last.x2 = Math.max(last.x2, rr.x + rr.width)
      } else {
        buckets.push({ top: rr.top, bottom: rr.y + rr.height, x1: rr.x, x2: rr.x + rr.width })
      }
    }
    if (buckets.length === 1) return [{ text: text.replace(/\\s+/g, ' ').trim(), rect: buckets[0] }]
    const charTop = (i) => {
      range.setStart(node, i); range.setEnd(node, Math.min(i + 1, text.length))
      const rr = range.getClientRects()
      return rr.length ? rr[0].y : null
    }
    const segments = []
    let start = 0
    for (let k = 1; k < buckets.length; k++) {
      const edge = (buckets[k - 1].bottom + buckets[k].top) / 2
      let lo = start + 1, hi = text.length, found = text.length
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const top = charTop(mid)
        if (top !== null && top >= edge) { found = mid; hi = mid - 1 } else { lo = mid + 1 }
      }
      segments.push({ text: text.slice(start, found), rect: buckets[k - 1] })
      start = found
    }
    segments.push({ text: text.slice(start), rect: buckets[buckets.length - 1] })
    return segments.map((s) => ({ text: s.text.replace(/\\s+/g, ' ').trim(), rect: s.rect })).filter((s) => s.text)
  }

  // document-order fragments across the inline subtree of a text-block root;
  // inline elements with their own background also yield a shape (badges/pills)
  const collectFragments = (el, out, subShapes, opacity) => {
    const visit = (node, cs) => {
      if (node.nodeType === 3) {
        if (!node.textContent.trim()) { out.push({ space: true }); return }
        for (const seg of splitNodeLines(node)) out.push({ text: seg.text, rect: seg.rect, cs })
        return
      }
      if (node.nodeType !== 1) return
      const ccs = getComputedStyle(node)
      if (ccs.display === 'none' || ccs.visibility === 'hidden') return
      if (!isInline(node, ccs)) return
      const op = opacity * parseFloat(ccs.opacity)
      if (op < 0.05) return
      const bg = col(ccs.backgroundColor)
      if (bg && bg.a * op > 0.05) {
        const r = node.getBoundingClientRect()
        if (r.width > 2 && r.height > 2) {
          subShapes.push({ kind: shapeKind(ccs, r), ...toPage(r.x, r.y, r.width, r.height), fill: hexOf(blend({ r: bg.r, g: bg.g, b: bg.b, a: bg.a * op }, backdropOf(node.parentElement))) })
        }
      }
      for (const c of node.childNodes) visit(c, ccs)
    }
    for (const c of el.childNodes) visit(c, getComputedStyle(el))
  }

  // font natural (normal) line height in px, probed once per font+size: CSS
  // line-height:N means N × font-size, but OOXML spcPct:N% means N × the font's
  // natural line height — the probe provides the conversion denominator
  const naturalCache = {}
  const naturalPx = (font, fs) => {
    const key = font + '|' + Math.round(fs)
    if (naturalCache[key] != null) return naturalCache[key]
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;font-family:' + JSON.stringify(font) + ';font-size:' + fs + 'px'
    probe.textContent = '国Ag'
    document.body.appendChild(probe)
    const h = probe.getBoundingClientRect().height
    document.body.removeChild(probe)
    naturalCache[key] = h > 0 ? h : fs * 1.4
    return naturalCache[key]
  }

  const buildTextBlock = (rootEl, effOp) => {
    const frags = []
    const subShapes = []
    collectFragments(rootEl, frags, subShapes, effOp)
    let prev = null
    for (const f of frags) {
      if (f.space) { if (prev) prev.spaceAfter = true; continue }
      if (prev && prev.spaceAfter && !prev.text.endsWith(' ') && !f.text.startsWith(' ')) prev.text += ' '
      prev = f
    }
    const real = frags.filter((f) => !f.space)
    if (!real.length) return null
    // cluster fragments into visual lines. Same line = shared baseline: big and
    // small runs on one baseline have different tops, so pure top-proximity
    // splits them — use ink overlap plus bottom(baseline)-closeness instead
    const lines = []
    for (const f of real) {
      const fh = f.rect.bottom - f.rect.top
      let line = null
      for (const L of lines) {
        const overlap = Math.min(f.rect.bottom, L.bottom) - Math.max(f.rect.top, L.top)
        const minH = Math.min(fh, L.h)
        if (overlap > minH * 0.25 || Math.abs(f.rect.bottom - L.bottom) < Math.max(4, minH * 0.2)) { line = L; break }
      }
      if (!line) { line = { top: f.rect.top, bottom: f.rect.bottom, h: fh, frags: [] }; lines.push(line) }
      line.top = Math.min(line.top, f.rect.top)
      line.bottom = Math.max(line.bottom, f.rect.bottom)
      line.h = Math.max(line.h, fh)
      line.frags.push(f)
    }
    lines.sort((a, b) => a.top - b.top)
    for (const L of lines) L.frags.sort((a, b) => a.rect.x1 - b.rect.x1)
    // line metrics: dominant run decides line-height ratio; ink box decides geometry
    let x1 = Infinity, x2 = -Infinity, inkTop = Infinity, inkBottom = -Infinity, maxFs = 0
    for (const L of lines) {
      let dom = L.frags[0]
      for (const f of L.frags) if (parseFloat(f.cs.fontSize) > parseFloat(dom.cs.fontSize)) dom = f
      L.fs = parseFloat(dom.cs.fontSize)
      const font = fontOf(dom.cs.fontFamily)
      const nat = naturalPx(font, L.fs)
      // 'normal' CSS line-height IS the natural height → pct 100 exactly
      const lhRaw = parseFloat(dom.cs.lineHeight)
      L.lh = lhRaw > 0 ? lhRaw : nat
      L.nat = nat
      L.pct = Math.max(50, Math.min(300, Math.round(L.lh / nat * 100)))
      L.top = Math.min.apply(null, L.frags.map((f) => f.rect.top))
      L.bottom = Math.max.apply(null, L.frags.map((f) => f.rect.bottom))
      L.x1 = Math.min.apply(null, L.frags.map((f) => f.rect.x1))
      L.x2 = Math.max.apply(null, L.frags.map((f) => f.rect.x2))
      x1 = Math.min(x1, L.x1); x2 = Math.max(x2, L.x2)
      inkTop = Math.min(inkTop, L.top); inkBottom = Math.max(inkBottom, L.bottom)
      maxFs = Math.max(maxFs, L.fs)
    }
    const rcs = getComputedStyle(rootEl)
    const align = rcs.textAlign === 'center' ? 'center' : (rcs.textAlign === 'right' || rcs.textAlign === 'end') ? 'right' : 'left'
    const first = lines[0], last = lines[lines.length - 1]
    // Baseline-exact geometry: the renderer (and PowerPoint) place line 1's
    // baseline at boxTop + fontAscent and stack lines at pct% × natural height.
    // CSS places the same ascent at lineBoxTop + (cssLh − natural)/2 — so the
    // box top must be the block's first line-box top plus that half-leading.
    const rootR = rootEl.getBoundingClientRect()
    const lbTop1 = rootR.top + (parseFloat(rcs.borderTopWidth) || 0) + (parseFloat(rcs.paddingTop) || 0)
    const y = lbTop1 + (first.lh - first.nat) / 2
    const lhSum = lines.reduce((s, L) => s + L.lh, 0)
    const h = Math.max(lhSum, maxFs * 1.25)
    const w = x2 - x1 + 5
    const x = align === 'center' ? (x1 + x2) / 2 - w / 2 : align === 'right' ? x2 - w + 3 : x1 - 2
    const backdrop = backdropOf(rootEl.parentElement)
    const el = {
      kind: 'text', ...toPage(x, y, w, h), align,
      lines: lines.map((L) => ({
        pct: L.pct,
        inkTop: +(((L.top - pageRect.y) * SY)).toFixed(1),
        inkBottom: +(((L.bottom - pageRect.y) * SY)).toFixed(1),
        runs: L.frags.map((f) => {
          const fc = col(f.cs.color) || { r: 0, g: 0, b: 0, a: 1 }
          const spcRaw = parseFloat(f.cs.letterSpacing)
          return {
            text: f.text,
            pt: Math.round(parseFloat(f.cs.fontSize) * 72 / 96 * 10) / 10,
            bold: isBold(f.cs.fontWeight),
            color: hexOf(blend({ r: fc.r, g: fc.g, b: fc.b, a: fc.a * effOp }, backdrop)),
            font: fontOf(f.cs.fontFamily),
            ...(isFinite(spcRaw) && Math.abs(spcRaw) > 0.05 ? { spc: Math.round(spcRaw * 0.75 * 100) / 100 } : {}),
          }
        }),
      })),
    }
    return { el, subShapes }
  }

  const shapeKind = (cs, r) => {
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    if (radius >= Math.min(r.width, r.height) * 0.45) return 'ellipse'
    return radius > 4 ? 'roundRect' : 'rect'
  }

  const out = { background: hexOf(blend(col(getComputedStyle(page).backgroundColor) || WHITE, WHITE)), elements: [] }
  const pushShape = (el, cs, r, effOp) => {
    const bg = col(cs.backgroundColor)
    if (!bg || bg.a * effOp < 0.03) return
    const kind = shapeKind(cs, r)
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    const shortSide = Math.min(r.width, r.height)
    const adj = kind === 'roundRect' && shortSide > 0 ? Math.min(50000, Math.round(radius / shortSide * 100000)) : 0
    out.elements.push({
      kind, ...toPage(r.x, r.y, r.width, r.height),
      fill: hexOf(blend({ r: bg.r, g: bg.g, b: bg.b, a: bg.a * effOp }, backdropOf(el.parentElement))),
      ...(adj > 0 ? { adj } : {}),
    })
  }
  const walk = (parent, parentOp, skipInlineChildren) => {
    for (const child of parent.children) {
      const cs = getComputedStyle(child)
      const op = parentOp * parseFloat(cs.opacity)
      if (cs.display === 'none' || cs.visibility === 'hidden' || op < 0.05) continue
      const r = child.getBoundingClientRect()
      if (r.width * SX < 2 || r.height * SY < 2) continue
      if (r.x + r.width < pageRect.x || r.x > pageRect.x + pageRect.width || r.y + r.height < pageRect.y || r.y > pageRect.y + pageRect.height) continue
      if (skipInlineChildren && isInline(child, cs)) continue
      if (child.tagName === 'IMG' && child.src && /^https?:/.test(child.src)) {
        out.elements.push({ kind: 'image', ...toPage(r.x, r.y, r.width, r.height), src: child.src, naturalWidth: child.naturalWidth || 0, naturalHeight: child.naturalHeight || 0, fit: cs.objectFit || 'fill' })
        continue
      }
      const kids = Array.from(child.children)
      const directText = Array.from(child.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
      // all-inline children (e.g. <div><span>a</span><span>b</span></div>) form one
      // text block too — splitting them into separate boxes breaks the baseline
      const inlineOnly = !directText && kids.length > 0 && kids.every((g) => {
        const gcs = getComputedStyle(g)
        return gcs.display !== 'none' && isInline(g, gcs)
      })
      pushShape(child, cs, r, op)
      if (directText || inlineOnly) {
        const block = buildTextBlock(child, op)
        if (block) {
          for (const s of block.subShapes) out.elements.push(s)
          out.elements.push(block.el)
        }
      }
      walk(child, op, directText || inlineOnly)
    }
  }
  walk(page, 1, false)
  return out
})()`

interface HtmlWalkRun {
  text: string
  pt: number
  bold?: boolean
  color?: string
  font?: string
  spc?: number
}

interface HtmlWalkResult {
  background: string | null
  elements: Array<{
    kind: 'rect' | 'roundRect' | 'ellipse' | 'text' | 'image'
    x: number
    y: number
    w: number
    h: number
    fill?: string
    adj?: number
    align?: 'left' | 'center' | 'right'
    lines?: Array<{ pct?: number; runs: HtmlWalkRun[] }>
    src?: string
    naturalWidth?: number
    naturalHeight?: number
    fit?: string
  }>
}

const AI_SETTINGS_PATH = () => join(app.getPath('userData'), 'ai-settings.json')

/** ai-settings.json at rest: API keys encrypted through the OS keychain when available */
const secretCodec = makeSafeStorageCodec(safeStorage)

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* Corrupted state file: fall back to defaults */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const activeAiStreams = new Map<string, AbortController>()

export function registerAiIpc(): void {
  ipcMain.handle('ai:get-settings', (): AiSettings => {
    const stored = readJson<Partial<AiSettings> & LegacyAiSettings>(AI_SETTINGS_PATH(), {})
    const settings = resolveAiSettings(decodeSettingsSecrets(stored, secretCodec), defaultAiSettings())
    // [BYOK] allow user-chosen provider.
    return settings
  })

  ipcMain.handle('ai:set-settings', (_event, settings: AiSettings) => {
    writeJson(AI_SETTINGS_PATH(), encodeSettingsSecrets(settings, secretCodec))
    // open editor views load settings once at mount; keep them live
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('ai:settings-changed', settings)
    }
  })

  ipcMain.handle('ai:stream', async (event, request: AiStreamRequest) => {
    const { requestId, settings, messages } = request
    const tools = request.tools ?? []
    const maxTokens = request.maxTokens ?? 8192
    // English-heavy prompts/tools would otherwise make the model drift into English
    const system = request.system + aiReplyLanguageDirective(getUiLang())
    const provider = settings.provider
    const config = settings.providers?.[provider]
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    if (!config?.apiKey) {
      send({ requestId, type: 'error', error: tm('errNoApiKey', { provider }) })
      return
    }
    if (!config.model) {
      send({ requestId, type: 'error', error: tm('errNoModel') })
      return
    }
    const controller = new AbortController()
    activeAiStreams.set(requestId, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      await streamForProvider(provider, config, system, messages, tools, maxTokens, {
        signal: controller.signal,
        onDelta: (text) => send({ requestId, type: 'delta', text }),
        onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
        onActivity: ping,
      })
      send({ requestId, type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ai-stream] ${requestId} (${provider}/${config.model}) failed:`, msg)
        send({
          requestId,
          type: 'error',
          error: msg,
          ...(err instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : err instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : {}),
        })
      }
    } finally {
      activeAiStreams.delete(requestId)
    }
  })

  ipcMain.handle('ai:stream-cancel', (_event, requestId: string) => {
    activeAiStreams.get(requestId)?.abort()
  })

  // Search tools (content + images), Serper with DuckDuckGo fallback
  ipcMain.handle('ai:web-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await webSearch(String(query), typeof maxResults === 'number' ? maxResults : 6)
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })

  ipcMain.handle('ai:image-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await imageSearch(String(query), typeof maxResults === 'number' ? maxResults : 8)
    } catch (err) {
      return { images: [], method: 'error', error: String(err) }
    }
  })

  // [skills] user-supplied + bundled agent skills discovery
  const bundledSkillsRoot = app.isPackaged
    ? join(process.resourcesPath, 'skills-builtin')
    : join(app.getAppPath(), '..', '..', 'packages', 'skills-builtin', 'skills')
  registerSkillIpc(ipcMain, app.getPath('userData'), shell, bundledSkillsRoot)

  // [templates] user template store
  registerTemplateIpc(ipcMain, app.getPath('userData'))
}

// ── ai:* handlers unique to slides ──────────────────────────────────────
// Must be registered inside registerSlidesIpc (not registerAiIpc): in shell aggregate mode the
// generic ai:* channels are registered by docs-main.registerAiIpc, and slides' registerAiIpc is
// never called; docs does not have these channels, so putting them in the wrong place raises
// "No handler registered".
export function registerSlidesOnlyAiIpc(): void {
  // [BYOK] AI image generation. Configurable via ai-settings.json's `imageGen` field.
  //   - not configured / provider='none' → disabled, returns a friendly error (the AI
  //     agent then avoids the generate_image tool and falls back to web image search)
  //   - configured → routes to a self-chosen cloud text-to-image backend.
  //     The adapter is a placeholder for now (returns errImageGenNotWired); wire in the
  //     real call (aliyun-wanx / volcengine-jimeng / custom OpenAI-compatible) per provider.
  ipcMain.handle(
    'ai:generate-image',
    async (
      _event,
      op: {
        prompt: string
        model?: string
        referenceImageUrls?: string[]
        aspectRatio?: string
        imageSize?: string
      },
    ) => {
      const stored = readJson<Partial<AiSettings>>(AI_SETTINGS_PATH(), {})
      const cfg = stored.imageGen
      const provider = cfg?.provider
      if (!provider || provider === 'none' || !cfg?.apiKey) {
        return { error: tm('errImageGenDisabled') }
      }
      try {
        // TODO[BYOK]: implement the real provider call here. Signature kept compatible
        // with the old cloudGenerateImage: { prompt, model?, referenceImageUrls?, aspectRatio?,
        // imageSize? } → { url }. Return a publicly downloadable image URL.
        //   - aliyun-wanx: POST /api/v1/services/aigc/text2image/image-synthesis (async poll)
        //   - volcengine-jimeng: POST /?Action=CVProcess (visual tech)
        //   - custom: POST {baseUrl}/... (OpenAI-compatible image API or similar)
        // Until wired, signal that configuration was accepted but generation is pending.
        return { error: tm('errImageGenNotWired', { provider }) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // [BYOK] Media analysis / transcription is retired (was Hi-office-only, low usage).
  // Returns a disabled notice so the AI agent stops attempting the tool.
  ipcMain.handle('ai:analyze-media', async () => ({ error: tm('errMediaDisabled') }))

  // ── Local HTML→native page rebuild ─────────────────────────────────────────
  // The original regeneration pipeline converted the model's page HTML in the
  // (removed) cloud service. This restores that route locally: render the HTML
  // in a locked-down hidden window, walk the DOM, and rebuild the slide with
  // native elements — free-form design without any network dependency beyond
  // the images the page itself references.
  ipcMain.handle(
    'slides:html-to-native',
    async (
      e,
      op: { slideIndex: number; html: string },
    ): Promise<{ slide: unknown } | { error: string }> => {
      const session = sessions.get(e.sender.id)
      if (!session) return { error: 'no open presentation session' }
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return { error: `slideIndex ${op.slideIndex} out of range` }
      const html = String(op.html ?? '')
      if (html.length < 40 || html.length > 60_000) return { error: 'html length out of bounds' }

      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      try {
        await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'))
        await win.webContents.executeJavaScript(
          'Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))])',
          true,
        )
        const parsed = (await win.webContents.executeJavaScript(HTML_DOM_WALKER, true)) as
          | HtmlWalkResult
          | null
        if (!parsed || !Array.isArray(parsed.elements)) return { error: 'DOM walk failed' }
        if (parsed.elements.length > 220) {
          return {
            error: `page has ${parsed.elements.length} convertible elements (max 220) — simplify the design: fewer decorative boxes, keep only essential text and shapes`,
          }
        }
        if (parsed.elements.length > 0 && !parsed.elements.some((el) => el.kind === 'text')) {
          return { error: 'no text found in the page — text must be real DOM text, not CSS or images' }
        }

        const deckW = session.opened.deck.size.cx
        const deckH = session.opened.deck.size.cy
        const toEmu = (px: number, total: number, domTotal: number) =>
          Math.round((px / domTotal) * total)
        const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))

        pushHistory(session)
        // clear the page (keep layout decorations) — one history step for the whole rebuild
        for (const el of [...slide.elements]) {
          if (!(el as { decoration?: boolean }).decoration) deleteElement(slide, el.id)
        }
        const emit = async (
          kind: string,
          r: { x: number; y: number; w: number; h: number },
          opts: {
            fill?: string
            paragraphs?: unknown[]
            text?: boolean
            roundRectAdj?: number
          } = {},
        ) => {
          addElement(slide, {
            kind,
            offset: {
              x: toEmu(clamp(r.x, 1280), deckW, 1280),
              y: toEmu(clamp(r.y, 720), deckH, 720),
              cx: Math.max(1, toEmu(Math.min(r.w, 1280 - r.x), deckW, 1280)),
              cy: Math.max(1, toEmu(Math.min(r.h, 720 - r.y), deckH, 720)),
            },
            ...(opts.fill ? { fillColor: opts.fill } : {}),
            ...(opts.roundRectAdj ? { roundRectAdj: opts.roundRectAdj } : {}),
            ...(opts.paragraphs ? { paragraphs: opts.paragraphs as never } : {}),
            ...(opts.text
              ? {
                  // DOM-faithful text boxes. The browser already decided the line
                  // breaks (one paragraph per visual line) and the box geometry, so:
                  // zero insets, top anchor, no autofit (shrink would rescale the
                  // design), and wrap="none" so native metrics can never re-wrap.
                  bodyInsets: { l: 0, t: 0, r: 0, b: 0 },
                  bodyAnchor: 't',
                  bodyWrap: 'none',
                }
              : {}),
          })
        }
        if (parsed.background) await emit('rect', { x: 0, y: 0, w: 1280, h: 720 }, { fill: parsed.background })
        let imageFailures = 0
        for (const el of parsed.elements) {
          if (el.kind === 'image') {
            try {
              const resp = await fetchRemoteImage(el.src ?? '')
              if (!resp || !resp.ok) throw new Error('fetch failed')
              const buf = Buffer.from(await resp.arrayBuffer())
              const ct = resp.headers.get('content-type') ?? ''
              const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg'
              const nw = el.naturalWidth || 1
              const nh = el.naturalHeight || 1
              let box = { x: el.x, y: el.y, w: el.w, h: el.h }
              let srcRect: { l?: number; t?: number; r?: number; b?: number } | undefined
              if (el.fit === 'cover') {
                // crop-to-fill: fractions of the scaled bitmap cut from each edge
                const s = Math.max(el.w / nw, el.h / nh)
                const cutX = Math.max(0, (nw * s - el.w) / (nw * s)) / 2
                const cutY = Math.max(0, (nh * s - el.h) / (nh * s)) / 2
                if (cutX > 0.002 || cutY > 0.002) {
                  srcRect = {
                    ...(cutX > 0.002 ? { l: cutX, r: cutX } : {}),
                    ...(cutY > 0.002 ? { t: cutY, b: cutY } : {}),
                  }
                }
              } else if (el.fit !== 'fill') {
                // contain: center the natural aspect inside the DOM rect
                const s = Math.min(el.w / nw, el.h / nh)
                const w = nw * s
                const h = nh * s
                box = { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h }
              }
              addPicture(session.opened, slide, {
                bytes: new Uint8Array(buf),
                ext,
                offset: {
                  x: toEmu(clamp(box.x, 1280), deckW, 1280),
                  y: toEmu(clamp(box.y, 720), deckH, 720),
                  cx: Math.max(1, toEmu(Math.min(box.w, 1280 - box.x), deckW, 1280)),
                  cy: Math.max(1, toEmu(Math.min(box.h, 720 - box.y), deckH, 720)),
                },
                ...(srcRect ? { srcRect } : {}),
              })
            } catch {
              imageFailures++
            }
          } else if (el.kind === 'text') {
            await emit('textbox', el, {
              text: true,
              paragraphs: (el.lines ?? []).map((line) => ({
                runs: line.runs.map((run) => ({
                  text: run.text,
                  fontSize: Math.max(8, Math.min(96, run.pt)),
                  ...(run.bold ? { bold: true } : {}),
                  color: run.color ?? '#000000',
                  fontFamily: run.font ?? 'PingFang SC',
                  ...(run.spc ? { letterSpacing: run.spc } : {}),
                })),
                ...(el.align && el.align !== 'left' ? { align: el.align } : {}),
                ...(line.pct ? { lineHeight: line.pct } : {}),
              })),
            })
          } else {
            await emit(el.kind, el, {
              ...(el.fill ? { fill: el.fill } : {}),
              ...(el.adj ? { roundRectAdj: el.adj } : {}),
            })
          }
        }
        const rebuilt = rebuildSlide(session, op.slideIndex)
        if (!rebuilt) {
          session.undoStack.pop()
          return { error: 'slide rebuild failed' }
        }
        return {
          slide: rebuilt,
          ...(imageFailures > 0 ? { imageFailures } : {}),
        } as { slide: unknown }
      } catch (err) {
        session.undoStack.pop()
        return { error: err instanceof Error ? err.message : String(err) }
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }
    },
  )

  // Download an image from a URL and insert it into the given page (image search -> insert in one step; download in the main process avoids CORS)
  ipcMain.handle(
    'ai:insert-image-url',
    async (
      e,
      op: {
        slideIndex: number
        url: string
        xPx: number
        yPx: number
        wPx: number
        hPx: number
        fitWidthPx: number
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      try {
        // the URL originates from AI tool calls (prompt-injectable via image
        // search results), so refuse non-http schemes and private/link-local
        // targets; redirects are followed manually so every hop is validated.
        // fetchRemoteImage adds CDN-friendly headers and transient-error retries.
        const resp = await fetchRemoteImage(String(op.url))
        if (!resp || !resp.ok) return null
        const buf = Buffer.from(await resp.arrayBuffer())
        const ct = resp.headers.get('content-type') ?? ''
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg'
        const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
        const scale = op.fitWidthPx / baseWidthPx
        const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
        pushHistory(session)
        const el = addPicture(session.opened, slide, {
          bytes: new Uint8Array(buf),
          ext,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
        })
        if (!el) {
          session.undoStack.pop()
          return null
        }
        session.fitWidthPx = op.fitWidthPx
        const rebuilt = rebuildSlide(session, op.slideIndex)
        return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
      } catch {
        return null
      }
    },
  )

  // ── Style Skill sidecar persistence: write a same-named .styleskill.json next to the draft (fail-open)
  ipcMain.handle(
    'ai:save-sidecar',
    async (
      event,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): Promise<{ ok: boolean }> => {
      try {
        const session = sessions.get(event.sender.id)
        const draftPath = session?.path
        if (!draftPath || !draftPath.endsWith('.pptx')) return { ok: false }
        const sidecarPath = draftPath.replace(/\.pptx$/i, '.styleskill.json')
        writeFileSync(sidecarPath, JSON.stringify(data, null, 2))
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  )

  // ── Style template save: stored in userData/style-templates/<name>.json
  const STYLE_TEMPLATES_DIR = () => join(app.getPath('userData'), 'style-templates')

  ipcMain.handle(
    'ai:save-style-template',
    (
      _event,
      name: string,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): { ok: boolean; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        mkdirSync(dir, { recursive: true })
        // Filename: replace illegal characters in the name with _ then truncate to 64 chars
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        if (!safeName) return { ok: false, error: tm('errTplNameInvalid') }
        writeJson(join(dir, `${safeName}.json`), { ...data, name: safeName })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // ── Style template list
  ipcMain.handle(
    'ai:list-style-templates',
    (): Array<{ name: string; topic: string; createdAt: string }> => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        if (!existsSync(dir)) return []
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
        return files
          .map((f) => {
            try {
              const raw = readJson<{
                name?: string
                topic?: string
                createdAt?: string
                styleSkill?: string
              }>(join(dir, f), {})
              return {
                name: raw.name ?? f.replace(/\.json$/, ''),
                topic: raw.topic ?? '',
                createdAt: raw.createdAt ?? '',
              }
            } catch {
              return null
            }
          })
          .filter(Boolean) as Array<{ name: string; topic: string; createdAt: string }>
      } catch {
        return []
      }
    },
  )

  // ── Style template load
  ipcMain.handle(
    'ai:load-style-template',
    (
      _event,
      name: string,
    ): { ok: boolean; styleSkill?: string; topic?: string; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        const filePath = join(dir, `${safeName}.json`)
        if (!existsSync(filePath)) return { ok: false, error: tm('errTplMissing', { name }) }
        const raw = readJson<{ styleSkill?: string; topic?: string }>(filePath, {})
        if (!raw.styleSkill) return { ok: false, error: tm('errTplNoSkill', { name }) }
        return { ok: true, styleSkill: raw.styleSkill, topic: raw.topic ?? '' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
