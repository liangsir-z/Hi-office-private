/**
 * IPC registration helper for the template store. Each app calls
 * `registerTemplateIpc(ipcMain, userDataDir)` once alongside its other IPC setup.
 *
 * Channels (all scoped by app — the app field in each request selects the dir):
 *   template:list    → TemplateInfo[]               (list an app's templates)
 *   template:get     → TemplateRecord | null        (full record incl. payload)
 *   template:create  → { ok, id } | { ok:false, error }
 *   template:rename  → { ok:true } | { ok:false, error }
 *   template:delete  → { ok:true } | { ok:false, error }
 */
import { TemplateStore } from './store'
import type { TemplateApp, TemplateKind } from './types'

/** Minimal ipcMain surface (avoids a hard electron dependency). */
export interface TemplateIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/** One-shot per-process store cache (instantiated lazily on first IPC call). */
export function registerTemplateIpc(ipcMain: TemplateIpcMainLike, userDataDir: string): void {
  let store: TemplateStore | null = null
  const getStore = (): TemplateStore => (store ??= new TemplateStore(userDataDir))

  ipcMain.handle('template:list', (_e, app: unknown) =>
    app === 'docs' || app === 'sheets' || app === 'slides'
      ? getStore().listTemplates(app as TemplateApp)
      : [],
  )

  ipcMain.handle('template:get', (_e, app: unknown, id: unknown) =>
    typeof app === 'string' && typeof id === 'string'
      ? getStore().getTemplate(app as TemplateApp, id)
      : null,
  )

  ipcMain.handle(
    'template:create',
    (_e, app: unknown, input: unknown) => {
      if (!input || typeof input !== 'object') return { ok: false, error: 'invalid input' }
      const i = input as { name?: unknown; kind?: unknown; payload?: unknown }
      if (typeof i.name !== 'string' || typeof i.kind !== 'string') {
        return { ok: false, error: 'name and kind are required' }
      }
      return getStore().createTemplate(app as TemplateApp, {
        name: i.name,
        kind: i.kind as TemplateKind,
        payload: i.payload,
      })
    },
  )

  ipcMain.handle(
    'template:rename',
    (_e, app: unknown, id: unknown, name: unknown) =>
      typeof app === 'string' && typeof id === 'string' && typeof name === 'string'
        ? getStore().renameTemplate(app as TemplateApp, id, name)
        : { ok: false, error: 'invalid args' },
  )

  ipcMain.handle(
    'template:delete',
    (_e, app: unknown, id: unknown) =>
      typeof app === 'string' && typeof id === 'string'
        ? getStore().deleteTemplate(app as TemplateApp, id)
        : { ok: false, error: 'invalid args' },
  )
}
