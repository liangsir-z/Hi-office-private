/**
 * TemplateStore — CRUD persistence for user templates, mirroring the
 * project-store pattern (atomic write, index.json + per-record file, no
 * Electron dependency).
 *
 * Storage layout (baseDir = userData/templates/<app>/):
 *   index.json          <- TemplateInfo[] (list fast, no payload reads)
 *   <id>.json           <- one TemplateRecord (full, with payload)
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TemplateApp, TemplateIndex, TemplateInfo, TemplateKind, TemplateRecord } from './types'

function nowIso(): string {
  return new Date().toISOString()
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

/** Atomic write: write to .tmp then rename, so an interruption can't leave half-written JSON */
function writeJson(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmpPath, filePath)
}

const NAME_MAX = 64
const NAME_RE = /.+/ // non-empty; further sanitization happens at the call site

function sanitizeName(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, NAME_MAX)
}

function makeId(name: string): string {
  return `tpl-${createHash('sha256').update(`${name}${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`
}

export class TemplateStore {
  private readonly templatesDir: string

  constructor(userDataPath: string) {
    this.templatesDir = join(userDataPath, 'templates')
  }

  private appDir(app: TemplateApp): string {
    return join(this.templatesDir, app)
  }

  private indexPath(app: TemplateApp): string {
    return join(this.appDir(app), 'index.json')
  }

  private recordPath(app: TemplateApp, id: string): string {
    return join(this.appDir(app), `${id}.json`)
  }

  private readIndex(app: TemplateApp): TemplateIndex {
    return readJson<TemplateIndex>(this.indexPath(app)) ?? { templates: [] }
  }

  private writeIndex(app: TemplateApp, index: TemplateIndex): void {
    writeJson(this.indexPath(app), index)
  }

  /** List all templates for an app (index only — no payload reads). */
  listTemplates(app: TemplateApp): TemplateInfo[] {
    return this.readIndex(app).templates
  }

  /** Get one full record (with payload). null if missing. */
  getTemplate(app: TemplateApp, id: string): TemplateRecord | null {
    return readJson<TemplateRecord>(this.recordPath(app, id))
  }

  /** Create a new template. Returns the id on success, an error message on failure. */
  createTemplate(
    app: TemplateApp,
    input: { name: string; kind: TemplateKind; payload: unknown },
  ): { ok: true; id: string } | { ok: false; error: string } {
    const name = sanitizeName(input.name)
    if (!NAME_RE.test(name)) {
      return { ok: false, error: 'name must not be empty' }
    }
    const id = makeId(name)
    const ts = nowIso()
    const record: TemplateRecord = {
      id,
      name,
      app,
      kind: input.kind,
      createdAt: ts,
      updatedAt: ts,
      payload: input.payload,
    }
    writeJson(this.recordPath(app, id), record)
    const index = this.readIndex(app)
    const info: TemplateInfo = { id, name, app, kind: input.kind, createdAt: ts, updatedAt: ts }
    index.templates.unshift(info)
    this.writeIndex(app, index)
    return { ok: true, id }
  }

  /** Rename a template. */
  renameTemplate(app: TemplateApp, id: string, newName: string): { ok: true } | { ok: false; error: string } {
    const name = sanitizeName(newName)
    if (!NAME_RE.test(name)) return { ok: false, error: 'name must not be empty' }
    const record = this.getTemplate(app, id)
    if (!record) return { ok: false, error: 'template not found' }
    record.name = name
    record.updatedAt = nowIso()
    writeJson(this.recordPath(app, id), record)
    const index = this.readIndex(app)
    const entry = index.templates.find((t) => t.id === id)
    if (entry) {
      entry.name = name
      entry.updatedAt = record.updatedAt
      this.writeIndex(app, index)
    }
    return { ok: true }
  }

  /** Delete a template (record file + index entry). */
  deleteTemplate(app: TemplateApp, id: string): { ok: true } | { ok: false; error: string } {
    const path = this.recordPath(app, id)
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        /* best-effort */
      }
    }
    const index = this.readIndex(app)
    const before = index.templates.length
    index.templates = index.templates.filter((t) => t.id !== id)
    if (index.templates.length !== before) this.writeIndex(app, index)
    return { ok: true }
  }
}
