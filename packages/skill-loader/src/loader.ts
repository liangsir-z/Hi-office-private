/**
 * Renderer-side loader: discover skills via IPC, parse, and build AgentSkill[].
 *
 * Each app calls `loadUserSkills({ app, api, listSkills, readSkill })` once at
 * startup; the returned AgentSkill[] is spread into the app's composeSkills(...)
 * array. Broken skills are skipped with a console warning.
 */
import type { AgentSkill } from '@genoffice/agent-core'
import { buildAgentSkill } from './build'
import { parseSkillMd, parseToolsJson, SkillParseError } from './parse'
import type { SkillApi } from './build'
import type { SkillAppScope, SkillToolDef } from './parse'
import type { SkillFiles, SkillMeta } from './index'

/** The IPC bridge a host app injects (its window.* skill methods). */
export interface SkillIpcBridge {
  listSkills(): Promise<SkillMeta[]>
  readSkill(dir: string): Promise<SkillFiles | null>
}

export interface LoadUserSkillsOptions {
  /** which app is loading (filters skills by frontmatter `app`) */
  app: SkillAppScope
  /** window-API surface passed to declarative tool executors */
  api: SkillApi
  /** IPC bridge to the main-process skill handlers */
  bridge: SkillIpcBridge
  /**
   * Optional per-skill enable gate (keyed by skill dir name). Returns true when
   * the skill should load. Default: always enabled (absence in the settings map
   * means enabled, so freshly-dropped skills work without a settings round-trip).
   */
  isEnabled?: (dir: string) => boolean
}

/**
 * Load all user skills applicable to `app`, parsed and built into AgentSkill[].
 * Never throws — a single broken skill is logged and skipped so agent startup
 * is unaffected. Returns [] when the skills directory is empty/missing.
 */
export async function loadUserSkills({
  app,
  api,
  bridge,
  isEnabled,
}: LoadUserSkillsOptions): Promise<AgentSkill[]> {
  let metas: SkillMeta[]
  try {
    metas = await bridge.listSkills()
  } catch (e) {
    console.warn('[skill-loader] skillList failed:', e)
    return []
  }
  const out: AgentSkill[] = []
  for (const meta of metas) {
    // filter by app scope: 'all' loads everywhere; otherwise must match
    if (meta.app !== 'all' && meta.app !== app) continue
    // filter by per-skill enable flag (absence = enabled)
    if (isEnabled && !isEnabled(meta.dir)) continue
    try {
      const files = await bridge.readSkill(meta.dir)
      if (!files) {
        console.warn(`[skill-loader] skill "${meta.dir}": SKILL.md not readable`)
        continue
      }
      const md = parseSkillMd(files.md, meta.dir)
      let tools: SkillToolDef[] = []
      if (files.tools) tools = parseToolsJson(files.tools, meta.dir)
      out.push(buildAgentSkill({ md, tools, dir: meta.dir, api }))
    } catch (e) {
      const msg = e instanceof SkillParseError ? e.message : String(e)
      console.warn(`[skill-loader] skipping skill "${meta.dir}": ${msg}`)
    }
  }
  return out
}
