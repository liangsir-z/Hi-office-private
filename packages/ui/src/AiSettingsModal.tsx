import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AI_PROVIDERS,
  type AiProviderId,
  type AiSettings,
  type ImageGenConfig,
  type ImageGenProvider,
} from '@genoffice/ai-provider'

/**
 * Translation function injected by the host app (each app owns its own i18n).
 * Loosely typed (string key) so the modal stays decoupled; host apps pass their
 * own t (cast at the call site if their key type is a narrower string union).
 */
export type AiSettingsT = (key: string, params?: Record<string, string | number>) => string

export interface AiSettingsModalProps {
  settings: AiSettings
  /** commit the draft; the host app persists via its window API and updates state */
  onSave: (next: AiSettings) => void
  onClose: () => void
  t: AiSettingsT
  /** discovered user skills to list in the Skills section (empty/undefined hides it) */
  skills?: SkillListItem[]
  /** open the skills folder in the OS file manager */
  onOpenSkillsDir?: () => void
  /** create a new skill from the wizard; host app calls skillCreate IPC + refreshes list */
  onCreateSkill?: (input: {
    name: string
    description: string
    app?: string
    body?: string
  }) => Promise<{ ok: boolean; error?: string; dir?: string }>
  /** full SKILL.md text for the detail view, keyed by dir; lazy-loaded on expand */
  skillBodies?: Record<string, string>
  /** fetch a skill's full body on demand (host reads via skill:read) */
  onReadSkillBody?: (dir: string) => Promise<string | null>
  /** [templates] saved templates to list (info only; payload fetched on apply) */
  templates?: TemplateListItem[]
  /** [templates] extract the current doc/sheet/deck style into a payload, then save */
  onExtractTemplate?: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** [templates] apply a template's payload to the current doc/sheet/deck */
  onApplyTemplate?: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** [templates] rename / delete */
  onRenameTemplate?: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>
  onDeleteTemplate?: (id: string) => Promise<{ ok: boolean; error?: string }>
}

/** Lightweight template metadata for the list (decoupled from template-store's TemplateInfo). */
export interface TemplateListItem {
  id: string
  name: string
  kind: string
  updatedAt: string
}

/** Lightweight skill metadata for the list (decoupled from skill-loader's SkillMeta). */
export interface SkillListItem {
  dir: string
  name: string
  description: string
  app: string
  version?: string
  whenToUse?: string
  license?: string
  hasTools?: boolean
  hasHandler?: boolean
  health?: 'ok' | 'weak' | 'error'
  healthMessage?: string
  origin?: 'builtin' | 'user'
}

const IMAGE_GEN_PROVIDERS: Array<{ id: ImageGenProvider | 'none'; label: string }> = [
  { id: 'none', label: 'None (disabled)' },
  { id: 'aliyun-wanx', label: 'Aliyun Wanx (通义万相)' },
  { id: 'volcengine-jimeng', label: 'Volcengine Jimeng (即梦)' },
  { id: 'custom', label: 'Custom' },
]

/**
 * AI configuration dialog shared by docs / sheets / slides. Edits an AiSettings
 * draft (LLM provider + image-generation backend) and commits on save. Renders
 * the existing `.modal` / `.provider-tabs` class families; styling lives per app.
 * Self-contained: injects `t` and `onSave` so it stays free of any app's i18n or
 * window-API surface.
 */
export function AiSettingsModal({
  settings,
  onSave,
  onClose,
  t,
  skills,
  onOpenSkillsDir,
  onCreateSkill,
  onReadSkillBody,
  templates,
  onExtractTemplate,
  onApplyTemplate,
  onRenameTemplate,
  onDeleteTemplate,
}: AiSettingsModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<AiSettings>(() => structuredClone(settings))
  const [tab, setTab] = useState<'model' | 'skills' | 'templates'>('model')
  // skills panel: search, detail expand, create wizard
  const [skillQuery, setSkillQuery] = useState('')
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [skillBody, setSkillBody] = useState<Record<string, string>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', description: '', app: 'all', body: '' })
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // templates panel: extract form + busy/error state
  const [tplName, setTplName] = useState('')
  const [tplError, setTplError] = useState<string | null>(null)
  const [tplBusy, setTplBusy] = useState(false)

  // focus first control on mount (mirrors the per-app useModalKeys hook without
  // cross-package importing it)
  useEffect(() => {
    const el = backdropRef.current
    if (!el || el.contains(document.activeElement)) return
    const first = el.querySelector<HTMLElement>('input, textarea, select, button')
    ;(first ?? el).focus()
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }

  const provider = draft.provider
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)
  const providerCfg = draft.providers[provider]
  const img = draft.imageGen ?? { provider: 'none' as const, apiKey: '' }

  const setProvider = (id: AiProviderId) => setDraft((d) => ({ ...d, provider: id }))

  const setProviderCfg = (patch: Partial<typeof providerCfg>) =>
    setDraft((d) => ({ ...d, providers: { ...d.providers, [provider]: { ...d.providers[provider], ...patch } } }))

  const setImageGen = (patch: Partial<ImageGenConfig>) =>
    setDraft((d) => ({ ...d, imageGen: { ...(d.imageGen ?? { provider: 'none', apiKey: '' }), ...patch } }))

  /** toggle one skill's enable flag (absence = enabled; explicit false = disabled) */
  const setSkillEnabled = (dir: string, enabled: boolean) =>
    setDraft((d) => ({ ...d, skills: { ...(d.skills ?? {}), [dir]: enabled } }))
  const isSkillEnabled = (dir: string) => draft.skills?.[dir] !== false

  /** toggle a skill row's detail panel; lazily fetch its full body on first expand */
  const toggleSkillDetail = async (dir: string) => {
    if (expandedSkill === dir) {
      setExpandedSkill(null)
      return
    }
    setExpandedSkill(dir)
    if (skillBody[dir] === undefined && onReadSkillBody) {
      const body = await onReadSkillBody(dir)
      setSkillBody((m) => ({ ...m, [dir]: body ?? '' }))
    }
  }

  /** filtered skill list by the search box (name + description, case-insensitive) */
  const filteredSkills = (() => {
    if (!skills) return []
    const q = skillQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    )
  })()

  const submitCreate = async () => {
    if (!onCreateSkill) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await onCreateSkill({
        name: createForm.name,
        description: createForm.description,
        app: createForm.app,
        body: createForm.body,
      })
      if (!res.ok) {
        setCreateError(res.error ?? 'creation failed')
      } else {
        // reset form; the host app refreshes the skills list
        setShowCreate(false)
        setCreateForm({ name: '', description: '', app: 'all', body: '' })
      }
    } finally {
      setCreating(false)
    }
  }

  /** extract the current style into a new named template */
  const submitExtract = async () => {
    if (!onExtractTemplate) return
    const name = tplName.trim()
    if (!name) return
    setTplBusy(true)
    setTplError(null)
    try {
      const res = await onExtractTemplate(name)
      if (!res.ok) setTplError(res.error ?? 'extract failed')
      else setTplName('')
    } finally {
      setTplBusy(false)
    }
  }

  const save = () => {
    onSave(draft)
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal ai-settings-modal">
        <h2>{t('appAiSettings')}</h2>

        <div className="settings-shell">
          {/* ── Left nav ── */}
          <nav className="settings-nav">
            <button
              type="button"
              className={`settings-nav-item${tab === 'model' ? ' active' : ''}`}
              onClick={() => setTab('model')}
            >
              {t('appSettingsTabModel')}
            </button>
            <button
              type="button"
              className={`settings-nav-item${tab === 'skills' ? ' active' : ''}`}
              onClick={() => setTab('skills')}
            >
              {t('appSettingsTabSkills')}
            </button>
            {onExtractTemplate && (
              <button
                type="button"
                className={`settings-nav-item${tab === 'templates' ? ' active' : ''}`}
                onClick={() => setTab('templates')}
              >
                {t('appSettingsTabTemplates')}
              </button>
            )}
          </nav>

          {/* ── Right panel ── */}
          <div className="settings-panel">
        {tab === 'model' ? (
          <>
            {/* LLM provider */}
            <div className="provider-tabs">
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`provider-tab${p.id === provider ? ' provider-tab-active' : ''}`}
                  onClick={() => setProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <label>
              {t('appApiKey')}
              <input
                type="password"
                value={providerCfg?.apiKey ?? ''}
                placeholder={providerMeta?.keyPlaceholder ?? ''}
                onChange={(e) => setProviderCfg({ apiKey: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <label>
              {t('appModel')}
              {providerMeta && providerMeta.models.length > 0 && provider !== 'custom' ? (
                <select
                  value={providerCfg?.model ?? ''}
                  onChange={(e) => setProviderCfg({ model: e.target.value })}
                >
                  {providerMeta.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {providerCfg?.model && !providerMeta.models.includes(providerCfg.model) && (
                    <option value={providerCfg.model}>{providerCfg.model}</option>
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  value={providerCfg?.model ?? ''}
                  placeholder={provider === 'custom' ? 'e.g. gpt-4o-mini / qwen2.5' : ''}
                  onChange={(e) => setProviderCfg({ model: e.target.value })}
                  spellCheck={false}
                />
              )}
            </label>

            {providerMeta?.needsBaseUrl && (
              <label>
                {t('appBaseUrl')}
                <input
                  type="text"
                  value={providerCfg?.baseUrl ?? ''}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setProviderCfg({ baseUrl: e.target.value })}
                  spellCheck={false}
                />
              </label>
            )}

            {/* Image generation */}
            <label>
              {t('appImageGen')}
              <select
                value={img.provider}
                onChange={(e) => setImageGen({ provider: e.target.value as ImageGenProvider | 'none' })}
              >
                {IMAGE_GEN_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            {img.provider !== 'none' && (
              <>
                <label>
                  {t('appApiKey')}
                  <input
                    type="password"
                    value={img.apiKey}
                    placeholder={t('appImageGenKeyPlaceholder')}
                    onChange={(e) => setImageGen({ apiKey: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('appImageGenModel')}
                  <input
                    type="text"
                    value={img.model ?? ''}
                    placeholder={t('appImageGenModelPlaceholder')}
                    onChange={(e) => setImageGen({ model: e.target.value })}
                    spellCheck={false}
                  />
                </label>
                {img.provider === 'custom' && (
                  <label>
                    {t('appBaseUrl')}
                    <input
                      type="text"
                      value={img.baseUrl ?? ''}
                      placeholder="https://your-image-api/v1"
                      onChange={(e) => setImageGen({ baseUrl: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                )}
              </>
            )}
          </>
        ) : tab === 'skills' ? (
          /* ── Skills tab ── */
          <div className="ai-settings-skills">
            <div className="ai-settings-skills-header">
              <span className="ai-settings-section-title">{t('appSkills')}</span>
              <div className="ai-settings-skills-actions">
                {onCreateSkill && (
                  <button
                    type="button"
                    className="btn-ghost ai-settings-skills-open"
                    onClick={() => setShowCreate((v) => !v)}
                  >
                    {t('appSkillCreate')}
                  </button>
                )}
                {onOpenSkillsDir && (
                  <button
                    type="button"
                    className="btn-ghost ai-settings-skills-open"
                    onClick={onOpenSkillsDir}
                  >
                    {t('appSkillsOpenDir')}
                  </button>
                )}
              </div>
            </div>

            {/* create-skill wizard (inline) */}
            {showCreate && onCreateSkill && (
              <div className="ai-settings-skill-create">
                <label>
                  {t('appSkillName')}
                  <input
                    type="text"
                    value={createForm.name}
                    placeholder="my-skill-name"
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('appSkillDesc')}
                  <input
                    type="text"
                    value={createForm.description}
                    placeholder={t('appSkillDescPlaceholder')}
                    onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('appSkillApp')}
                  <select
                    value={createForm.app}
                    onChange={(e) => setCreateForm((f) => ({ ...f, app: e.target.value }))}
                  >
                    <option value="all">all</option>
                    <option value="docs">docs</option>
                    <option value="sheets">sheets</option>
                    <option value="slides">slides</option>
                  </select>
                </label>
                <label>
                  {t('appSkillBody')}
                  <textarea
                    value={createForm.body}
                    placeholder={t('appSkillBodyPlaceholder')}
                    onChange={(e) => setCreateForm((f) => ({ ...f, body: e.target.value }))}
                    rows={4}
                    spellCheck={false}
                  />
                </label>
                {createError && <p className="ai-settings-skill-create-error">{createError}</p>}
                <div className="ai-settings-skill-create-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={submitCreate}
                    disabled={creating || !createForm.name.trim() || !createForm.description.trim()}
                  >
                    {creating ? t('appSkillCreating') : t('appSkillCreateBtn')}
                  </button>
                </div>
              </div>
            )}

            {/* search box */}
            {skills && skills.length > 0 && (
              <input
                type="text"
                className="ai-settings-skill-search"
                value={skillQuery}
                placeholder={t('appSkillSearch')}
                onChange={(e) => setSkillQuery(e.target.value)}
                spellCheck={false}
              />
            )}

            {filteredSkills.length === 0 ? (
              <p className="ai-settings-skills-empty">
                {skills && skills.length === 0 ? t('appSkillsEmpty') : t('appSkillNoMatch')}
              </p>
            ) : (
              <ul className="ai-settings-skills-list">
                {filteredSkills.map((s) => (
                  <li key={s.dir} className="ai-settings-skill-row">
                    <div className="ai-settings-skill-row-head">
                      <label className="ai-settings-skill-toggle">
                        <input
                          type="checkbox"
                          checked={isSkillEnabled(s.dir)}
                          onChange={(e) => setSkillEnabled(s.dir, e.target.checked)}
                        />
                        <span className="ai-settings-skill-name">{s.name}</span>
                        <span className="ai-settings-skill-app">{s.app}</span>
                        {s.origin === 'builtin' && (
                          <span className="ai-settings-skill-origin" title={t('appSkillBuiltin')}>
                            {t('appSkillBuiltin')}
                          </span>
                        )}
                        {s.health && s.health !== 'ok' && (
                          <span
                            className={`ai-settings-skill-health health-${s.health}`}
                            title={s.healthMessage ?? ''}
                          >
                            {s.health === 'error' ? '!' : '⚠'}
                          </span>
                        )}
                      </label>
                      {onReadSkillBody && (
                        <button
                          type="button"
                          className="btn-ghost ai-settings-skill-expand"
                          onClick={() => void toggleSkillDetail(s.dir)}
                        >
                          {expandedSkill === s.dir ? '▾' : '▸'}
                        </button>
                      )}
                    </div>
                    <span className="ai-settings-skill-desc">{s.description}</span>
                    {s.healthMessage && (
                      <span className={`ai-settings-skill-health-msg health-${s.health}`}>
                        {s.healthMessage}
                      </span>
                    )}
                    {expandedSkill === s.dir && (
                      <div className="ai-settings-skill-detail">
                        {s.whenToUse && (
                          <div className="ai-settings-skill-field">
                            <span className="ai-settings-skill-field-label">
                              {t('appSkillFieldWhenToUse')}
                            </span>
                            <span>{s.whenToUse}</span>
                          </div>
                        )}
                        {s.license && (
                          <div className="ai-settings-skill-field">
                            <span className="ai-settings-skill-field-label">
                              {t('appSkillFieldLicense')}
                            </span>
                            <span>{s.license}</span>
                          </div>
                        )}
                        {s.version && (
                          <div className="ai-settings-skill-field">
                            <span className="ai-settings-skill-field-label">
                              {t('appSkillFieldVersion')}
                            </span>
                            <span>{s.version}</span>
                          </div>
                        )}
                        <div className="ai-settings-skill-field">
                          <span className="ai-settings-skill-field-label">
                            {t('appSkillFieldDir')}
                          </span>
                          <code>{s.dir}</code>
                        </div>
                        <div className="ai-settings-skill-field">
                          <span className="ai-settings-skill-field-label">
                            {t('appSkillFieldBody')}
                          </span>
                          <pre className="ai-settings-skill-body-pre">
                            {skillBody[s.dir] === undefined
                              ? t('appSkillBodyLoading')
                              : skillBody[s.dir] || t('appSkillBodyEmpty')}
                          </pre>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : tab === 'templates' ? (
          /* ── Templates tab ── */
          <div className="ai-settings-templates">
            {/* extract form */}
            {onExtractTemplate && (
              <div className="ai-settings-tpl-extract">
                <label>
                  {t('appTplName')}
                  <input
                    type="text"
                    value={tplName}
                    placeholder={t('appTplNamePlaceholder')}
                    onChange={(e) => setTplName(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={submitExtract}
                  disabled={tplBusy || !tplName.trim()}
                >
                  {tplBusy ? t('appTplExtracting') : t('appTplExtract')}
                </button>
                {tplError && <p className="ai-settings-tpl-error">{tplError}</p>}
                <p className="ai-settings-tpl-hint">{t('appTplExtractHint')}</p>
              </div>
            )}

            {/* saved templates list */}
            {(!templates || templates.length === 0) ? (
              <p className="ai-settings-skills-empty">{t('appTplEmpty')}</p>
            ) : (
              <ul className="ai-settings-skills-list">
                {templates.map((tpl) => (
                  <li key={tpl.id} className="ai-settings-skill-row">
                    <div className="ai-settings-skill-row-head">
                      <span className="ai-settings-skill-name">{tpl.name}</span>
                      <span className="ai-settings-skill-app">{tpl.kind}</span>
                      <div className="ai-settings-skills-actions">
                        {onApplyTemplate && (
                          <button
                            type="button"
                            className="btn-ghost ai-settings-skills-open"
                            onClick={() => void onApplyTemplate(tpl.id)}
                          >
                            {t('appTplApply')}
                          </button>
                        )}
                        {onRenameTemplate && (
                          <button
                            type="button"
                            className="btn-ghost ai-settings-skills-open"
                            onClick={async () => {
                              const newName = window.prompt(t('appTplRenamePrompt'), tpl.name)
                              if (newName && newName !== tpl.name) {
                                await onRenameTemplate(tpl.id, newName)
                              }
                            }}
                          >
                            {t('appTplRename')}
                          </button>
                        )}
                        {onDeleteTemplate && (
                          <button
                            type="button"
                            className="btn-ghost ai-settings-skills-open"
                            onClick={async () => {
                              if (window.confirm(t('appTplDeleteConfirm', { name: tpl.name }))) {
                                await onDeleteTemplate(tpl.id)
                              }
                            }}
                          >
                            {t('appTplDelete')}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('appCancel')}
          </button>
          <button type="button" className="btn-primary" onClick={save}>
            {t('appOk')}
          </button>
        </div>
      </div>
    </div>
  )
}
