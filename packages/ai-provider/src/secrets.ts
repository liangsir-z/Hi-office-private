/**
 * At-rest secret protection for ai-settings.json.
 *
 * API keys are the only secrets in AiSettings (provider apiKeys + the
 * imageGen apiKey). The walk functions below are pure: the actual
 * encrypt/decrypt primitives are injected as a SecretCodec, so the module
 * stays Electron-free and unit-testable. The Electron main processes build
 * the codec with makeSafeStorageCodec(safeStorage).
 */

export interface SecretCodec {
  /** encrypt a plaintext secret for storage; '' stays '' */
  encrypt(plain: string): string
  /** decrypt a stored secret; values the codec doesn't recognize pass through unchanged */
  decrypt(stored: string): string
}

/** Prefix marking an encrypted value ("enc1" leaves room for format bumps). */
const ENC_PREFIX = 'enc1:'

const SECRET_FIELDS = ['apiKey'] as const

function mapSecrets<T>(value: T, fn: (secret: string) => string): T {
  if (value === null || typeof value !== 'object') return value
  const out = { ...(value as object) } as Record<string, unknown>
  const providers = out.providers
  if (providers && typeof providers === 'object') {
    const mapped: Record<string, unknown> = {}
    for (const [id, config] of Object.entries(providers as Record<string, unknown>)) {
      mapped[id] = config && typeof config === 'object' ? withSecretFields(config, fn) : config
    }
    out.providers = mapped
  }
  const imageGen = out.imageGen
  if (imageGen && typeof imageGen === 'object') {
    out.imageGen = withSecretFields(imageGen, fn)
  }
  return out as T
}

function withSecretFields(config: object, fn: (secret: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const field of SECRET_FIELDS) {
    if (typeof out[field] === 'string') out[field] = fn(out[field] as string)
  }
  return out
}

/** Deep-ish copy with every providers[*].apiKey / imageGen.apiKey encrypted. */
export function encodeSettingsSecrets<T>(settings: T, codec: SecretCodec): T {
  return mapSecrets(settings, (plain) => (plain ? codec.encrypt(plain) : plain))
}

/**
 * Reverse of encodeSettingsSecrets. Legacy plaintext files decode
 * transparently (values without the codec's marker pass through); the next
 * save re-encrypts them.
 */
export function decodeSettingsSecrets<T>(stored: T, codec: SecretCodec): T {
  return mapSecrets(stored, (value) => codec.decrypt(value))
}

/** Subset of Electron's safeStorage used here (keeps the factory testable). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Codec backed by Electron safeStorage (OS keychain). Degrades to plaintext
 * passthrough when safeStorage is unavailable (non-Electron contexts, or a
 * machine without a keychain backend): encrypt writes the key as-is, and
 * enc1:-prefixed values — which can only have been written by a keychain
 * machine — decrypt to '' rather than leaking the ciphertext into a prompt.
 */
export function makeSafeStorageCodec(safeStorage: SafeStorageLike | null | undefined): SecretCodec {
  const available = (): boolean => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
  return {
    encrypt(plain) {
      if (!plain || !available()) return plain
      try {
        return ENC_PREFIX + safeStorage!.encryptString(plain).toString('base64')
      } catch {
        return plain
      }
    },
    decrypt(stored) {
      if (!stored) return ''
      if (!stored.startsWith(ENC_PREFIX)) return stored
      try {
        if (!available()) return ''
        return safeStorage!.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
      } catch {
        // keychain mismatch (different machine/user) — treat as no key
        return ''
      }
    },
  }
}
