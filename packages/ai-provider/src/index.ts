export type {
  AiChatRequest,
  AiChatResponse,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  ImageGenConfig,
  ImageGenProvider,
  LegacyAiSettings,
} from './types'
export {
  AI_PROVIDERS,
  defaultAiSettings,
  PROVIDER_BASE_URLS,
  providerSupportsVision,
  resolveAiSettings,
} from './providers'
export {
  decodeSettingsSecrets,
  encodeSettingsSecrets,
  makeSafeStorageCodec,
} from './secrets'
export type { SafeStorageLike, SecretCodec } from './secrets'
export { chatForProvider } from './chat'
export { AiCreditsError, sseLines, streamForProvider } from './stream'
export type { StreamCallbacks } from './stream'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiTimeoutError,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'
