import { useState } from 'react'
import type { ThemeColors, ThemeFonts } from '@genoffice/docx-engine'
import { useI18n } from '../i18n/locale'
import type { StringKey } from '../i18n/locale'

/**
 * WPS-style "New Theme Fonts" / "New Theme Colors" editor dialog.
 *
 * mode='fonts': two font selects (heading + body) + a name; on apply calls
 *   onApply(fonts) where fonts also carries the chosen eastAsia when available.
 * mode='colors': 12 color inputs (the OOXML clrScheme slots) + a name; on apply
 *   calls onApply(colors).
 *
 * Reuses the existing `.modal-backdrop` / `.modal` classes; the color grid uses
 * a dedicated `.theme-edit-color-grid` class themed per-app.
 */
export function ThemeEditDialog({
  mode,
  initialFonts,
  initialColors,
  fontOptions,
  onApply,
  onClose,
}: {
  mode: 'fonts' | 'colors'
  initialFonts?: ThemeFonts | null
  initialColors?: ThemeColors | null
  /** font family options for the selects (mode='fonts') */
  fontOptions: string[]
  onApply: (value: ThemeFonts | ThemeColors) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(
    mode === 'fonts' ? (initialFonts?.major ?? '') : (initialColors?.name ?? ''),
  )
  const [fonts, setFonts] = useState<ThemeFonts>(
    initialFonts ?? { major: 'Calibri Light', minor: 'Calibri', eastAsia: '等线' },
  )
  const [colors, setColors] = useState<ThemeColors>(
    initialColors ?? {
      name: '',
      dk1: '000000',
      lt1: 'FFFFFF',
      dk2: '44546A',
      lt2: 'E7E6E6',
      accent1: '4472C4',
      accent2: 'ED7D31',
      accent3: 'A5A5A5',
      accent4: 'FFC000',
      accent5: '5B9BD5',
      accent6: '70AD47',
      hlink: '0563C1',
      folHlink: '954F72',
    },
  )

  const title = mode === 'fonts' ? t('ribbonNewThemeFonts' as StringKey) : t('ribbonNewThemeColors' as StringKey)

  const apply = () => {
    if (mode === 'fonts') {
      onApply({ ...fonts, ...(name.trim() ? {} : {}) })
    } else {
      onApply({ ...colors, name: name.trim() || t('appCustomTheme' as StringKey) })
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal theme-edit-modal">
        <h2>{title}</h2>

        {mode === 'fonts' ? (
          <>
            <label>
              {t('ribbonThemeFontsHeading' as StringKey)}
              <select value={fonts.major} onChange={(e) => setFonts((f) => ({ ...f, major: e.target.value }))}>
                {fontOptions.map((fn) => (
                  <option key={fn} value={fn}>
                    {fn}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('ribbonThemeFontsBody' as StringKey)}
              <select value={fonts.minor} onChange={(e) => setFonts((f) => ({ ...f, minor: e.target.value }))}>
                {fontOptions.map((fn) => (
                  <option key={fn} value={fn}>
                    {fn}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <div className="theme-edit-color-grid">
            {COLOR_SLOTS.map((slot) => (
              <label key={slot.key} className="theme-edit-color-cell">
                <span>{t(slot.labelKey)}</span>
                <input
                  type="color"
                  value={`#${(colors[slot.key as keyof ThemeColors] as string | undefined) ?? 'CCCCCC'}`}
                  onChange={(e) =>
                    setColors((c) => ({ ...c, [slot.key]: e.target.value.slice(1).toUpperCase() }))
                  }
                />
              </label>
            ))}
          </div>
        )}

        <label>
          {t('appThemeName' as StringKey)}
          <input
            type="text"
            value={name}
            placeholder={mode === 'fonts' ? t('ribbonThemeFontsNamePlaceholder' as StringKey) : t('ribbonThemeColorsNamePlaceholder' as StringKey)}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('appCancel')}
          </button>
          <button type="button" className="btn-primary" onClick={apply}>
            {t('appSave')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The 12 OOXML clrScheme slots shown in the color editor (label keys per slot). */
const COLOR_SLOTS: Array<{ key: string; labelKey: StringKey }> = [
  { key: 'dk1', labelKey: 'appColorDk1' },
  { key: 'lt1', labelKey: 'appColorLt1' },
  { key: 'dk2', labelKey: 'appColorDk2' },
  { key: 'lt2', labelKey: 'appColorLt2' },
  { key: 'accent1', labelKey: 'appColorAccent1' },
  { key: 'accent2', labelKey: 'appColorAccent2' },
  { key: 'accent3', labelKey: 'appColorAccent3' },
  { key: 'accent4', labelKey: 'appColorAccent4' },
  { key: 'accent5', labelKey: 'appColorAccent5' },
  { key: 'accent6', labelKey: 'appColorAccent6' },
  { key: 'hlink', labelKey: 'appColorHlink' },
  { key: 'folHlink', labelKey: 'appColorFolHlink' },
]
