import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import { streamForProvider } from '../src/stream'
import { okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = { apiKey: 'test-key', model: 'deepseek-chat' }

function callbacks() {
  return {
    signal: new AbortController().signal,
    onDelta: () => {},
    onToolCall: () => {},
  }
}

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/png' }

describe('text-only provider strips images before the wire', () => {
  it('sends plain string content instead of image_url parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream([])))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'deepseek',
      config,
      'sys',
      [{ role: 'user', text: '美化这一页幻灯片', images: [IMAGE] }] as AgentMessage[],
      [],
      1024,
      callbacks(),
    ).catch(() => {})
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[1]).toEqual({ role: 'user', content: '美化这一页幻灯片' })
    expect(JSON.stringify(body)).not.toContain('image_url')
  })

  it('keeps plain string content when no images (existing behavior)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream([])))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'deepseek',
      config,
      'sys',
      [{ role: 'user', text: 'hi' }] as AgentMessage[],
      [],
      1024,
      callbacks(),
    ).catch(() => {})
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})
