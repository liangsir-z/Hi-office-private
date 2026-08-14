import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamForProvider } from '../src/stream'
import { providerSupportsVision } from '../src/providers'
import { okResponse, sseStream } from './test-utils'
import type { AgentMessage } from '@genoffice/agent-core'

function collector() {
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

describe('provider vision capability (deepseek-only build)', () => {
  it('never takes images regardless of model', () => {
    expect(providerSupportsVision('deepseek')).toBe(false)
    expect(providerSupportsVision('deepseek', 'deepseek-chat')).toBe(false)
    expect(providerSupportsVision('deepseek', 'deepseek-reasoner')).toBe(false)
  })
})

describe('image stripping on the wire', () => {
  it('drops image parts for deepseek', async () => {
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
    expect(body.messages[1].content).toBe('美化这一页幻灯片')
  })
})
