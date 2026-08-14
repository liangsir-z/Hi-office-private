import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import { PROVIDER_BASE_URLS } from '../src/providers'
import { errorResponse, jsonResponse } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatForProvider', () => {
  it('extracts the message content from an OpenAI-compatible response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hello world' } }] })),
    )
    const result = await chatForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      'hi',
    )
    expect(result).toEqual({ ok: true, content: 'hello world' })
  })

  it('every fixed provider hits its own base URL', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const models: Record<string, string> = {
      deepseek: 'deepseek-chat',
      qwen: 'qwen-plus',
      zhipu: 'glm-4-flash',
      kimi: 'kimi-latest',
      minimax: 'MiniMax-M2',
      siliconflow: 'Qwen/Qwen3-32B',
    }
    for (const [provider, model] of Object.entries(models)) {
      await chatForProvider(provider as never, { apiKey: 'k', model }, 'sys', 'hi')
      expect(fetchMock).toHaveBeenCalledWith(
        `${PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS]}/chat/completions`,
        expect.anything(),
      )
    }
  })

  it('surfaces HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'bad key')))
    const result = await chatForProvider('qwen', { apiKey: 'k', model: 'qwen-plus' }, 'sys', 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/HTTP 401/)
  })

  it('replaces an HTML error body with a readable note', async () => {
    const html =
      '<!doctype html>\n<html>\n<head><title>Hi-office</title></head><body>app shell</body></html>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(403, html)))
    const result = await chatForProvider('kimi', { apiKey: 'k', model: 'kimi-latest' }, 'sys', 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/HTTP 403/)
    expect(result.error).toMatch(/web page instead of an API response/)
    expect(result.error).not.toContain('<!doctype')
  })

  it('custom: uses the configured base URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await chatForProvider(
      'custom',
      { apiKey: 'k', model: 'm', baseUrl: 'https://my-endpoint.example.com/v1' },
      'sys',
      'hi',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://my-endpoint.example.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('custom: rejects without a base URL, without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatForProvider('custom', { apiKey: 'k', model: 'm' }, 'sys', 'hi')
    expect(result).toEqual({ ok: false, error: 'A custom provider requires a Base URL' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty response body as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })))
    const result = await chatForProvider(
      'zhipu',
      { apiKey: 'k', model: 'glm-4-flash' },
      'sys',
      'hi',
    )
    expect(result).toEqual({ ok: false, error: 'AI returned an empty response' })
  })
})
