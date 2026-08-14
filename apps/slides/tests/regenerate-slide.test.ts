/** Skill-layer behavior of the regenerate_slide (redo one page in place) and delete_slide tools. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AgentToolCall } from '../src/shared/ipc'

const page = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

function mkAccess(
  slides: RenderSlide[],
  overrides: Partial<DeckAccess> = {},
): DeckAccess & { applyDeck: ReturnType<typeof vi.fn> } {
  const applyDeck = vi.fn()
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck,
    fitWidthPx: 1280,
    ...overrides,
  } as unknown as DeckAccess & { applyDeck: ReturnType<typeof vi.fn> }
}

const call = (name: string, input: Record<string, unknown>): AgentToolCall => ({
  id: 't',
  name,
  input,
})

beforeEach(() => {
  ;(window as any).slidesApi = { deleteSlide: vi.fn(async () => [page, page]) }
})

describe('regenerate_slide', () => {
  // Local template-based redesign replaced the removed cloud service: the tool
  // validates the structured plan and rebuilds the page with native elements.
  it('rejects an invalid plan with guidance', async () => {
    const skill = createSlidesSkill(mkAccess([page, page]))
    const r = await skill.executeTool!(
      call('regenerate_slide', { slideIndex: 1, plan: { variant: 'nope', title: 'x' } }),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Invalid plan')
  })

  it('rebuilds the page from a valid plan via native add ops', async () => {
    const addElement = vi.fn(async () => ({
      slide: page,
      sourceId: `e${Math.random()}`,
    }))
    const onPagesRebuilt = vi.fn()
    ;(window as any).slidesApi = {
      deleteSlide: vi.fn(async () => [page, page]),
      deleteElement: vi.fn(async () => page),
      addElement,
      insertImageUrl: vi.fn(async () => ({ slide: page, sourceId: 'img1' })),
    }
    const access = mkAccess([page, page], { onPagesRebuilt })
    const r = await createSlidesSkill(access).executeTool!(
      call('regenerate_slide', {
        slideIndex: 1,
        plan: {
          variant: 'three_column_cards',
          title: '季度复盘',
          accent: '#2563EB',
          background: '#FFFFFF',
          textColor: '#1F2937',
          cards: [
            { heading: '营收', body: '同比 +23%' },
            { heading: '留存', body: '月留存 87%' },
            { heading: 'NPS', body: '41 → 58' },
          ],
        },
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(true)
    expect(r.output).toContain('three_column_cards')
    // background + title + underline + 3× (card + strip + heading + body)
    expect(addElement.mock.calls.length).toBeGreaterThanOrEqual(13)
    expect(onPagesRebuilt).toHaveBeenCalledWith([1])
  })

  it('rebuilds the page from full-page HTML via the local converter', async () => {
    const htmlToNative = vi.fn(async () => ({ slide: page, imageFailures: 0 }))
    ;(window as any).slidesApi = {
      deleteSlide: vi.fn(async () => [page, page]),
      deleteElement: vi.fn(async () => page),
      addElement: vi.fn(async () => ({ slide: page, sourceId: 'e1' })),
      htmlToNative,
    }
    const onPagesRebuilt = vi.fn()
    const access = mkAccess([page, page], { onPagesRebuilt })
    const r = await createSlidesSkill(access).executeTool!(
      call('regenerate_slide', {
        slideIndex: 0,
        html: '<div class="slide"><h1>标题</h1></div>'.repeat(3),
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(true)
    expect(htmlToNative).toHaveBeenCalledWith(expect.objectContaining({ slideIndex: 0 }))
    expect(onPagesRebuilt).toHaveBeenCalledWith([0])
  })

  it('rejects short/missing html without calling the converter', async () => {
    const htmlToNative = vi.fn()
    ;(window as any).slidesApi = { htmlToNative }
    const r = await createSlidesSkill(mkAccess([page, page])).executeTool!(
      call('regenerate_slide', { slideIndex: 0, html: 'too short' }),
    )
    expect(htmlToNative).not.toHaveBeenCalled()
  })

  it('slideIndex out of range → errors', async () => {
    const skill = createSlidesSkill(mkAccess([page]))
    const r = await skill.executeTool!(
      call('regenerate_slide', { slideIndex: 3, plan: { variant: 'kpi_cards_row', title: 'x' } }),
    )
    expect(r.isError).toBe(true)
  })
})

describe('delete_slide', () => {
  it('deletes the given slide and writes back via applyDeck', async () => {
    const access = mkAccess([page, page, page])
    const r = await createSlidesSkill(access).executeTool!(call('delete_slide', { slideIndex: 2 }))
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(true)
    expect((window as any).slidesApi.deleteSlide).toHaveBeenCalledWith(2)
    expect(access.applyDeck).toHaveBeenCalledOnce()
    expect(r.output).toContain('has 2 pages')
  })

  it('only one slide left → refused', async () => {
    const r = await createSlidesSkill(mkAccess([page])).executeTool!(
      call('delete_slide', { slideIndex: 0 }),
    )
    expect(r.isError).toBe(true)
    expect((window as any).slidesApi.deleteSlide).not.toHaveBeenCalled()
  })

  it('out of range → errors', async () => {
    const r = await createSlidesSkill(mkAccess([page, page])).executeTool!(
      call('delete_slide', { slideIndex: 5 }),
    )
    expect(r.isError).toBe(true)
  })
})
