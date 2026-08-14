import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  PROVIDER_BASE_URLS,
  defaultAiSettings,
  providerSupportsVision,
  resolveAiSettings,
} from '../src/providers'
import type { AiSettings } from '../src/types'

describe('defaultAiSettings', () => {
  it('gives every provider its default model and an empty key by default', () => {
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('custom')
    for (const meta of AI_PROVIDERS) {
      expect(settings.providers[meta.id].apiKey).toBe('')
      expect(settings.providers[meta.id].model).toBe(meta.defaultModel)
    }
    expect(settings.providers.custom.baseUrl).toBe('')
    expect(settings.providers.deepseek.baseUrl).toBeUndefined()
  })

  it('applies caller-supplied default keys only to the listed providers', () => {
    const settings = defaultAiSettings({ deepseek: 'sk-preset' })
    expect(settings.providers.deepseek.apiKey).toBe('sk-preset')
    expect(settings.providers.qwen.apiKey).toBe('')
  })
})

describe('PROVIDER_BASE_URLS', () => {
  it('covers every fixed (non-custom) provider with a domestic endpoint', () => {
    const ids = AI_PROVIDERS.filter((meta) => !meta.needsBaseUrl).map((meta) => meta.id)
    expect(Object.keys(PROVIDER_BASE_URLS).sort()).toEqual([...ids].sort())
    for (const url of Object.values(PROVIDER_BASE_URLS)) {
      expect(url).toMatch(/^https:\/\//i)
      expect(url).toMatch(/\/v\d$/i)
    }
  })
})

describe('providerSupportsVision (model-level gate)', () => {
  it('deepseek never takes images', () => {
    expect(providerSupportsVision('deepseek', 'deepseek-chat')).toBe(false)
    expect(providerSupportsVision('deepseek', 'deepseek-reasoner')).toBe(false)
  })

  it('qwen only takes images on -vl models', () => {
    expect(providerSupportsVision('qwen', 'qwen-vl-max')).toBe(true)
    expect(providerSupportsVision('qwen', 'qwen-vl-plus')).toBe(true)
    expect(providerSupportsVision('qwen', 'qwen-plus')).toBe(false)
    expect(providerSupportsVision('qwen', 'qwen3-max')).toBe(false)
  })

  it('zhipu only takes images on glm-4v* models', () => {
    expect(providerSupportsVision('zhipu', 'glm-4v-plus')).toBe(true)
    expect(providerSupportsVision('zhipu', 'glm-4v-flash')).toBe(true)
    expect(providerSupportsVision('zhipu', 'glm-4-plus')).toBe(false)
  })

  it('kimi only takes images on *vision* models', () => {
    expect(providerSupportsVision('kimi', 'moonshot-v1-8k-vision-preview')).toBe(true)
    expect(providerSupportsVision('kimi', 'kimi-k2-0905-preview')).toBe(false)
  })

  it('siliconflow keys off VL in the model id', () => {
    expect(providerSupportsVision('siliconflow', 'Qwen/Qwen2.5-VL-32B-Instruct')).toBe(true)
    expect(providerSupportsVision('siliconflow', 'deepseek-ai/DeepSeek-V3')).toBe(false)
  })

  it('custom passes images through', () => {
    expect(providerSupportsVision('custom', 'whatever-model')).toBe(true)
  })
})

describe('resolveAiSettings migration', () => {
  it('returns fresh defaults when nothing is stored', () => {
    const defaults = defaultAiSettings({ deepseek: 'sk-preset' })
    expect(resolveAiSettings({}, defaults)).toEqual(defaults)
  })

  it('migrates the pre-provider single-endpoint shape into the custom provider', () => {
    const defaults = defaultAiSettings()
    const resolved = resolveAiSettings(
      { apiKey: 'legacy-key', model: 'legacy-model', baseUrl: 'https://legacy.example.com/v1' },
      defaults,
    )
    expect(resolved.providers.custom).toEqual({
      apiKey: 'legacy-key',
      model: 'legacy-model',
      baseUrl: 'https://legacy.example.com/v1',
    })
    // untouched providers keep their defaults
    expect(resolved.providers.deepseek).toEqual(defaults.providers.deepseek)
  })

  it('leaves the legacy custom baseUrl empty when omitted (user fills it in)', () => {
    const resolved = resolveAiSettings({ apiKey: 'legacy-key' }, defaultAiSettings())
    expect(resolved.providers.custom.baseUrl).toBe('')
  })

  it('migrates a removed openai provider into the custom slot with its key', () => {
    const defaults = defaultAiSettings()
    const resolved = resolveAiSettings(
      {
        provider: 'openai',
        providers: { openai: { apiKey: 'sk-oai', model: 'gpt-4o' } },
      } as never,
      defaults,
    )
    expect(resolved.provider).toBe('custom')
    expect(resolved.providers.custom).toEqual({
      apiKey: 'sk-oai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect((resolved.providers as Record<string, unknown>).openai).toBeUndefined()
  })

  it('keeps a hand-configured custom endpoint when migrating openai away', () => {
    const defaults = defaultAiSettings()
    const resolved = resolveAiSettings(
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'sk-oai', model: 'gpt-4o' },
          custom: { apiKey: 'sk-own', model: 'local-model', baseUrl: 'http://localhost:11434/v1' },
        },
      } as never,
      defaults,
    )
    expect(resolved.provider).toBe('custom')
    expect(resolved.providers.custom.baseUrl).toBe('http://localhost:11434/v1')
    expect(resolved.providers.custom.apiKey).toBe('sk-own')
  })

  it('falls back to deepseek when the removed provider has no compatible mapping', () => {
    const defaults = defaultAiSettings()
    for (const removed of ['anthropic', 'gemini'] as const) {
      const resolved = resolveAiSettings(
        { provider: removed, providers: { [removed]: { apiKey: 'k', model: 'm' } } } as never,
        defaults,
      )
      expect(resolved.provider).toBe('deepseek')
      expect((resolved.providers as Record<string, unknown>)[removed]).toBeUndefined()
    }
  })

  it('merges stored multi-provider settings over the defaults, provider by provider', () => {
    const defaults = defaultAiSettings({ deepseek: 'preset-key' })
    const resolved = resolveAiSettings(
      {
        provider: 'qwen',
        providers: {
          qwen: { apiKey: 'stored-qwen-key', model: 'qwen3-max' },
        } as never,
      },
      defaults,
    )
    expect(resolved.provider).toBe('qwen')
    expect(resolved.providers.qwen).toEqual({ apiKey: 'stored-qwen-key', model: 'qwen3-max' })
    // provider not mentioned in stored.providers keeps the computed default
    expect(resolved.providers.deepseek.apiKey).toBe('preset-key')
  })

  it('keeps a valid stored provider untouched', () => {
    const stored = {
      provider: 'kimi',
      providers: { kimi: { apiKey: 'sk-k', model: 'kimi-latest' } },
    } as never
    const resolved = resolveAiSettings(stored, defaultAiSettings())
    expect(resolved.provider).toBe('kimi')
  })
})
