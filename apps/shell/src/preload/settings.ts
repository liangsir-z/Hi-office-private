import { contextBridge, ipcRenderer } from 'electron'
import type { AiSettings } from '@genoffice/ai-provider'

/**
 * Bridge for the global settings window. The data channels are the app-wide
 * ones registered by the shell (ai:get/set-settings via docs-main's
 * registerAiIpc, home:get/set-language, skill:open-dir) — this preload only
 * forwards them with typed wrappers.
 */

const LANGS = [
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'th',
  'id',
  'ru',
  'ar',
  'pt',
  'it',
  'pl',
  'nl',
  'ms',
  'he',
  'hi',
  'zh-TW',
] as const

export interface SettingsWindowApi {
  getAiSettings(): Promise<AiSettings>
  setAiSettings(next: AiSettings): Promise<void>
  getLanguage(): Promise<(typeof LANGS)[number]>
  setLanguage(lang: (typeof LANGS)[number]): Promise<void>
  openSkillsDir(): Promise<void>
}

const api: SettingsWindowApi = {
  async getAiSettings() {
    return (await ipcRenderer.invoke('ai:get-settings')) as AiSettings
  },
  async setAiSettings(next) {
    await ipcRenderer.invoke('ai:set-settings', next)
  },
  async getLanguage() {
    const lang = (await ipcRenderer.invoke('home:get-language')) as string
    return (LANGS as readonly string[]).includes(lang) ? (lang as (typeof LANGS)[number]) : 'zh'
  },
  async setLanguage(lang) {
    await ipcRenderer.invoke('home:set-language', lang)
  },
  async openSkillsDir() {
    await ipcRenderer.invoke('skill:open-dir')
  },
}

contextBridge.exposeInMainWorld('aiOfficeSettings', api)
