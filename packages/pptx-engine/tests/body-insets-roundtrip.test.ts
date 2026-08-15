import { describe, it, expect } from 'vitest'
import { openPptx, savePptx, createBlankPptx, addElement } from '../src/index'

/**
 * The HTML→native converter writes textboxes with zero body insets +
 * anchor="ctr" (bodyInsets/bodyAnchor added to addElement). Regression guard:
 * such a textbox must survive the save→open roundtrip with its text intact —
 * a beautify run once produced slides with all shapes and no visible text.
 */
describe('textbox bodyInsets/bodyAnchor roundtrip', () => {
  it('keeps CJK text, insets, and anchor through save→open', async () => {
    const opened = await openPptx(await createBlankPptx())
    addElement(opened.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 914400, y: 914400, cx: 6096000, cy: 914400 },
      paragraphs: [
        {
          runs: [{ text: '季度业务复盘', bold: true, fontSize: 36, color: '#1A1D24' }],
          align: 'center',
        },
      ],
      bodyInsets: { l: 0, t: 0, r: 0, b: 0 },
      bodyAnchor: 'ctr',
    })

    const bytes = await savePptx(opened)

    const reopened = await openPptx(bytes)
    const el = reopened.deck.slides[0]!.elements[0]!
    expect(el.type).toBe('text')
    const text = (el as {
      text?: {
        paragraphs: Array<{ runs: Array<{ text: string }> }>
        anchor?: string
        insets?: { l: number; t: number; r: number; b: number }
      }
    }).text
    expect(text?.paragraphs[0]?.runs[0]?.text).toBe('季度业务复盘')
    expect(text?.anchor).toBe('middle')
    expect(text?.insets).toEqual({ l: 0, t: 0, r: 0, b: 0 })
  })

  it('plain addElement (no body options) still defaults correctly', async () => {
    const opened = await openPptx(await createBlankPptx())
    addElement(opened.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'plain' }] }],
    })
    const reopened = await openPptx(await savePptx(opened))
    const el = reopened.deck.slides[0]!.elements[0]!
    const xml = (el as { anchor?: { originalXml: string } }).anchor?.originalXml ?? ''
    expect(xml).not.toContain('lIns')
    expect(xml).toContain('plain')
  })
})
