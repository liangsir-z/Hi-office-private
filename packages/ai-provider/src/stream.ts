import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { httpBodyDetail } from './http-error'
import type { AiProviderConfig, AiProviderId } from './types'
import { providerSupportsVision, PROVIDER_BASE_URLS } from './providers'
import { createStreamWatchdog, type StreamWatchdog } from './watchdog'

// ---- streaming (SSE line splitting shared by all providers) ----

export async function* sseLines(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  onBytes?: () => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const stream = body as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    onBytes?.()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) yield line
  }
  if (buffer) yield buffer
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  onToolCall: (call: AgentToolCall) => void
  /** normalized stop reason ('max_tokens' when the output was cut off by the token limit) */
  onStopReason?: (reason: string) => void
  /** bytes arrived on the wire (fires per network chunk, including SSE pings; used for keepalive) */
  onActivity?: () => void
  signal: AbortSignal
}

/**
 * Models occasionally emit unescaped " inside string values (e.g. English quotes in Chinese copy).
 * Single-pass scan: a " inside a string whose next non-whitespace char is not structural gets escaped.
 */
function repairUnescapedQuotes(json: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!
    if (!inStr) {
      if (c === '"') inStr = true
      out += c
      continue
    }
    if (c === '\\') {
      out += c + (json[++i] ?? '')
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < json.length && ' \n\r\t'.includes(json[j]!)) j++
      const next = json[j]
      if (next === undefined || ',}]:'.includes(next)) {
        inStr = false
        out += c
      } else {
        out += '\\"'
      }
      continue
    }
    out += c
  }
  return out
}

/**
 * Gateways can report failures (quota exhausted, moderation, upstream errors) inside a
 * 200 SSE stream, in shapes that don't match the provider protocol (e.g. an OpenAI-style
 * `{"error": ...}` event on the Anthropic route). Extract a readable message so these
 * surface as real errors instead of dissolving into an empty "successful" turn.
 */
function sseErrorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
    try {
      return JSON.stringify(error)
    } catch {
      /* circular or otherwise unserializable — use the fallback */
    }
  }
  return fallback
}

/**
 * Gateways can answer a `stream: true` request with a complete non-SSE JSON body —
 * observed on the Hi-office Anthropic route when credits are exhausted (HTTP 200,
 * Content-Type: application/json, the notice text inside a regular message). The SSE
 * parser would find no `data:` lines in such a body and dissolve it into an empty
 * "successful" turn. Returns the body text when that happens, else null.
 */
async function jsonBodyInsteadOfSse(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? await response.text() : null
}

/**
 * A non-SSE JSON reply whose text is the gateway's credits-exhausted notice
 * (Hi-office: "Your Hi-office credits have been exhausted…") surfaces as a typed
 * error so the apps show a localized "top up" message (errorCode 'credits')
 * instead of the English notice as a normal assistant reply.
 */
export class AiCreditsError extends Error {
  constructor(notice: string) {
    super(notice)
    this.name = 'AiCreditsError'
  }
}

function creditsNoticeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.toLowerCase()
    const credits = t.includes('credit') && (t.includes('exhausted') || t.includes('insufficient'))
    return credits ? value : null
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    for (const v of Object.values(value)) {
      const hit = creditsNoticeText(v)
      if (hit) return hit
    }
  }
  return null
}

function throwIfCreditsNotice(bodyText: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return // unparseable bodies are the emit helpers' problem
  }
  const notice = creditsNoticeText(parsed)
  if (notice) throw new AiCreditsError(notice)
}

/** Don't throw on parse failure (it would kill the whole stream); return error so the loop feeds it back for retry */
function parseToolInput(json: string): { input: Record<string, unknown>; error?: string } {
  if (!json.trim()) return { input: {} }
  try {
    return { input: JSON.parse(json) as Record<string, unknown> }
  } catch (e) {
    try {
      return { input: JSON.parse(repairUnescapedQuotes(json)) as Record<string, unknown> }
    } catch {
      const msg = e instanceof Error ? e.message : String(e)
      return { input: {}, error: `${msg}; raw: ${json.slice(0, 500)}` }
    }
  }
}

// ---- OpenAI-compatible (every fixed provider + custom) ----

function openAiMessages(system: string, messages: AgentMessage[], includeImages: boolean): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      const images = includeImages ? (m.images ?? []) : []
      if (!images.length) {
        out.push({ role: 'user', content: m.text })
      } else {
        out.push({
          role: 'user',
          content: [
            ...(m.text ? [{ type: 'text', text: m.text }] : []),
            ...images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.base64}` },
            })),
          ],
        })
      }
    } else if (m.role === 'assistant') {
      const hasTools = !!(m.toolCalls && m.toolCalls.length > 0)
      // content:null with no tool_calls is an empty assistant turn; some OpenAI-
      // compatible proxies drop or reject the follow-up conversation after that.
      out.push({
        role: 'assistant',
        content: m.text || (hasTools ? null : '(no content)'),
        ...(hasTools
          ? {
              tool_calls: m.toolCalls!.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      })
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.output })
      }
    }
  }
  return out
}

/** Emits a complete (non-streamed) chat completion delivered as a plain JSON body. */
function emitOpenAiJsonMessage(bodyText: string, cb: StreamCallbacks): void {
  let msg: {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
      finish_reason?: string | null
    }>
    error?: { message?: string } | string
  }
  try {
    msg = JSON.parse(bodyText) as typeof msg
  } catch {
    throw new Error(`The model returned an unparseable JSON body: ${httpBodyDetail(bodyText)}`)
  }
  if (msg.error) throw new Error(sseErrorText(msg.error, 'Model error'))
  const choice = msg.choices?.[0]
  let emitted = false
  if (choice?.message?.content) {
    emitted = true
    cb.onDelta(choice.message.content)
  }
  const toolCalls: AgentToolCall[] = []
  for (const tc of choice?.message?.tool_calls ?? []) {
    if (!tc.function?.name) continue
    emitted = true
    const { input, error } = parseToolInput(tc.function.arguments ?? '')
    toolCalls.push({
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function.name,
      input,
      inputError: error,
    })
  }
  // a 'length' finish may have cut off the last tool call's arguments
  const lastTool = toolCalls.at(-1)
  if (choice?.finish_reason === 'length' && lastTool) lastTool.truncated = true
  for (const call of toolCalls) cb.onToolCall(call)
  if (!emitted) throw new Error(`The model returned no content: ${httpBodyDetail(bodyText)}`)
  if (choice?.finish_reason === 'length') cb.onStopReason?.('max_tokens')
}

export async function streamOpenAiCompatible(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  includeImages = true,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(() =>
    openAiCompatibleTurn(baseUrl, config, system, messages, tools, maxTokens, cb, wd, includeImages),
  )
}

async function openAiCompatibleTurn(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  wd: StreamWatchdog,
  includeImages: boolean,
): Promise<void> {
  const onBytes = () => {
    wd.touch()
    cb.onActivity?.()
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: wd.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: openAiMessages(system, messages, includeImages),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      temperature: 0.3,
      stream: true,
    }),
  })
  // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
  onBytes()
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}: ${httpBodyDetail(await response.text())}`)
  }
  const jsonBody = await jsonBodyInsteadOfSse(response)
  if (jsonBody !== null) {
    throwIfCreditsNotice(jsonBody)
    return emitOpenAiJsonMessage(jsonBody, cb)
  }
  // tool call arguments stream in fragments keyed by index
  const pendingTools = new Map<number, { id: string; name: string; json: string }>()
  let stopReason: string | undefined
  let abnormalFinish: string | undefined
  let sawFinish = false
  let emitted = false
  const flushTools = () => {
    const entries = [...pendingTools.entries()].sort(([a], [b]) => a - b)
    const lastIndex = entries.at(-1)?.[0]
    for (const [index, pending] of entries) {
      if (pending.name) {
        const { input, error } = parseToolInput(pending.json)
        emitted = true
        cb.onToolCall({
          id: pending.id,
          name: pending.name,
          input,
          inputError: error,
          // a 'length' finish cuts off the last streaming tool's arguments
          ...(stopReason === 'max_tokens' && index === lastIndex ? { truncated: true } : {}),
        })
      }
    }
    pendingTools.clear()
  }
  for await (const line of sseLines(response.body, onBytes)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    if (payload === '[DONE]') break
    const event = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string
          tool_calls?: Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      error?: { message?: string } | string
    }
    if (event.error) throw new Error(sseErrorText(event.error, 'Model stream error'))
    const choice = event.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) {
      emitted = true
      cb.onDelta(choice.delta.content)
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const pending = pendingTools.get(tc.index) ?? {
        id: tc.id ?? crypto.randomUUID(),
        name: '',
        json: '',
      }
      if (tc.id) pending.id = tc.id
      if (tc.function?.name) pending.name += tc.function.name
      if (tc.function?.arguments) pending.json += tc.function.arguments
      pendingTools.set(tc.index, pending)
    }
    if (choice.finish_reason) {
      sawFinish = true
      if (choice.finish_reason === 'length') stopReason = 'max_tokens'
      else if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') {
        abnormalFinish = choice.finish_reason
      }
      flushTools()
    }
  }
  flushTools()
  // e.g. finish_reason=content_filter with no output, or a stream with no
  // message framing at all (gateway soft-failure) — surface both instead of an
  // empty success; a genuine empty turn still carries finish_reason=stop
  if (!emitted && abnormalFinish) {
    throw new Error(`The model returned no content (finish_reason=${abnormalFinish})`)
  }
  if (!emitted && !sawFinish) {
    throw new Error('The model returned no content (empty stream)')
  }
  if (stopReason) cb.onStopReason?.(stopReason)
}

/** route a streaming, tool-calling-capable turn by provider id */
export async function streamForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const baseUrl = PROVIDER_BASE_URLS[provider]
  if (!baseUrl) throw new Error(`Unknown provider: ${provider}`)
  return streamOpenAiCompatible(
    baseUrl,
    config,
    system,
    messages,
    tools,
    maxTokens,
    cb,
    // deepseek-chat/reasoner reject image_url parts with 400
    providerSupportsVision(provider, config.model),
  )
}
