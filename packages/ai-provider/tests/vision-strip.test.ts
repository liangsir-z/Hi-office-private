import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamForProvider } from '../src/stream'
import { providerSupportsVision } from '../src/providers'
import { sseStream, okResponse } from './test-utils'
import type { AgentMessage } from '@genoffice/agent-core'

/**
 * Text-only backends (deepseek-chat / deepseek-reasoner) reject the OpenAI
 * image_url content part with HTTP 400 ("unknown variant `image_url`,
 * expected `text`"), so image attachments must be stripped for providers
 * whose models have no vision input.
 */

import type { StreamCallbacks } from '../src/stream'

function collector(): { cb: StreamCallbacks } {
  return { cb: { onDelta: () => {}, onToolCall: () => {}, signal: new AbortController().signal } }
}

function messageWithImage(): AgentMessage[] {
  return [
    {
      role: 'user',
      text: '美化这一页幻灯片',
      images: [{ mime: 'image/png', base64: 'aGVsbG8=' }],
    } as AgentMessage,
  ]
}

function openAiDone(): Response {
  return okResponse(
    sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('provider vision capability', () => {
  it('marks deepseek as text-only and the others as vision-capable', () => {
    expect(providerSupportsVision('deepseek')).toBe(false)
    expect(providerSupportsVision('openai')).toBe(true)
    expect(providerSupportsVision('anthropic')).toBe(true)
    expect(providerSupportsVision('gemini')).toBe(true)
    expect(providerSupportsVision('custom')).toBe(true)
  })
})

describe('image stripping on the OpenAI-compatible wire format', () => {
  it('drops image parts for deepseek (text-only backend)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiDone())
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      messageWithImage(),
      [],
      100,
      collector().cb,
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const user = body.messages[1]
    expect(user.content).toBe('美化这一页幻灯片')
  })

  it('keeps image parts for vision-capable providers (openai)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiDone())
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'openai',
      { apiKey: 'k', model: 'gpt-4.1-mini' },
      'sys',
      messageWithImage(),
      [],
      100,
      collector().cb,
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const parts = body.messages[1].content as Array<{ type: string }>
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url'])
  })
})
