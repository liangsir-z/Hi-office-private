import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

export type AiProviderId = 'anthropic' | 'gemini' | 'deepseek' | 'openai' | 'custom'

export interface AiProviderConfig {
  apiKey: string
  model: string
  /** only used by the custom (OpenAI-compatible) provider */
  baseUrl?: string | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  /**
   * Whether the provider's chat models accept image input. When false,
   * inline image attachments are stripped before the request (the OpenAI-
   * compatible wire format's image_url part is rejected with HTTP 400 by
   * text-only backends such as DeepSeek).
   */
  vision?: boolean
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
  /**
   * [BYOK] Optional image-generation backend (used by Slides' generate_image tool).
   * Omit/leave provider empty to DISABLE image generation entirely — the tool
   * returns a friendly "not configured" error instead of calling Hi-office.
   * Fill in a provider + apiKey to route to a self-chosen cloud text-to-image API.
   */
  imageGen?: ImageGenConfig | undefined
  /**
   * [skills] Per-skill enable flags, keyed by skill directory name. A skill is
   * loaded only when this map has `true` for its dir; absence defaults to ENABLED
   * (so freshly-dropped skills work without a settings round-trip). Setting
   * `false` disables a skill without deleting its files.
   */
  skills?: Record<string, boolean> | undefined
}

/** Identity of an image-generation backend. Extend as more providers are wired in. */
export type ImageGenProvider = 'aliyun-wanx' | 'volcengine-jimeng' | 'custom'

export interface ImageGenConfig {
  /** empty/'none' = disabled. When set, the generate_image tool calls this backend. */
  provider: ImageGenProvider | 'none'
  apiKey: string
  /** endpoint base url (custom provider) or model id (cloud providers), backend-specific */
  model?: string | undefined
  baseUrl?: string | undefined
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one */
  type: 'delta' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause ('timeout', exhausted 'credits'); lets the renderer localize the message */
  errorCode?: 'timeout' | 'credits'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
}
