import { httpBodyDetail } from './http-error'
import type { AiChatResponse, AiProviderConfig, AiProviderId } from './types'
import { PROVIDER_BASE_URLS } from './providers'
import { AI_CHAT_RESPONSE_TIMEOUT_MS, createStreamWatchdog, type StreamWatchdog } from './watchdog'

async function chatOpenAiCompatible(
  wd: StreamWatchdog,
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  user: string,
): Promise<AiChatResponse> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: wd.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
    }),
  })
  wd.touch()
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}: ${httpBodyDetail(await response.text())}` }
  }
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content
  if (!content) return { ok: false, error: 'AI returned an empty response' }
  return { ok: true, content }
}

/** route a one-shot (non-streaming, non-tool-calling) chat call by provider id */
export async function chatForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<AiChatResponse> {
  // non-streaming: the server generates the full answer before the headers arrive,
  // so the connect phase gets the long budget; the body read then gets the idle budget
  const wd = createStreamWatchdog(signal, AI_CHAT_RESPONSE_TIMEOUT_MS)
  return wd.guard(() => {
    const baseUrl = PROVIDER_BASE_URLS[provider]
    if (!baseUrl)
      return Promise.resolve({ ok: false as const, error: `Unknown provider: ${provider}` })
    return chatOpenAiCompatible(wd, baseUrl, config, system, user)
  })
}
