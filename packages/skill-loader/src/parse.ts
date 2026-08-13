/**
 * Parsing for user-supplied skills.
 *
 * A skill directory contains:
 *   SKILL.md   — required. YAML frontmatter (--- delimited) + Markdown body.
 *                The body becomes the skill's systemPrompt section.
 *   tools.json — optional. An array of tool definitions; each is an AgentToolDef
 *                optionally carrying an `ipc` field naming a window-API method to
 *                invoke for the declarative (no-handler) execution path.
 *
 * Frontmatter is a minimal hand-rolled YAML subset (`key: value` lines) so the
 * loader has zero dependencies. Only the flat scalar shape the skill format uses
 * is supported; nested mappings / block scalars are out of scope.
 */
import type { AgentToolDef } from '@genoffice/agent-core'

/** The app a skill applies to; `all` loads into every app. */
export type SkillAppScope = 'docs' | 'sheets' | 'slides' | 'all'

/** Parsed SKILL.md frontmatter (industry-standard fields + GenOffice extensions). */
export interface SkillFrontmatter {
  /** industry-standard: lowercase / digits / hyphens, ≤64 chars */
  name: string
  /** industry-standard: single-line description (what it does, when to use) */
  description: string
  /** industry-standard optional: extra trigger context presented to the model */
  whenToUse?: string
  /** industry-standard optional: license notice */
  license?: string
  /** GenOffice extension: which app(s) this skill loads into */
  app: SkillAppScope
  /** industry-standard optional */
  version?: string
}

/** Skill health grade (mirrors ZCode's two-tier load/trigger failure model). */
export type SkillHealth = 'ok' | 'weak' | 'error'

export interface ParsedSkillMd {
  frontmatter: SkillFrontmatter
  /** Markdown body (the system-prompt section for the LLM) */
  body: string
}

/** A tool entry in tools.json: AgentToolDef + optional `ipc` for declarative exec. */
export interface SkillToolDef extends AgentToolDef {
  /**
   * GenOffice extension: `"apiName.methodName"` (e.g. "slidesApi.addSlide"). When
   * present and no handler.js is provided, the executor calls
   * `window[apiName].methodName(call.input)` and wraps the result. Absent on
   * pure-prompt skills (no tools.json) or when a handler.js owns dispatch.
   */
  ipc?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const VALID_APPS = new Set<SkillAppScope>(['docs', 'sheets', 'slides', 'all'])

/**
 * Parse a minimal YAML frontmatter block (the subset the skill format uses:
 * flat `key: value` lines, single-line scalars). Returns a raw string map so
 * callers can validate typed fields with helpful errors.
 */
function parseFlatYaml(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue // skip malformed lines rather than throw
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    // strip inline quotes if present (single or double, fully wrapping)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

/**
 * Split a SKILL.md file into frontmatter + body. Frontmatter is the leading
 * `---\n...\n---` block; everything after is the Markdown body.
 */
export function splitFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (!match) return null
  return { yaml: match[1]!, body: match[2]! }
}

export class SkillParseError extends Error {
  constructor(skillName: string, message: string) {
    super(`skill "${skillName}": ${message}`)
    this.name = 'SkillParseError'
  }
}

/**
 * Parse a SKILL.md's full text into typed frontmatter + body. Throws
 * SkillParseError on missing/invalid required fields so callers can surface a
 * readable notice (and skip the broken skill) instead of crashing the agent.
 */
export function parseSkillMd(content: string, dirName: string): ParsedSkillMd {
  const split = splitFrontmatter(content)
  if (!split) {
    throw new SkillParseError(dirName, 'missing YAML frontmatter (--- ... ---)')
  }
  const raw = parseFlatYaml(split.yaml)
  const name = raw.name ?? ''
  if (!name) throw new SkillParseError(dirName, 'frontmatter: "name" is required')
  if (!NAME_RE.test(name)) {
    throw new SkillParseError(
      dirName,
      `frontmatter: "name" must be lowercase/digits/hyphens, ≤64 chars (got "${name}")`,
    )
  }
  const description = raw.description ?? ''
  if (!description) {
    throw new SkillParseError(dirName, 'frontmatter: "description" is required (single line)')
  }
  const appRaw = (raw.app ?? 'all').toLowerCase()
  if (!VALID_APPS.has(appRaw as SkillAppScope)) {
    throw new SkillParseError(
      dirName,
      `frontmatter: "app" must be docs|sheets|slides|all (got "${raw.app}")`,
    )
  }
  const frontmatter: SkillFrontmatter = {
    name,
    description,
    app: appRaw as SkillAppScope,
    ...(raw.when_to_use ? { whenToUse: raw.when_to_use } : {}),
    ...(raw.license ? { license: raw.license } : {}),
    ...(raw.version ? { version: raw.version } : {}),
  }
  return { frontmatter, body: split.body.trim() }
}

/**
 * Validate a parsed tools.json entry. Returns the typed def or throws a
 * SkillParseError naming the offending skill + tool.
 */
export function parseToolDef(raw: unknown, skillName: string, index: number): SkillToolDef {
  const obj = raw as Record<string, unknown>
  if (!obj || typeof obj !== 'object') {
    throw new SkillParseError(skillName, `tools.json[${index}]: not an object`)
  }
  const name = obj.name
  if (typeof name !== 'string' || !name) {
    throw new SkillParseError(skillName, `tools.json[${index}]: missing "name"`)
  }
  const description = obj.description
  if (typeof description !== 'string') {
    throw new SkillParseError(skillName, `tools.json[${index}] ("${name}"): missing "description"`)
  }
  const inputSchema = obj.inputSchema
  if (!inputSchema || typeof inputSchema !== 'object') {
    throw new SkillParseError(skillName, `tools.json[${index}] ("${name}"): missing "inputSchema"`)
  }
  const ipc = typeof obj.ipc === 'string' ? obj.ipc : undefined
  // ipc, if present, must look like "apiName.methodName"
  if (ipc && !/^[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*$/.test(ipc)) {
    throw new SkillParseError(
      skillName,
      `tools.json[${index}] ("${name}"): "ipc" must be "apiName.methodName" (got "${ipc}")`,
    )
  }
  return {
    name,
    description,
    inputSchema: inputSchema as Record<string, unknown>,
    ...(ipc ? { ipc } : {}),
  }
}

/** Parse a tools.json file's raw content into validated SkillToolDef[]. */
export function parseToolsJson(content: string, skillName: string): SkillToolDef[] {
  let arr: unknown
  try {
    arr = JSON.parse(content)
  } catch (e) {
    throw new SkillParseError(skillName, `tools.json: invalid JSON (${(e as Error).message})`)
  }
  if (!Array.isArray(arr)) {
    throw new SkillParseError(skillName, 'tools.json: root must be an array')
  }
  return arr.map((entry, i) => parseToolDef(entry, skillName, i))
}
