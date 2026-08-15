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
 * 'slides:html-to-native'). Extracts the page as flat draw-order elements:
 * solid-fill shapes (rect/roundRect/ellipse by border radius), text blocks
 * (own text only, with computed font size/weight/color/align), and images.
 * Gradients/shadows/transforms are deliberately ignored — the HTML contract
 * forbids them.
 */
const HTML_DOM_WALKER = `(() => {
  const page = document.querySelector('.slide') || document.body
  const hex = (c) => {
    const m = /^rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s]+([\\d.]+))?\\)$/.exec((c || '').trim())
    if (!m) return null
    const a = m[4] === undefined ? 1 : parseFloat(m[4])
    // translucent fills are decorative tints; converting them to opaque solids
    // would paint walls over the text layer — skip them entirely
    if (a < 0.55) return null
    return '#' + [1, 2, 3].map((i) => Math.max(0, Math.min(255, +m[i])).toString(16).padStart(2, '0')).join('')
  }
  const out = { background: hex(getComputedStyle(page).backgroundColor), elements: [] }
  const round = (r) => ({ x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 })
  const walk = (parent) => {
    for (const child of parent.children) {
      const cs = getComputedStyle(child)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue
      const r = child.getBoundingClientRect()
      if (r.width < 6 || r.height < 6 || r.x > 1280 || r.y > 720 || r.x + r.width < 0 || r.y + r.height < 0) continue
      if (child.tagName === 'IMG' && child.src && /^https?:/.test(child.src)) {
        out.elements.push({ kind: 'image', ...round(r), src: child.src, naturalWidth: child.naturalWidth || 0, naturalHeight: child.naturalHeight || 0 })
        continue
      }
      const bg = hex(cs.backgroundColor)
      const ownText = Array.from(child.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\\s+/g, ' ').trim()
      if (ownText) {
        if (bg) out.elements.push({ kind: shapeKind(cs, r), ...round(r), fill: bg })
        // ink box: the union of the actual glyph rects — keeps converted boxes
        // tight around the text (flex-stretched elements would otherwise emit
        // oversized boxes that trip the overlap audit), plus the visual line count
        let box = round(r)
        let lines = 1
        try {
          const range = document.createRange()
          range.selectNodeContents(child)
          const rects = Array.from(range.getClientRects()).filter((rr) => rr.width > 0 && rr.height > 0)
          if (rects.length) {
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
            for (const rr of rects) { x1 = Math.min(x1, rr.x); y1 = Math.min(y1, rr.y); x2 = Math.max(x2, rr.x + rr.width); y2 = Math.max(y2, rr.y + rr.height) }
            box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
            lines = new Set(rects.map((rr) => Math.round(rr.y / 4))).size || 1
          }
        } catch (e) { /* keep the element rect */ }
        const pt = Math.round((parseFloat(cs.fontSize) * 72 / 96) * 10) / 10
        out.elements.push({
          kind: 'text', ...box, lines, text: ownText.slice(0, 1200), pt,
          bold: parseInt(cs.fontWeight, 10) >= 600,
          color: hex(cs.color) || '#000000',
          align: cs.textAlign === 'center' ? 'center' : (cs.textAlign === 'right' || cs.textAlign === 'end') ? 'right' : 'left',
        })
        walk(child)
        continue
      }
      if (bg) out.elements.push({ kind: shapeKind(cs, r), ...round(r), fill: bg })
      walk(child)
    }
  }
  const shapeKind = (cs, r) => {
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    if (radius >= Math.min(r.width, r.height) * 0.45) return 'ellipse'
    return radius > 6 ? 'roundRect' : 'rect'
  }
  walk(page)
  if (out.elements.length > 160) out.elements = out.elements.slice(0, 160)
  return out
})()`

interface HtmlWalkResult {
  background: string | null
  elements: Array<{
    kind: 'rect' | 'roundRect' | 'ellipse' | 'text' | 'image'
    x: number
    y: number
    w: number
    h: number
    fill?: string
    text?: string
    pt?: number
    bold?: boolean
    color?: string
    align?: 'left' | 'center' | 'right'
    src?: string
    naturalWidth?: number
    naturalHeight?: number
    lines?: number
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
          opts: { fill?: string; paragraphs?: unknown[]; text?: boolean } = {},
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
            ...(opts.paragraphs ? { paragraphs: opts.paragraphs as never } : {}),
            ...(opts.text
              ? {
                  // DOM-faithful text boxes: no OOXML default insets (they were
                  // the "mystery padding" that made every converted box overflow),
                  // vertically centered for 1-2 line labels, and shrink-on-
                  // overflow so native-metric drift self-corrects instead of
                  // burning QC tool rounds
                  bodyInsets: { l: 0, t: 0, r: 0, b: 0 },
                  bodyAnchor: 'ctr',
                  bodyAutofit: 'shrink',
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
              // contain-fit the natural aspect inside the DOM rect
              const nw = el.naturalWidth || 1
              const nh = el.naturalHeight || 1
              const s = Math.min(el.w / nw, el.h / nh)
              const w = nw * s
              const h = nh * s
              addPicture(session.opened, slide, {
                bytes: new Uint8Array(buf),
                ext,
                offset: {
                  x: toEmu(clamp(el.x + (el.w - w) / 2, 1280), deckW, 1280),
                  y: toEmu(clamp(el.y + (el.h - h) / 2, 720), deckH, 720),
                  cx: Math.max(1, toEmu(w, deckW, 1280)),
                  cy: Math.max(1, toEmu(h, deckH, 720)),
                },
              })
            } catch {
              imageFailures++
            }
          } else if (el.kind === 'text') {
            // minimum height for the font so 1-2 line text never clips after
            // the native font metrics replace the DOM's
            const minH = ((el.pt ?? 14) / 0.75) * 1.4 * Math.min(el.lines ?? 1, 2)
            await emit('textbox', { ...el, h: Math.max(el.h, minH) }, {
              text: true,
              paragraphs: [
                {
                  runs: [
                    {
                      text: el.text,
                      ...(el.pt ? { fontSize: Math.max(8, Math.min(96, el.pt)) } : {}),
                      ...(el.bold ? { bold: true } : {}),
                      color: el.color ?? '#000000',
                    },
                  ],
                  ...(el.align && el.align !== 'left' ? { align: el.align } : {}),
                },
              ],
            })
          } else {
            await emit(el.kind, el, el.fill ? { fill: el.fill } : {})
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
