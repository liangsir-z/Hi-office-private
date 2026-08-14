import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * The global settings window: AI provider/model configuration (shared by every
 * app), interface language, and the skills folder shortcut. Content lives in
 * renderer/settings.html; modeled on update-window.ts (module singleton,
 * focused instead of closed when re-opened). All data channels
 * (ai:get/set-settings, home:get/set-language, skill:open-dir) are registered
 * globally elsewhere, so this module only owns the window lifecycle.
 */

let settingsWin: BrowserWindow | null = null

export function showSettingsWindow(parent?: BrowserWindow | null): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }

  const win = new BrowserWindow({
    width: 640,
    height: 620,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    title: 'Hi-office',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settingsWin = win

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    settingsWin = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }
}
