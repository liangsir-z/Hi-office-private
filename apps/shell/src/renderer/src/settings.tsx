import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiSettings } from '@genoffice/ai-provider'
import { ModelSettingsPanel } from '@genoffice/ui'
import { createI18n, htmlLang, type Lang } from '@genoffice/i18n'
import { strings } from './strings'
import './settings.css'

/**
 * Global settings page (shell settings window): the app-wide AI model
 * configuration (provider / key / model / image generation), interface
 * language, and the skills-folder shortcut. Skills/templates management
 * stays inside each editor's own dialog.
 */

interface SettingsWindowApi {
  getAiSettings(): Promise<AiSettings>
  setAiSettings(next: AiSettings): Promise<void>
  getLanguage(): Promise<Lang>
  setLanguage(lang: Lang): Promise<void>
  openSkillsDir(): Promise<void>
}

declare global {
  interface Window {
    aiOfficeSettings: SettingsWindowApi
  }
}

const translate = createI18n(strings)

const LANG_LABELS: Record<Lang, string> = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  ru: 'Русский',
  ar: 'العربية',
  pt: 'Português',
  it: 'Italiano',
  pl: 'Polski',
  nl: 'Nederlands',
  ms: 'Bahasa Melayu',
  he: 'עברית',
  hi: 'हिन्दी',
  'zh-TW': '繁體中文',
}

function App() {
  const [lang, setLang] = useState<Lang>('zh')
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.aiOfficeSettings.getLanguage().then((l) => {
      setLang(l)
      document.documentElement.lang = htmlLang(l)
    })
    void window.aiOfficeSettings.getAiSettings().then((s) => setSettings(s))
  }, [])

  const t = useMemo(
    () =>
      (key: keyof typeof strings.zh, params?: Record<string, string | number>) =>
        translate(lang, key, params),
    [lang],
  )

  const changeLang = (next: Lang) => {
    setLang(next)
    document.documentElement.lang = htmlLang(next)
    void window.aiOfficeSettings.setLanguage(next)
  }

  const save = async () => {
    if (!settings) return
    await window.aiOfficeSettings.setAiSettings(settings)
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-page">
      <h1>{t('navSettings')}</h1>

      <section className="settings-card">
        <h2>{t('settingsModelSection')}</h2>
        {settings ? (
          <ModelSettingsPanel
            draft={settings}
            setDraft={(action) => {
              setSettings((prev) =>
                prev
                  ? typeof action === 'function'
                    ? (action as (p: AiSettings) => AiSettings)(prev)
                    : action
                  : prev,
              )
              setDirty(true)
            }}
            t={(key, params) => t(key as keyof typeof strings.zh, params)}
          />
        ) : (
          <p className="settings-muted">…</p>
        )}
        <div className="settings-save-row">
          <button type="button" className="settings-save" disabled={!dirty} onClick={() => void save()}>
            {t('settingsSave')}
          </button>
          {saved && <span className="settings-saved">{t('settingsSaved')}</span>}
        </div>
      </section>

      <section className="settings-card">
        <h2>{t('settingsLang')}</h2>
        <select value={lang} onChange={(e) => changeLang(e.target.value as Lang)}>
          {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
            <option key={l} value={l}>
              {LANG_LABELS[l]}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-card">
        <h2>{t('settingsSkills')}</h2>
        <button
          type="button"
          className="settings-secondary"
          onClick={() => void window.aiOfficeSettings.openSkillsDir()}
        >
          {t('settingsOpenSkillsDir')}
        </button>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
