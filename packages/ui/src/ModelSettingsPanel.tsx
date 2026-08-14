import type { Dispatch, SetStateAction } from 'react'
import {
  AI_PROVIDERS,
  type AiProviderId,
  type AiSettings,
  type ImageGenConfig,
  type ImageGenProvider,
} from '@genoffice/ai-provider'
import type { AiSettingsT } from './AiSettingsModal'

const IMAGE_GEN_PROVIDERS: Array<{ id: ImageGenProvider | 'none'; label: string }> = [
  { id: 'none', label: 'None (disabled)' },
  { id: 'aliyun-wanx', label: 'Aliyun Wanx (通义万相)' },
  { id: 'volcengine-jimeng', label: 'Volcengine Jimeng (即梦)' },
  { id: 'custom', label: 'Custom' },
]

export interface ModelSettingsPanelProps {
  /** settings draft; the panel edits providers/models/keys/imageGen in place */
  draft: AiSettings
  setDraft: Dispatch<SetStateAction<AiSettings>>
  t: AiSettingsT
}

/**
 * The model half of the former AiSettingsModal: LLM provider tabs + API key +
 * model + base URL (custom) + image-generation backend. Settings-wide (shared
 * by every app), hosted by the shell's global settings window; the per-app
 * dialogs keep only skills/templates.
 */
export function ModelSettingsPanel({ draft, setDraft, t }: ModelSettingsPanelProps) {
  const provider = draft.provider
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider)
  const providerCfg = draft.providers[provider]
  const img = draft.imageGen ?? { provider: 'none' as const, apiKey: '' }

  const setProvider = (id: AiProviderId) => setDraft((d) => ({ ...d, provider: id }))

  const setProviderCfg = (patch: Partial<NonNullable<typeof providerCfg>>) =>
    setDraft((d) => ({
      ...d,
      providers: { ...d.providers, [provider]: { ...d.providers[provider], ...patch } },
    }))

  const setImageGen = (patch: Partial<ImageGenConfig>) =>
    setDraft((d) => ({
      ...d,
      imageGen: { ...(d.imageGen ?? { provider: 'none', apiKey: '' }), ...patch },
    }))

  return (
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
        {t('settingsApiKey')}
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
        {t('settingsModel')}
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
            placeholder={provider === 'custom' ? 'e.g. qwen-plus / glm-4-flash' : ''}
            onChange={(e) => setProviderCfg({ model: e.target.value })}
            spellCheck={false}
          />
        )}
      </label>

      {providerMeta?.needsBaseUrl && (
        <label>
          {t('settingsBaseUrl')}
          <input
            type="text"
            value={providerCfg?.baseUrl ?? ''}
            placeholder="https://api.siliconflow.cn/v1"
            onChange={(e) => setProviderCfg({ baseUrl: e.target.value })}
            spellCheck={false}
          />
        </label>
      )}

      {/* Image generation */}
      <label>
        {t('settingsImageGen')}
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
            {t('settingsApiKey')}
            <input
              type="password"
              value={img.apiKey}
              placeholder={t('settingsApiKey')}
              onChange={(e) => setImageGen({ apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            {t('settingsModel')}
            <input
              type="text"
              value={img.model ?? ''}
              placeholder={t('settingsModel')}
              onChange={(e) => setImageGen({ model: e.target.value })}
              spellCheck={false}
            />
          </label>
          {img.provider === 'custom' && (
            <label>
              {t('settingsBaseUrl')}
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
  )
}
