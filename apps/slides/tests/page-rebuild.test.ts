import { describe, expect, it } from 'vitest'
import { PAGE_PLAN_VARIANTS, parsePagePlan } from '../src/renderer/ai/page-rebuild'

describe('parsePagePlan', () => {
  it('accepts a valid plan and normalizes optional fields', () => {
    const r = parsePagePlan({
      variant: 'three_column_cards',
      title: '季度复盘',
      accent: '#2563EB',
      background: '#FFFFFF',
      textColor: '#1F2937',
      cards: [
        { heading: '营收', body: '同比增长 23%' },
        { heading: '留存', body: '月留存 87%' },
        { heading: 'NPS', body: '从 41 升到 58' },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.cards).toHaveLength(3)
      expect(r.plan.accent).toBe('#2563EB')
      expect(r.plan.subtitle).toBeUndefined()
    }
  })

  it('rejects unknown variants', () => {
    const r = parsePagePlan({ variant: 'fancy_new_layout', title: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/variant must be one of/)
  })

  it('rejects a missing title', () => {
    const r = parsePagePlan({ variant: 'hero_big_number', title: '  ' })
    expect(r.ok).toBe(false)
  })

  it('falls back to default palette colors for invalid hex', () => {
    const r = parsePagePlan({ variant: 'kpi_cards_row', title: 't', accent: 'blue', background: 42 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.accent).toBe('#2563EB')
      expect(r.plan.background).toBe('#FFFFFF')
    }
  })

  it('clamps cards/bullets/kpis and keeps only http(s) image urls', () => {
    const r = parsePagePlan({
      variant: 'left_text_right_image',
      title: 't',
      bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      cards: Array.from({ length: 9 }, (_, i) => ({ heading: `h${i}`, body: 'b' })),
      kpis: [{ value: '1', label: 'l' }, { value: '', label: 'dropped' }],
      imageUrl: 'javascript:alert(1)',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.bullets).toHaveLength(7)
      expect(r.plan.cards).toHaveLength(4)
      expect(r.plan.kpis).toHaveLength(1)
      expect(r.plan.imageUrl).toBeUndefined()
    }
  })

  it('parses items and sectionNumber for the structural variants', () => {
    const r = parsePagePlan({
      variant: 'table_of_contents',
      title: '目录',
      items: [{ label: '背景介绍' }, { label: '方案详情', sub: '含部署架构' }, {}, { label: 'x' }, { label: 'y' }, { label: 'z' }, { label: 'w' }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.items).toHaveLength(6) // capped, empty dropped
    const d = parsePagePlan({ variant: 'section_divider', title: 't', sectionNumber: '02' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.plan.sectionNumber).toBe('02')
  })

  it('lists the variant catalog the renderer actually implements', () => {
    expect(PAGE_PLAN_VARIANTS).toContain('cover_typography_hero')
    expect(PAGE_PLAN_VARIANTS).toContain('kpi_cards_row')
    expect(PAGE_PLAN_VARIANTS).toContain('table_of_contents')
    expect(PAGE_PLAN_VARIANTS).toContain('section_divider')
    expect(PAGE_PLAN_VARIANTS).toContain('closing_thank_you')
    expect(PAGE_PLAN_VARIANTS).toHaveLength(10)
  })
})
