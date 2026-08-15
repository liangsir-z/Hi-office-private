import { describe, it, expect } from 'vitest'
import {
  openPptx,
  createBlankPptx,
  applyThemeToArchive,
  readThemeFromArchive,
  savePptx,
  type ThemeSpec,
} from '../src/index'

describe('readThemeFromArchive', () => {
  it('reads the blank deck theme (Office scheme, Calibri/YaHei fonts)', async () => {
    const opened = await openPptx(await createBlankPptx())
    const theme = readThemeFromArchive(opened)
    expect(theme).not.toBeNull()
    expect(theme!.colors.dk1).toMatch(/^#[0-9A-F]{6}$/)
    expect(Object.keys(theme!.colors)).toEqual(
      expect.arrayContaining(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'hlink']),
    )
    expect(theme!.majorFont).toBe('Calibri Light')
    expect(theme!.minorFont).toBe('Calibri')
  })

  it('round-trips applyThemeToArchive → readThemeFromArchive', async () => {
    const opened = await openPptx(await createBlankPptx())
    const spec: ThemeSpec = {
      name: 'Teal Deck',
      colors: {
        dk1: '#1A1D24',
        lt1: '#FFFFFF',
        dk2: '#334155',
        lt2: '#F1F5F9',
        accent1: '#0F766E',
        accent2: '#14B8A6',
        accent3: '#F59E0B',
        accent4: '#2563EB',
        accent5: '#DB2777',
        accent6: '#65A30D',
        hlink: '#0F766E',
        folHlink: '#0E7490',
      },
      majorFont: 'Georgia',
      minorFont: 'Verdana',
    }
    applyThemeToArchive(opened, spec)
    const read = readThemeFromArchive(opened)
    expect(read).not.toBeNull()
    expect(read!.name).toBe('Teal Deck')
    for (const [k, v] of Object.entries(spec.colors)) {
      expect(read!.colors[k]).toBe(v.toUpperCase())
    }
    expect(read!.majorFont).toBe('Georgia')
    expect(read!.minorFont).toBe('Verdana')

    // survives a save/reopen round-trip
    const reopened = await openPptx(await savePptx(opened))
    const reread = readThemeFromArchive(reopened)
    expect(reread?.colors.accent1).toBe('#0F766E')
    expect(reread?.minorFont).toBe('Verdana')
  })
})
