import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import { streamForProvider } from '../src/stream'
import { okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = { apiKey: 'test-key', model: 'qwen-vl-max' }

function callbacks() {
  return {
    signal: new AbortController().signal,
    onDelta: () => {},
    onToolCall: () => {},
  }
}

/** run one turn against a stubbed fetch and return the parsed request body */
async function requestBodyFor(
  provider: 'qwen' | 'kimi' | 'deepseek',
  model: string,
  messages: AgentMessage[],
): Promise<any> {
  const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream([])))
  vi.stubGlobal('fetch', fetchMock)
  // the empty fixture stream legitimately rejects with "returned no content";
  // these tests only inspect the outgoing request body
  await streamForProvider(
    provider,
    { apiKey: 'test-key', model },
    'sys',
    messages,
    [],
    1024,
    callbacks(),
  ).catch(() => {})
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/png' }

describe('OpenAI-compatible user message with images (vision model)', () => {
  it('sends a content array of text + image_url parts', async () => {
    const body = await requestBodyFor('qwen', 'qwen-vl-max', [
      { role: 'user', text: 'look at this image', images: [IMAGE] },
    ])
    expect(body.model).toBe('qwen-vl-max')
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look at this image' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aGVsbG8=' },
        },
      ],
    })
  })

  it('keeps plain string content when no images (existing behavior)', async () => {
    const body = await requestBodyFor('kimi', 'moonshot-v1-8k', [{ role: 'user', text: 'hi' }])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('text-only model strips images before the wire', () => {
  it('qwen text model sends plain string content', async () => {
    const body = await requestBodyFor('qwen', 'qwen-plus', [
      { role: 'user', text: 'beautify', images: [IMAGE] },
    ])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'beautify' })
  })

  it('kimi text model sends plain string content', async () => {
    const body = await requestBodyFor('kimi', 'kimi-k2-0905-preview', [
      { role: 'user', text: 'beautify', images: [IMAGE] },
    ])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'beautify' })
  })

  it('deepseek sends plain string content', async () => {
    const body = await requestBodyFor('deepseek', 'deepseek-chat', [
      { role: 'user', text: 'beautify', images: [IMAGE] },
    ])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'beautify' })
  })
})
