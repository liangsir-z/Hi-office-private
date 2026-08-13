/**
 * Template store types.
 *
 * A template is a named, reusable visual-style record extracted from the
 * current document/sheet/deck. The envelope is uniform across apps; the
 * `payload` is app/kind-specific (typed loosely as unknown here so this package
 * stays free of engine dependencies — each app casts on extract/apply).
 */

/** Which app a template belongs to. */
export type TemplateApp = 'docs' | 'sheets' | 'slides'

/**
 * Template kind discriminator. Apps define their own kinds; the store treats
 * `payload` as opaque JSON. Known kinds today:
 *   - docs   'theme'        → { fonts: ThemeFonts; colors: ThemeColors }
 *   - sheets 'cell-style'   → { patches: CellFormatPatch[] }
 *   - slides 'theme'        → { colors: Record<string,string>; majorFont?; minorFont? }
 */
export type TemplateKind = string

/** The index entry (list view, no payload — fast scan). */
export interface TemplateInfo {
  id: string
  name: string
  app: TemplateApp
  kind: TemplateKind
  createdAt: string
  updatedAt: string
}

/** The full record (with payload). Returned by get; stored on disk. */
export interface TemplateRecord extends TemplateInfo {
  /** app/kind-specific payload; the store never inspects it */
  payload: unknown
}

export interface TemplateIndex {
  templates: TemplateInfo[]
}
