import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { AiCreditsError, sseLines, streamForProvider } from '../src/stream'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  const stopReasons: string[] = []
  return {
    deltas,
    toolCalls,
    stopReasons,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
      onStopReason: (reason: string) => stopReasons.push(reason),
    },
  }
}

describe('sseLines', () => {
  it('splits a stream into lines, including a trailing line with no newline', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\ndata: b\n'))
        controller.enqueue(encoder.encode('data: c')) // no trailing newline
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of sseLines(body)) lines.push(line)
    expect(lines).toEqual(['data: a', 'data: b', 'data: c'])
  })
})

describe('streamForProvider: empty SSE streams surface as errors', () => {
  // A 200 SSE stream with zero text and zero tool calls previously dissolved
  // into an empty "successful" turn; the UI then showed a generic "no content"
  // message with no diagnostics (alpha rows 36/37)
  it.each([
    ['deepseek', 'deepseek-chat', /The model returned no content/],
  ] as const)('%s: rejects on an empty stream', async (provider, model, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(sseStream([]))))
    const { cb } = collector()
    await expect(
      streamForProvider(provider, { apiKey: 'k', model }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(message)
  })

  it('a genuine empty closing turn (normal stop framing) still succeeds', async () => {
    // common after tool-heavy runs: the model ends with a stop and no content;
    // this must NOT be treated as a gateway failure
    const openAiBody = sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(openAiBody)))
    await expect(
      streamForProvider(
        'deepseek',
        { apiKey: 'k', model: 'deepseek-chat' },
        'sys',
        [],
        [],
        100,
        collector().cb,
      ),
    ).resolves.toBeUndefined()
  })

  it('a tool-call-only stream still succeeds (no false empty error)', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"do_thing","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, cb } = collector()
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(toolCalls).toHaveLength(1)
  })
})



describe('streamForProvider: openai-compatible', () => {
  it('reassembles fragmented tool call arguments and flushes on finish_reason', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"partial "}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(deltas.join('')).toBe('partial ')
    expect(toolCalls).toEqual([{ id: 'c1', name: 'replace', input: { x: 1 } }])
  })

  it("finish_reason 'length' normalizes to max_tokens and flags the cut-off tool call", async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace","arguments":"{\\"x\\": \\"trunc"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, stopReasons, cb } = collector()
    await streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(stopReasons).toEqual(['max_tokens'])
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.truncated).toBe(true)
    expect(toolCalls[0]!.inputError).toBeDefined()
  })

  it('throws on a gateway error event instead of finishing an empty turn', async () => {
    const body = sseStream([
      'data: {"error":{"message":"You exceeded your current quota"}}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb } = collector()
    await expect(
      streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow('You exceeded your current quota')
  })

  it('throws when a content_filter finish produced no content', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb } = collector()
    await expect(
      streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/no content \(finish_reason=content_filter\)/)
  })

  it('keeps partial content when content_filter cuts off after some text', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"partial "}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, cb } = collector()
    await streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('partial ')
  })

  it('emits content and tool calls from a complete JSON body sent instead of SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'Here is the change.',
                tool_calls: [{ id: 'c1', function: { name: 'replace', arguments: '{"x":1}' } }],
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    )
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('Here is the change.')
    expect(toolCalls).toEqual([
      { id: 'c1', name: 'replace', input: { x: 1 }, inputError: undefined },
    ])
  })

  it("flags the last tool call of a JSON body with finish_reason 'length' as truncated", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [{ id: 'c1', function: { name: 'replace', arguments: '{"x": "tru' } }],
              },
              finish_reason: 'length',
            },
          ],
        }),
      ),
    )
    const { toolCalls, stopReasons, cb } = collector()
    await streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(toolCalls[0]!.truncated).toBe(true)
    expect(toolCalls[0]!.inputError).toBeDefined()
    expect(stopReasons).toEqual(['max_tokens'])
  })

  it('throws on an empty JSON body sent instead of SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })))
    const { cb } = collector()
    await expect(
      streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/The model returned no content/)
  })

  it('never sends content:null for an assistant turn with neither text nor tools', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          sseStream([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'm' },
      'sys',
      [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: '' },
        { role: 'user', text: 'second' },
      ],
      [],
      100,
      cb,
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>
    }
    for (const msg of body.messages) {
      if (msg.role !== 'assistant') continue
      expect(msg.content === null && !msg.tool_calls).toBe(false)
      if (msg.content !== null) expect(String(msg.content).length).toBeGreaterThan(0)
    }
  })

  it('routes deepseek and openai to their fixed base URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    // empty fixture streams reject with "returned no content"; only the request URL matters here
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      [],
      [],
      100,
      cb,
    ).catch(() => {})
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('uses the configured base URL for the custom provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'custom',
      { apiKey: 'k', model: 'm', baseUrl: 'https://my-endpoint.example.com/v1' },
      'sys',
      [],
      [],
      100,
      cb,
    ).catch(() => {})
    expect(fetchMock).toHaveBeenCalledWith(
      'https://my-endpoint.example.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('rejects the custom provider without a base URL, without ever calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await expect(
      streamForProvider('custom', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/Base URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


describe('streamForProvider: 200 + non-stream JSON instead of SSE', () => {
  const creditsNotice =
    'Your credits have been exhausted. Please top up your provider balance and try again.'
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  it('json route: a non-stream JSON body with a credits notice becomes AiCreditsError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          choices: [{ message: { role: 'assistant', content: creditsNotice } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      ),
    )
    const { cb } = collector()
    const run = streamForProvider('qwen', { apiKey: 'k', model: 'qwen-plus' }, 'sys', [], [], 100, cb)
    await expect(run).rejects.toBeInstanceOf(AiCreditsError)
    await expect(run).rejects.toThrow(/credits have been exhausted/)
  })

  it('openai-compatible route: an insufficient-credits message becomes AiCreditsError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          choices: [{ message: { role: 'assistant', content: 'Insufficient credits remaining.' } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      ),
    )
    const { cb } = collector()
    await expect(
      streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toBeInstanceOf(AiCreditsError)
  })

  it('a non-credits notice is emitted as the reply text instead of an empty turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          choices: [
            { message: { role: 'assistant', content: 'The service is under maintenance until 06:00 UTC.' } },
          ],
        }),
      ),
    )
    const { deltas, cb } = collector()
    await streamForProvider('qwen', { apiKey: 'k', model: 'qwen-plus' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('The service is under maintenance until 06:00 UTC.')
  })

  it('an unextractable body throws with a body summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not json at all', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const { cb } = collector()
    await expect(
      streamForProvider('qwen', { apiKey: 'k', model: 'qwen-plus' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/The model returned an unparseable JSON body: not json at all/)
  })

  it('JSON without a message text also falls back to the body summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ choices: [] })))
    const { cb } = collector()
    await expect(
      streamForProvider('deepseek', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/The model returned no content: \{"choices":\[\]\}/)
  })

  it('a missing Content-Type is still treated as a stream', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, cb } = collector()
    await streamForProvider('qwen', { apiKey: 'k', model: 'qwen-plus' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('ok')
  })
})

it('rejects an unknown provider id', async () => {
  const { cb } = collector()
  await expect(
    streamForProvider('unknown' as never, { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
  ).rejects.toThrow(/Unknown provider/)
})
