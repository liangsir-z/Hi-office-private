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
  // [BYOK] Whole-page cloud regeneration was a Hi-office-only feature and is disabled
  // in this build; the tool returns a neutral "unavailable" error steering the model
  // toward in-place editing tools.
  it('returns a neutral unavailable error (cloud regeneration is disabled)', async () => {
    const skill = createSlidesSkill(mkAccess([page, page]))
    const r = await skill.executeTool!(
      call('regenerate_slide', { slideIndex: 1, brief: 'Redo as three-column cards' }),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('unavailable')
  })

  it('slideIndex out of range → errors', async () => {
    const skill = createSlidesSkill(mkAccess([page]))
    const r = await skill.executeTool!(call('regenerate_slide', { slideIndex: 3, brief: 'x' }))
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
