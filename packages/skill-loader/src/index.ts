/**
 * @genoffice/skill-loader — discovers and parses user-supplied agent skills.
 *
 * Two-layer design:
 *   - main process: scans the skills directory, returns metadata + raw file
 *     contents over IPC (filesystem access stays in main).
 *   - renderer: calls parse + build to turn raw contents into AgentSkill
 *     objects, injected into composeSkills(...).
 *
 * This package owns the renderer-side parsing/building (no fs/node deps); the
 * main-process scanning helpers live inline in each app's main (they share the
 * metadata types exported here).
 */
export type { SkillAppScope, SkillFrontmatter, ParsedSkillMd, SkillToolDef, SkillHealth } from './parse'
export { parseSkillMd, parseToolsJson, splitFrontmatter, SkillParseError } from './parse'
export type { SkillApi, BuildAgentSkillOptions } from './build'
export { buildAgentSkill } from './build'
export type { SkillIpcBridge, LoadUserSkillsOptions } from './loader'
export { loadUserSkills } from './loader'

/** Raw file contents of one skill (returned by the `skill:read` IPC). */
export type { SkillFiles, CreateSkillResult } from './main'

/** Input for the `skill:create` IPC (the new-skill wizard payload). */
export interface CreateSkillInput {
  name: string
  description: string
  app?: import('./parse').SkillAppScope
  body?: string
}

/**
 * Metadata for one discovered skill (returned by the main-process `skill:list`
 * IPC). Kept minimal so the renderer can decide what to load; full contents come
 * via `skill:read`.
 */
export interface SkillMeta {
  /** directory name under userData/skills/ (the skill id) */
  dir: string
  name: string
  description: string
  app: import('./parse').SkillAppScope
  version?: string
  whenToUse?: string
  license?: string
  /** a tools.json is present (declarative tools will be loaded) */
  hasTools: boolean
  /** a handler.js is present (imperative exec, stage C — not yet supported) */
  hasHandler: boolean
  /** health grade: ok = loads & triggers; weak = loads but description may be too weak/long; error = won't load (parse failure) */
  health: import('./parse').SkillHealth
  /** human-readable health detail (the parse error message, or a weak-description note) */
  healthMessage?: string
  /** where the skill was discovered: 'builtin' (read-only, shipped with app) or 'user' (writable) */
  origin: 'builtin' | 'user'
}
