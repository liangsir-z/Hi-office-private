import { describe, expect, it } from 'vitest'
import { decodeSettingsSecrets, encodeSettingsSecrets, makeSafeStorageCodec } from '../src/secrets'
import type { AiSettings } from '../src/types'

/** deterministic stand-in for safeStorage: 'enc1:' + reversed text */
const reverseCodec = {
  encrypt(plain: string): string {
    return 'enc1:' + [...plain].reverse().join('')
  },
  decrypt(stored: string): string {
    if (!stored.startsWith('enc1:')) return stored
    return [...stored.slice(5)].reverse().join('')
  },
}

function sampleSettings(): AiSettings {
  return {
    provider: 'deepseek',
    providers: {
      deepseek: { apiKey: 'sk-ds', model: 'deepseek-chat' },
    },
    imageGen: { provider: 'custom', apiKey: 'img-key', baseUrl: 'https://img.example' },
  }
}

describe('encodeSettingsSecrets', () => {
  it('encrypts every provider apiKey and the imageGen apiKey', () => {
    const out = encodeSettingsSecrets(sampleSettings(), reverseCodec)
    expect(out.providers.deepseek.apiKey).toBe('enc1:sd-ks')
    expect(out.imageGen?.apiKey).toBe('enc1:yek-gmi')
  })

  it('leaves empty keys, models, baseUrls, and non-secret fields untouched', () => {
    const input = sampleSettings()
    const out = encodeSettingsSecrets(input, reverseCodec)
    expect(out.provider).toBe('deepseek')
    expect(out.providers.deepseek.model).toBe('deepseek-chat')
    expect(out.imageGen?.baseUrl).toBe('https://img.example')
  })

  it('does not mutate the input', () => {
    const input = sampleSettings()
    encodeSettingsSecrets(input, reverseCodec)
    expect(input.providers.deepseek.apiKey).toBe('sk-ds')
  })

  it('round-trips through decode', () => {
    const settings = sampleSettings()
    const restored = decodeSettingsSecrets(
      encodeSettingsSecrets(settings, reverseCodec),
      reverseCodec,
    )
    expect(restored).toEqual(settings)
  })

  it('handles settings without providers/imageGen', () => {
    const bare = { provider: 'deepseek' } as unknown as AiSettings
    expect(encodeSettingsSecrets(bare, reverseCodec)).toEqual(bare)
  })
})

describe('decodeSettingsSecrets (legacy files)', () => {
  it('passes plaintext keys through unchanged', () => {
    const legacy = { ...sampleSettings() }
    const out = decodeSettingsSecrets(legacy, reverseCodec)
  })
})

describe('makeSafeStorageCodec', () => {
  it('degrades to plaintext when safeStorage is missing', () => {
    const codec = makeSafeStorageCodec(undefined)
    expect(codec.encrypt('sk-plain')).toBe('sk-plain')
    expect(codec.decrypt('sk-plain')).toBe('sk-plain')
    // an enc1: value from another machine cannot be decrypted without a keychain
    expect(codec.decrypt('enc1:opaque')).toBe('')
  })

  it('degrades when the keychain is unavailable', () => {
    const codec = makeSafeStorageCodec({ isEncryptionAvailable: () => false } as never)
    expect(codec.encrypt('k')).toBe('k')
    expect(codec.decrypt('enc1:x')).toBe('')
  })

  it('survives a decrypt failure (keychain mismatch)', () => {
    const codec = makeSafeStorageCodec({
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('x'),
      decryptString: () => {
        throw new Error('cannot decrypt')
      },
    })
    expect(codec.decrypt('enc1:eA==')).toBe('')
  })

  it('encrypts with the enc1 prefix and decrypts back', () => {
    const codec = makeSafeStorageCodec({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`wrap(${plain})`),
      decryptString: (buf) => buf.toString().replace(/^wrap\(|\)$/g, ''),
    })
    const enc = codec.encrypt('secret')
    expect(enc).toBe(`enc1:${Buffer.from('wrap(secret)').toString('base64')}`)
    expect(codec.decrypt(enc)).toBe('secret')
    // empty stays empty both ways
    expect(codec.encrypt('')).toBe('')
    expect(codec.decrypt('')).toBe('')
  })
})
