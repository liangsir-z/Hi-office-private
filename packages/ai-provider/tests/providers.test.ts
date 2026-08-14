import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  PROVIDER_BASE_URLS,
  defaultAiSettings,
  providerSupportsVision,
  resolveAiSettings,
} from '../src/providers'

describe('single-provider lineup', () => {
  it('contains exactly DeepSeek with the fixed endpoint', () => {
    expect(AI_PROVIDERS).toHaveLength(1)
    expect(AI_PROVIDERS[0]!.id).toBe('deepseek')
    expect(PROVIDER_BASE_URLS.deepseek).toBe('https://api.deepseek.com/v1')
    expect(AI_PROVIDERS[0]!.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('defaultAiSettings points at deepseek with an empty key', () => {
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('deepseek')
    expect(settings.providers.deepseek.apiKey).toBe('')
    expect(settings.providers.deepseek.model).toBe('deepseek-chat')
  })

  it('applies a caller-supplied default key', () => {
    expect(defaultAiSettings('sk-preset').providers.deepseek.apiKey).toBe('sk-preset')
  })

  it('deepseek never takes images', () => {
    expect(providerSupportsVision('deepseek', 'deepseek-chat')).toBe(false)
    expect(providerSupportsVision('deepseek', 'deepseek-reasoner')).toBe(false)
  })
})

describe('resolveAiSettings migration (single provider)', () => {
  it('returns fresh defaults when nothing is stored', () => {
    const defaults = defaultAiSettings('sk-preset')
    expect(resolveAiSettings({}, defaults)).toEqual(defaults)
  })

  it('keeps a valid stored deepseek slot', () => {
    const resolved = resolveAiSettings(
      { provider: 'deepseek', providers: { deepseek: { apiKey: 'sk-k', model: 'deepseek-reasoner' } } },
      defaultAiSettings(),
    )
    expect(resolved.provider).toBe('deepseek')
    expect(resolved.providers.deepseek).toEqual({ apiKey: 'sk-k', model: 'deepseek-reasoner' })
  })

  it('collapses any removed provider id onto deepseek and drops its keys', () => {
    for (const removed of ['openai', 'anthropic', 'gemini', 'qwen', 'zhipu', 'kimi', 'minimax', 'siliconflow', 'custom'] as const) {
      const resolved = resolveAiSettings(
        {
          provider: removed,
          providers: {
            [removed]: { apiKey: 'sk-foreign', model: 'm' },
            deepseek: { apiKey: 'sk-kept', model: 'deepseek-chat' },
          },
        } as never,
        defaultAiSettings(),
      )
      expect(resolved.provider).toBe('deepseek')
      expect(resolved.providers.deepseek.apiKey).toBe('sk-kept')
      expect(Object.keys(resolved.providers)).toEqual(['deepseek'])
    }
  })

  it('falls back to the default model when the deepseek slot has none', () => {
    const resolved = resolveAiSettings(
      { provider: 'custom', providers: { custom: { apiKey: 'x', model: 'y' } } } as never,
      defaultAiSettings(),
    )
    expect(resolved.providers.deepseek.model).toBe('deepseek-chat')
    expect(resolved.providers.deepseek.apiKey).toBe('')
  })
})
