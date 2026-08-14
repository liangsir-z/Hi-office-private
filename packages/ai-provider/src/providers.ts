import type { AiProviderId, AiProviderMeta, AiSettings, LegacyAiSettings } from './types'

/**
 * Domestic (China) provider lineup only. Every fixed provider speaks the
 * OpenAI-compatible chat/completions protocol, so they all ride the same
 * wire implementation; `custom` covers any other OpenAI-compatible endpoint
 * (Ollama, vLLM, OpenRouter, ...).
 */
export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vision: false,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'qwen',
    label: '通义千问(百炼)',
    // dashscope compatible-mode: only the -vl models accept image parts
    visionModels: /(^|[-.])vl([-.-]|$)/i,
    models: [
      'qwen3-max',
      'qwen-max',
      'qwen-plus',
      'qwen-flash',
      'qwen-vl-max',
      'qwen-vl-plus',
    ],
    defaultModel: 'qwen-plus',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    visionModels: /glm-[\d.]*v/i,
    models: ['glm-4.5-flash', 'glm-4v-flash', 'glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4v-plus'],
    defaultModel: 'glm-4.5-flash',
    keyPlaceholder: '....',
  },
  {
    id: 'kimi',
    label: 'Kimi(月之暗面)',
    visionModels: /vision/i,
    models: [
      'kimi-k2-0905-preview',
      'kimi-latest',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
      'moonshot-v1-8k-vision-preview',
    ],
    defaultModel: 'kimi-latest',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    // M2 takes multimodal messages; keep the gate permissive for newer releases
    visionModels: /m[2-9]|vl/i,
    models: ['MiniMax-M2', 'MiniMax-M1'],
    defaultModel: 'MiniMax-M2',
    keyPlaceholder: 'eyJ...',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    visionModels: /vl/i,
    models: [
      'Qwen/Qwen3-32B',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-VL-32B-Instruct',
      'THUDM/GLM-4-9B-0414',
    ],
    defaultModel: 'Qwen/Qwen3-32B',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'custom',
    label: '自定义',
    vision: true,
    models: [],
    defaultModel: '',
    keyPlaceholder: 'API Key',
    needsBaseUrl: true,
  },
]

/** Fixed base URLs of the OpenAI-compatible endpoints (custom is user-supplied). */
export const PROVIDER_BASE_URLS: Record<Exclude<AiProviderId, 'custom'>, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  kimi: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimaxi.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
}

/**
 * Whether a request to `provider` with model `model` may carry inline image
 * attachments. `visionModels` (model-level gate) wins over the provider-level
 * `vision` flag; providers that declare neither default to vision-capable.
 */
export function providerSupportsVision(provider: AiProviderId, model?: string): boolean {
  const meta = AI_PROVIDERS.find((meta) => meta.id === provider)
  if (!meta) return false
  if (meta.visionModels) return !!model && meta.visionModels.test(model)
  return meta.vision !== false
}

/**
 * Fresh settings with every provider's default model and an empty key,
 * except providers listed in `defaultApiKeys` (an app-specific
 * preconfigured key). Callers own that policy; this package
 * has no hardcoded keys.
 */
export function defaultAiSettings(
  defaultApiKeys?: Partial<Record<AiProviderId, string>>,
): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    providers[meta.id] = {
      apiKey: defaultApiKeys?.[meta.id] ?? '',
      model: meta.defaultModel,
      baseUrl: meta.needsBaseUrl ? '' : undefined,
    }
  }
  // [BYOK] default to 'custom' so a fresh install lets the user fill in their own
  // OpenAI-compatible endpoint (Ollama/vLLM/...) instead of Hi-office.
  return { provider: 'custom', providers }
}

/**
 * Migration map for provider ids removed from the lineup: OpenAI is itself
 * OpenAI-compatible, so its key/baseUrl survive in the custom slot; the
 * native Anthropic/Gemini protocols have no compatible replacement here, so
 * those fall back to the DeepSeek slot (the user re-enters a key).
 */
const REMOVED_PROVIDER_FALLBACK: Record<string, 'custom' | 'deepseek'> = {
  openai: 'custom',
  anthropic: 'deepseek',
  gemini: 'deepseek',
}

const REMOVED_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Merge on-disk settings over freshly computed defaults, migrating older
 * shapes: the pre-provider single-endpoint form into the "custom" slot, and
 * provider ids that no longer exist onto their fallback slot. `stored` is
 * whatever the caller read from its settings file (already JSON-parsed);
 * this function does no file I/O.
 */
export function resolveAiSettings(
  stored: Partial<AiSettings> & LegacyAiSettings,
  defaults: AiSettings,
): AiSettings {
  if (!stored.providers) {
    if (stored.apiKey) {
      defaults.providers.custom = {
        apiKey: stored.apiKey,
        model: stored.model ?? '',
        baseUrl: stored.baseUrl ?? '',
      }
    }
    return defaults
  }
  const providers = { ...defaults.providers, ...stored.providers } as AiSettings['providers'] & {
    [k: string]: unknown
  }
  let provider = (stored.provider ?? defaults.provider) as AiProviderId
  if (!(AI_PROVIDERS.some((meta) => meta.id === provider))) {
    const fallback = REMOVED_PROVIDER_FALLBACK[provider]
    if (fallback === 'custom') {
      const removed = (stored.providers as Record<string, unknown>).openai as
        | { apiKey?: string; model?: string }
        | undefined
      const custom = providers.custom
      // keep any hand-configured custom endpoint; only fill the slot when empty
      if (removed?.apiKey && !custom?.apiKey) {
        providers.custom = {
          apiKey: removed.apiKey,
          model: removed?.model || custom?.model || '',
          baseUrl: custom?.baseUrl || REMOVED_OPENAI_BASE_URL,
        }
      }
    }
    for (const removedId of Object.keys(REMOVED_PROVIDER_FALLBACK)) delete providers[removedId]
    provider = fallback ?? 'deepseek'
  }
  return { provider, providers }
}
