import type { DeckAccess } from './slides-skill'

/**
 * Local whole-page redesign: the model composes a structured PagePlan (variant
 * + content + palette, copy kept verbatim from read_slide) and these
 * deterministic renderers rebuild the page with native elements. Design
 * quality comes from the fixed variant geometry, not from the model's layout
 * improvisation — the template-based approach that works well with text-only
 * models. Replaces the removed cloud page-regeneration service.
 */

export const PAGE_PLAN_VARIANTS = [
  'cover_typography_hero',
  'cover_split_color',
  'three_column_cards',
  'hero_big_number',
  'two_column_comparison',
  'left_text_right_image',
  'kpi_cards_row',
  'table_of_contents',
  'section_divider',
  'closing_thank_you',
] as const

export type PagePlanVariant = (typeof PAGE_PLAN_VARIANTS)[number]

export interface PagePlan {
  variant: PagePlanVariant
  title: string
  subtitle?: string
  footer?: string
  /** #RRGGBB palette (keep the deck's existing scheme when possible) */
  accent: string
  background: string
  textColor: string
  cardColor?: string
  /** three_column_cards / two_column_comparison */
  cards?: Array<{ heading: string; body: string }>
  /** hero_big_number */
  number?: string
  numberLabel?: string
  body?: string
  /** left_text_right_image */
  bullets?: string[]
  /** kpi_cards_row */
  kpis?: Array<{ value: string; label: string }>
  /** table_of_contents: numbered entries */
  items?: Array<{ label: string; sub?: string }>
  /** section_divider: the big section number (e.g. "02") */
  sectionNumber?: string
  /** http(s) image URL for left_text_right_image / cover_split_color */
  imageUrl?: string
}

const HEX = /^#[0-9a-fA-F]{6}$/

function str(v: unknown, max = 600): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/** Loose validation: never throws — invalid fields fall back, a bad variant is rejected. */
export function parsePagePlan(raw: unknown): { ok: true; plan: PagePlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'plan must be an object' }
  const p = raw as Record<string, unknown>
  const variant = String(p.variant ?? '')
  if (!(PAGE_PLAN_VARIANTS as readonly string[]).includes(variant)) {
    return { ok: false, error: `variant must be one of: ${PAGE_PLAN_VARIANTS.join(' | ')}` }
  }
  const title = str(p.title, 300).trim()
  if (!title) return { ok: false, error: 'title is required' }
  const hex = (v: unknown, fallback: string): string => {
    const s = str(v, 9).trim()
    return HEX.test(s) ? s : fallback
  }
  const plan: PagePlan = {
    variant: variant as PagePlanVariant,
    title,
    subtitle: str(p.subtitle, 300) || undefined,
    footer: str(p.footer, 200) || undefined,
    accent: hex(p.accent, '#2563EB'),
    background: hex(p.background, '#FFFFFF'),
    textColor: hex(p.textColor, '#1F2937'),
    cardColor: hex(p.cardColor, '#F3F4F6'),
    number: str(p.number, 40) || undefined,
    numberLabel: str(p.numberLabel, 200) || undefined,
    body: str(p.body, 900) || undefined,
    imageUrl: /^https?:\/\//.test(String(p.imageUrl ?? '')) ? String(p.imageUrl) : undefined,
  }
  if (Array.isArray(p.cards)) {
    plan.cards = p.cards
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ heading: str(c.heading, 160), body: str(c.body, 700) }))
      .slice(0, 4)
  }
  if (Array.isArray(p.bullets)) {
    plan.bullets = p.bullets.map((b) => str(b, 240)).filter(Boolean).slice(0, 7)
  }
  if (Array.isArray(p.items)) {
    plan.items = p.items
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ label: str(c.label, 160), sub: str(c.sub, 200) || undefined }))
      .filter((c) => c.label)
      .slice(0, 6)
  }
  plan.sectionNumber = str(p.sectionNumber, 12) || undefined
  if (Array.isArray(p.kpis)) {
    plan.kpis = p.kpis
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ value: str(c.value, 40), label: str(c.label, 120) }))
      .filter((c) => c.value)
      .slice(0, 4)
  }
  return { ok: true, plan }
}

interface Paragraph {
  runs: Array<{
    text: string
    bold?: boolean
    fontSize?: number
    color?: string
  }>
  align?: 'left' | 'center' | 'right'
}

const PT_TO_PX = 96 / 72

/** Mix a hex color toward white (ratio 0..1) — light tints for decorative shapes. */
function tint(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round(((n >> 16) & 0xff) + (255 - ((n >> 16) & 0xff)) * ratio)
  const g = Math.round(((n >> 8) & 0xff) + (255 - ((n >> 8) & 0xff)) * ratio)
  const b = Math.round((n & 0xff) + (255 - (n & 0xff)) * ratio)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** Rebuild slide `idx` from `plan` using native add/delete element ops. */
export async function renderPagePlan(access: DeckAccess, idx: number, plan: PagePlan): Promise<{ ok: boolean; error?: string }> {
  const api = window.slidesApi
  // 1. clear the page (keep master decorations)
  let slide = access.getSlides()[idx]
  if (!slide) return { ok: false, error: `slideIndex ${idx} out of range` }
  const W = slide.widthPx
  const H = slide.heightPx
  const M = Math.round(W * 0.05)
  for (const n of slide.nodes) {
    if (n.decoration) continue
    const updated = await api.deleteElement({ slideIndex: idx, sourceId: n.sourceId })
    if (updated) {
      access.applySlide(idx, updated)
      slide = updated
    }
  }

  // 2. background + building blocks
  const add = async (
    kind: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { fill?: string; paragraphs?: Paragraph[] } = {},
  ): Promise<boolean> => {
    const r = await api.addElement({
      slideIndex: idx,
      kind,
      xPx: Math.round(x),
      yPx: Math.round(y),
      wPx: Math.round(w),
      hPx: Math.round(h),
      fitWidthPx: access.fitWidthPx,
      ...(opts.fill ? { fillColor: opts.fill } : {}),
      ...(opts.paragraphs
        ? {
            paragraphs: opts.paragraphs,
            // deterministic text: zero insets (no ~9.6px hidden shift), shrink so
            // long copy self-fits instead of spilling out of the card
            bodyInsets: { l: 0, t: 0, r: 0, b: 0 },
            bodyAutofit: 'shrink',
          }
        : {}),
    })
    if (!r) return false
    access.applySlide(idx, r.slide)
    return true
  }
  const text = (
    parts: Array<[string, number, boolean, string?]>,
    align?: 'left' | 'center' | 'right',
  ): Paragraph[] => [
    {
      runs: parts.map(([t, size, bold, color]) => ({
        text: t,
        fontSize: size,
        ...(bold ? { bold: true } : {}),
        color: color ?? plan.textColor,
      })),
      ...(align ? { align } : {}),
    },
  ]

  await add('rect', 0, 0, W, H, { fill: plan.background })

  const cardList = plan.cards ?? []
  const kpiList = plan.kpis ?? []

  switch (plan.variant) {
    case 'cover_typography_hero': {
      await add('rect', M, H * 0.4, 110, 10, { fill: plan.accent })
      await add(
        'textbox',
        M,
        H * 0.45,
        W - 2 * M,
        44 * PT_TO_PX * 2,
        { paragraphs: text([[plan.title, 48, true]], 'left') },
      )
      if (plan.subtitle) {
        await add('textbox', M, H * 0.62, W - 2 * M, 30 * PT_TO_PX, {
          paragraphs: text([[plan.subtitle, 20, false]]),
        })
      }
      if (plan.footer) {
        await add('textbox', M, H - M - 16 * PT_TO_PX, W - 2 * M, 16 * PT_TO_PX, {
          paragraphs: text([[plan.footer, 12, false]]),
        })
      }
      break
    }
    case 'cover_split_color': {
      await add('rect', 0, 0, W * 0.58, H, { fill: plan.accent })
      await add('textbox', M, H * 0.34, W * 0.58 - 2 * M, 40 * PT_TO_PX * 2, {
        paragraphs: text([[plan.title, 36, true, '#FFFFFF']], 'left'),
      })
      if (plan.subtitle) {
        await add('textbox', M, H * 0.56, W * 0.58 - 2 * M, 30 * PT_TO_PX, {
          paragraphs: text([[plan.subtitle, 17, false, '#FFFFFF']]),
        })
      }
      if (plan.imageUrl) {
        const r = await api.insertImageUrl({
          slideIndex: idx,
          url: plan.imageUrl,
          xPx: Math.round(W * 0.58),
          yPx: 0,
          wPx: Math.round(W * 0.42),
          hPx: H,
          fitWidthPx: access.fitWidthPx,
        })
        if (r) access.applySlide(idx, r.slide)
      } else {
        // No usable image — fill the right side with a deterministic decorative
        // composition instead of leaving it blank
        const rx = W * 0.58
        await add('rect', rx, 0, W - rx, H, { fill: tint(plan.accent, 0.88) })
        await add('ellipse', rx + (W - rx) * 0.12, H * 0.16, (W - rx) * 0.62, (W - rx) * 0.62, {
          fill: tint(plan.accent, 0.72),
        })
        await add('ellipse', rx + (W - rx) * 0.38, H * 0.5, (W - rx) * 0.66, (W - rx) * 0.66, {
          fill: plan.accent,
        })
        await add('ellipse', rx + (W - rx) * 0.2, H * 0.62, (W - rx) * 0.2, (W - rx) * 0.2, {
          fill: tint(plan.accent, 0.45),
        })
      }
      if (plan.footer) {
        await add('textbox', M, H - M - 16 * PT_TO_PX, W * 0.58 - 2 * M, 16 * PT_TO_PX, {
          paragraphs: text([[plan.footer, 12, false, '#FFFFFF']]),
        })
      }
      break
    }
    case 'three_column_cards':
    case 'kpi_cards_row': {
      const items =
        plan.variant === 'kpi_cards_row'
          ? kpiList.map((k) => ({ heading: k.value, body: k.label }))
          : cardList
      const n = Math.max(1, Math.min(items.length || 1, 4))
      const gap = 28
      const cardW = (W - 2 * M - gap * (n - 1)) / n
      const cardY = H * 0.3
      const cardH = H * 0.52
      await add('textbox', M, 44, W - 2 * M, 34 * PT_TO_PX, {
        paragraphs: text([[plan.title, 28, true]]),
      })
      await add('rect', M, 44 + 34 * PT_TO_PX + 8, 72, 6, { fill: plan.accent })
      if (plan.subtitle) {
        await add('textbox', M, 44 + 34 * PT_TO_PX + 24, W - 2 * M, 18 * PT_TO_PX, {
          paragraphs: text([[plan.subtitle, 14, false]]),
        })
      }
      for (let i = 0; i < n; i++) {
        const x = M + i * (cardW + gap)
        const item = items[i]
        await add('rect', x, cardY, cardW, cardH, { fill: plan.cardColor })
        await add('rect', x, cardY, cardW, 6, { fill: plan.accent })
        if (item) {
          const isKpi = plan.variant === 'kpi_cards_row'
          await add(
            'textbox',
            x + 20,
            cardY + 28,
            cardW - 40,
            (isKpi ? 40 : 20) * PT_TO_PX + 8,
            { paragraphs: text([[item.heading, isKpi ? 34 : 18, true, plan.accent]]) },
          )
          await add('textbox', x + 20, cardY + (isKpi ? 96 : 66), cardW - 40, cardH - 120, {
            paragraphs: text([[item.body, 13, false]]),
          })
        }
      }
      break
    }
    case 'hero_big_number': {
      await add('textbox', M, H * 0.18, W * 0.42, 100 * PT_TO_PX, {
        paragraphs: text([[plan.number ?? plan.title, 88, true, plan.accent]]),
      })
      if (plan.numberLabel) {
        await add('textbox', M, H * 0.18 + 100 * PT_TO_PX + 8, W * 0.42, 20 * PT_TO_PX, {
          paragraphs: text([[plan.numberLabel, 14, true]]),
        })
      }
      const rightX = W * 0.5
      await add('textbox', rightX, H * 0.24, W - rightX - M, 32 * PT_TO_PX * 2, {
        paragraphs: text([[plan.title, 28, true]]),
      })
      await add('rect', rightX, H * 0.24 + 76, 64, 6, { fill: plan.accent })
      if (plan.body ?? plan.subtitle) {
        await add('textbox', rightX, H * 0.24 + 100, W - rightX - M, H * 0.4, {
          paragraphs: text([[plan.body ?? plan.subtitle ?? '', 15, false]]),
        })
      }
      break
    }
    case 'two_column_comparison': {
      await add('textbox', M, 44, W - 2 * M, 30 * PT_TO_PX, {
        paragraphs: text([[plan.title, 26, true]]),
      })
      const gap = 32
      const colW = (W - 2 * M - gap) / 2
      const colY = H * 0.26
      const colH = H * 0.58
      for (let i = 0; i < 2; i++) {
        const x = M + i * (colW + gap)
        const item = cardList[i]
        await add('rect', x, colY, colW, colH, { fill: i === 0 ? plan.cardColor : plan.background })
        await add('rect', x, colY, colW, 6, { fill: i === 0 ? plan.accent : plan.textColor })
        await add('textbox', x + 22, colY + 26, colW - 44, 22 * PT_TO_PX + 6, {
          paragraphs: text([[item?.heading ?? '', 19, true, i === 0 ? plan.accent : plan.textColor]]),
        })
        await add('textbox', x + 22, colY + 70, colW - 44, colH - 96, {
          paragraphs: text([[item?.body ?? '', 14, false]]),
        })
      }
      break
    }
    case 'left_text_right_image': {
      await add('textbox', M, 44, W - 2 * M, 30 * PT_TO_PX, {
        paragraphs: text([[plan.title, 26, true]]),
      })
      await add('rect', M, 44 + 30 * PT_TO_PX + 10, 64, 6, { fill: plan.accent })
      const bullets = plan.bullets ?? (plan.body ? [plan.body] : [])
      const leftBox: Paragraph[] =
        bullets.length > 0
          ? bullets.map((b) => ({ runs: [{ text: `•  ${b}`, fontSize: 15, color: plan.textColor }] }))
          : []
      if (leftBox.length) {
        await add('textbox', M, H * 0.28, W * 0.46 - M, H * 0.58, { paragraphs: leftBox })
      }
      if (plan.imageUrl) {
        const r = await api.insertImageUrl({
          slideIndex: idx,
          url: plan.imageUrl,
          xPx: Math.round(W * 0.52),
          yPx: Math.round(H * 0.22),
          wPx: Math.round(W - W * 0.52 - M),
          hPx: Math.round(H * 0.66),
          fitWidthPx: access.fitWidthPx,
        })
        if (r) access.applySlide(idx, r.slide)
      } else {
        await add('rect', W * 0.52, H * 0.22, W - W * 0.52 - M, H * 0.66, { fill: plan.cardColor })
        await add('rect', W * 0.52, H * 0.22, W - W * 0.52 - M, 6, { fill: plan.accent })
      }
      break
    }
    case 'table_of_contents': {
      const items = plan.items ?? []
      await add('textbox', M, 44, W - 2 * M, 32 * PT_TO_PX, {
        paragraphs: text([[plan.title || '目录', 28, true]]),
      })
      await add('rect', M, 44 + 32 * PT_TO_PX + 10, 64, 6, { fill: plan.accent })
      const n = Math.max(1, items.length)
      const listY = H * 0.26
      const listH = H * 0.66
      const gapY = 16
      const rowH = Math.min(104, (listH - gapY * (n - 1)) / n)
      // dense lists: shrink the badge with the row so 5-6 entries never collide
      const badge = Math.max(30, Math.min(52, rowH - 14))
      const compact = rowH < 74
      for (let i = 0; i < n; i++) {
        const y = listY + i * (rowH + gapY)
        const item = items[i]
        await add('roundRect', M, y, W - 2 * M, rowH, { fill: plan.cardColor })
        await add('roundRect', M + 18, y + (rowH - badge) / 2, badge, badge, { fill: plan.accent })
        await add('textbox', M + 18, y + (rowH - badge) / 2 + (badge - 26 * PT_TO_PX) / 2, badge, 26 * PT_TO_PX, {
          paragraphs: text([[String(i + 1), compact ? 16 : 20, true, '#FFFFFF']], 'center'),
        })
        await add('textbox', M + 18 + badge + 22, y + (rowH - (compact ? 24 : 44)) / 2, W - 2 * M - badge - 60, (compact ? 24 : 26) * PT_TO_PX, {
          paragraphs: text([[item?.label ?? '', compact ? 16 : 18, true]]),
        })
        if (item?.sub && !compact) {
          await add('textbox', M + 18 + badge + 22, y + rowH / 2 + 4, W - 2 * M - badge - 60, 18 * PT_TO_PX, {
            paragraphs: text([[item.sub, 12, false]]),
          })
        }
      }
      break
    }
    case 'section_divider': {
      await add('rect', 0, 0, W, H, { fill: plan.background })
      await add('textbox', M, H * 0.16, W * 0.5, 110 * PT_TO_PX, {
        paragraphs: text([[plan.sectionNumber ?? '01', 96, true, tint(plan.accent, 0.35)]]),
      })
      await add('rect', M, H * 0.55, 110, 10, { fill: plan.accent })
      await add('textbox', M, H * 0.6, W - 2 * M, 40 * PT_TO_PX * 2, {
        paragraphs: text([[plan.title, 36, true]]),
      })
      if (plan.subtitle) {
        await add('textbox', M, H * 0.74, W - 2 * M, 22 * PT_TO_PX, {
          paragraphs: text([[plan.subtitle, 16, false]]),
        })
      }
      break
    }
    case 'closing_thank_you': {
      const barW = Math.min(360, W * 0.3)
      const cx = (W - barW) / 2
      await add('rect', cx, H * 0.3, barW, 8, { fill: plan.accent })
      await add('textbox', M, H * 0.38, W - 2 * M, 52 * PT_TO_PX, {
        paragraphs: text([[plan.title || '谢谢观看', 44, true]], 'center'),
      })
      if (plan.subtitle) {
        await add('textbox', M, H * 0.56, W - 2 * M, 24 * PT_TO_PX, {
          paragraphs: text([[plan.subtitle, 18, false]], 'center'),
        })
      }
      if (plan.footer) {
        await add('textbox', M, H - M - 16 * PT_TO_PX, W - 2 * M, 16 * PT_TO_PX, {
          paragraphs: text([[plan.footer, 12, false]], 'center'),
        })
      }
      break
    }
  }

  access.onPagesRebuilt?.([idx])
  return { ok: true }
}
