/**
 * Main-process helpers for discovering user skills on disk.
 *
 * Lives in this package (not inline per app) so the scan logic is defined once.
 * Node-only: imports fs/path. Renderer code must not import this module — it
 * reaches the skills directory via the IPC handlers apps register using these.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMd, splitFrontmatter, SkillParseError } from './parse'
import type { SkillAppScope, SkillFrontmatter, SkillHealth } from './parse'
import type { SkillMeta } from './index'

/** Resolve the skills root directory for an app's userData path. */
export function skillsDir(userDataDir: string): string {
  return join(userDataDir, 'skills')
}

/** Skill file contents returned by `skill:read` for the renderer to parse+build. */
export interface SkillFiles {
  md: string
  tools?: string
}

/**
 * Scan ONE root directory for skills. Broken skills surface with
 * `health: 'error'` rather than being skipped (ZCode two-tier failure model).
 * Returns [] when the root does not exist.
 */
function scanRoot(root: string, origin: 'builtin' | 'user'): SkillMeta[] {
  if (!existsSync(root)) return []
  const out: SkillMeta[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const mdPath = join(dir, 'SKILL.md')
    if (!existsSync(mdPath)) continue
    const md = readFileSync(mdPath, 'utf-8')
    let fm: SkillFrontmatter
    let health: SkillHealth = 'ok'
    let healthMessage: string | undefined
    try {
      fm = parseSkillMd(md, entry).frontmatter
    } catch (e) {
      const msg = e instanceof SkillParseError ? e.message : (e as Error).message
      out.push({
        dir: entry,
        name: entry,
        description: '',
        app: 'all',
        hasTools: existsSync(join(dir, 'tools.json')),
        hasHandler: existsSync(join(dir, 'handler.js')),
        health: 'error',
        healthMessage: msg,
        origin,
      })
      continue
    }
    if (!fm.description) {
      health = 'weak'
      healthMessage = 'description is empty — the skill loads but the model has nothing to trigger on'
    } else if (fm.description.length > 1024) {
      health = 'weak'
      healthMessage = `description is ${fm.description.length} chars (over 1024) — the skill may be dropped`
    }
    out.push({
      dir: entry,
      name: fm.name,
      description: fm.description,
      app: fm.app,
      ...(fm.version ? { version: fm.version } : {}),
      ...(fm.whenToUse ? { whenToUse: fm.whenToUse } : {}),
      ...(fm.license ? { license: fm.license } : {}),
      hasTools: existsSync(join(dir, 'tools.json')),
      hasHandler: existsSync(join(dir, 'handler.js')),
      health,
      ...(healthMessage ? { healthMessage } : {}),
      origin,
    })
  }
  return out
}

/**
 * List all skills: bundled (read-only, shipped with the app) + user (writable).
 * User-root skills override same-named bundled ones (user wins on `dir` key).
 * Pass `bundledRoot` to enable the builtin tier; omit it for user-only scanning.
 */
export function listSkills(userDataDir: string, bundledRoot?: string): SkillMeta[] {
  const merged = new Map<string, SkillMeta>()
  // bundled first, then user overwrites on name collision (user precedence)
  if (bundledRoot) for (const m of scanRoot(bundledRoot, 'builtin')) merged.set(m.dir, m)
  for (const m of scanRoot(skillsDir(userDataDir), 'user')) merged.set(m.dir, m)
  return [...merged.values()]
}

/**
 * Resolve the user-override path for one skill: user root first, then bundled.
 * Returns the absolute skill directory, or null when it exists in neither root.
 */
function resolveSkillDir(userDataDir: string, bundledRoot: string | undefined, dir: string): string | null {
  const userDir = join(skillsDir(userDataDir), dir)
  if (existsSync(join(userDir, 'SKILL.md'))) return userDir
  if (bundledRoot) {
    const bDir = join(bundledRoot, dir)
    if (existsSync(join(bDir, 'SKILL.md'))) return bDir
  }
  return null
}

/**
 * Read one skill's raw files for the renderer to parse+build. Returns null when
 * the skill dir or SKILL.md is missing. tools.json is included only when present.
 */
export function readSkill(userDataDir: string, dir: string, bundledRoot?: string): SkillFiles | null {
  const skillDir = resolveSkillDir(userDataDir, bundledRoot, dir)
  if (!skillDir) return null
  const mdPath = join(skillDir, 'SKILL.md')
  const files: SkillFiles = { md: readFileSync(mdPath, 'utf-8') }
  const toolsPath = join(skillDir, 'tools.json')
  if (existsSync(toolsPath)) files.tools = readFileSync(toolsPath, 'utf-8')
  return files
}

const CREATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Result of createSkill: the new directory name on success, an error message on failure. */
export type CreateSkillResult = { ok: true; dir: string } | { ok: false; error: string }

/**
 * Create a new skill directory + SKILL.md from a wizard form. Validates the name
 * (lowercase kebab-case, 1–64 chars, matches the directory), refuses to overwrite
 * an existing skill, and writes a minimal valid SKILL.md. Returns the dir name.
 */
export function createSkill(
  userDataDir: string,
  input: { name: string; description: string; app?: SkillAppScope; body?: string },
): CreateSkillResult {
  const name = input.name.trim()
  if (!CREATE_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        'name must be lowercase letters, digits, or hyphens (1–64 chars), e.g. "weekly-report-writer"',
    }
  }
  const skillDir = join(skillsDir(userDataDir), name)
  if (existsSync(skillDir)) {
    return { ok: false, error: `a skill named "${name}" already exists` }
  }
  const description = input.description.trim()
  if (!description) {
    return { ok: false, error: 'description must not be empty' }
  }
  if (description.length > 1024) {
    return { ok: false, error: 'description must be 1024 characters or fewer' }
  }
  const app = input.app ?? 'all'
  const body = (input.body ?? '').trim()
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `app: ${app}`,
    '---',
    '',
  ].join('\n')
  const md = body ? `${frontmatter}${body}\n` : `${frontmatter}(Write your skill instructions here.)\n`
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), md, 'utf-8')
  return { ok: true, dir: name }
}

/** Type re-export for app main modules (app scope filter helper). */
export function matchesApp(meta: SkillMeta, app: SkillAppScope): boolean {
  return meta.app === 'all' || meta.app === app
}

// re-export splitFrontmatter so apps that want a one-shot parse path can get it
// without importing from './parse' directly
export { splitFrontmatter, SkillParseError }

/**
 * Minimal ipcMain surface this module needs (avoids a hard electron dependency).
 * Electron's IpcMain satisfies this structurally.
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * Minimal shell surface for "open folder" (avoids a hard electron dependency).
 * Electron's Shell satisfies this structurally (openPath returns Promise<string>).
 */
export interface ShellLike {
  openPath(path: string): Promise<string>
}

/**
 * Register the skill IPC handlers on the given ipcMain. Each app calls this once
 * alongside its `registerAiIpc`. Channels:
 *   skill:list     → SkillMeta[]        (scan userData/skills/, skip broken ones)
 *   skill:read     → SkillFiles | null  (raw SKILL.md + optional tools.json)
 *   skill:dir      → string             (absolute skills dir path)
 *   skill:open-dir → void               (open the skills folder in the OS file manager)
 */
export function registerSkillIpc(
  ipcMain: IpcMainLike,
  userDataDir: string,
  shell?: ShellLike,
  bundledRoot?: string,
): void {
  ipcMain.handle('skill:list', () => listSkills(userDataDir, bundledRoot))
  ipcMain.handle('skill:read', (_e, dir: unknown) =>
    typeof dir === 'string' ? readSkill(userDataDir, dir, bundledRoot) : null,
  )
  ipcMain.handle('skill:dir', () => skillsDir(userDataDir))
  if (shell) {
    ipcMain.handle('skill:open-dir', async () => {
      const dir = skillsDir(userDataDir)
      // ensure the folder exists so the OS file manager opens something sensible
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* ignore */
      }
      await shell.openPath(dir)
    })
  }
  ipcMain.handle('skill:create', (_e, input: unknown) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid input' }
    const i = input as { name?: unknown; description?: unknown; app?: unknown; body?: unknown }
    return createSkill(userDataDir, {
      name: typeof i.name === 'string' ? i.name : '',
      description: typeof i.description === 'string' ? i.description : '',
      ...(typeof i.app === 'string' ? { app: i.app as SkillAppScope } : {}),
      ...(typeof i.body === 'string' ? { body: i.body } : {}),
    })
  })
}

