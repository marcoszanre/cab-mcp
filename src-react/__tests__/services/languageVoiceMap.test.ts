import { describe, it, expect } from 'vitest'
import {
  getVoiceForLanguage,
  extractLanguageFromVoice,
  voiceSupportsStyles,
  getVoicesForLocale,
  getSupportedLanguages,
  AZURE_VOICES_MULTILANG,
  SUPPORTED_LANGUAGES,
} from '@/lib/languageVoiceMap'

describe('languageVoiceMap', () => {
  describe('getVoiceForLanguage', () => {
    it('returns a voice for exact locale match', () => {
      const result = getVoiceForLanguage('it-IT')
      expect(result).not.toBeNull()
      expect(result!.locale).toBe('it-IT')
      expect(result!.voiceName).toContain('it-IT')
    })

    it('returns a voice for case-insensitive match', () => {
      const result = getVoiceForLanguage('IT-it')
      expect(result).not.toBeNull()
      expect(result!.locale).toBe('it-IT')
    })

    it('returns a voice for language prefix match', () => {
      const result = getVoiceForLanguage('fr')
      expect(result).not.toBeNull()
      expect(result!.locale).toBe('fr-FR')
      expect(result!.voiceName).toContain('fr-FR')
    })

    it('returns null for unknown language', () => {
      expect(getVoiceForLanguage('xx-YY')).toBeNull()
    })

    it('returns en-US voice for "en-US"', () => {
      const result = getVoiceForLanguage('en-US')
      expect(result).not.toBeNull()
      // HD voices are listed first, so the default is now Ava HD
      expect(result!.voiceName).toBe('en-US-Ava:DragonHDLatestNeural')
    })

    it('returns correct voices for major languages', () => {
      const langs = ['de-DE', 'es-ES', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN']
      for (const lang of langs) {
        const result = getVoiceForLanguage(lang)
        expect(result).not.toBeNull()
        expect(result!.locale).toBe(lang)
      }
    })
  })

  describe('extractLanguageFromVoice', () => {
    it('extracts locale from standard voice name', () => {
      expect(extractLanguageFromVoice('en-US-JennyNeural')).toBe('en-US')
      expect(extractLanguageFromVoice('it-IT-ElsaNeural')).toBe('it-IT')
      expect(extractLanguageFromVoice('zh-CN-XiaoxiaoNeural')).toBe('zh-CN')
    })

    it('returns en-US for malformed voice name', () => {
      expect(extractLanguageFromVoice('invalid')).toBe('en-US')
    })
  })

  describe('voiceSupportsStyles', () => {
    it('returns true for English US voices that support styles', () => {
      expect(voiceSupportsStyles('en-US-JennyNeural')).toBe(true)
      expect(voiceSupportsStyles('en-US-AriaNeural')).toBe(true)
    })

    it('returns false for non-English voices', () => {
      expect(voiceSupportsStyles('it-IT-ElsaNeural')).toBe(false)
      expect(voiceSupportsStyles('fr-FR-DeniseNeural')).toBe(false)
    })

    it('returns false for unknown voices', () => {
      expect(voiceSupportsStyles('xx-XX-UnknownNeural')).toBe(false)
    })
  })

  describe('getVoicesForLocale', () => {
    it('returns multiple voices for en-US', () => {
      const voices = getVoicesForLocale('en-US')
      expect(voices.length).toBeGreaterThanOrEqual(2)
      expect(voices.every(v => v.locale === 'en-US')).toBe(true)
    })

    it('returns voices for it-IT', () => {
      const voices = getVoicesForLocale('it-IT')
      expect(voices.length).toBeGreaterThanOrEqual(1)
      expect(voices[0].locale).toBe('it-IT')
    })

    it('returns empty array for unknown locale', () => {
      expect(getVoicesForLocale('xx-YY')).toHaveLength(0)
    })
  })

  describe('getSupportedLanguages', () => {
    it('returns a non-empty list of supported languages', () => {
      const langs = getSupportedLanguages()
      expect(langs.length).toBeGreaterThan(10)
    })

    it('includes en-US and it-IT', () => {
      const langs = getSupportedLanguages()
      expect(langs.some(l => l.code === 'en-US')).toBe(true)
      expect(langs.some(l => l.code === 'it-IT')).toBe(true)
    })
  })

  describe('data integrity', () => {
    it('every voice in AZURE_VOICES_MULTILANG has a corresponding supported language', () => {
      const langCodes = new Set(SUPPORTED_LANGUAGES.map(l => l.code))
      for (const voice of AZURE_VOICES_MULTILANG) {
        expect(langCodes.has(voice.locale)).toBe(true)
      }
    })

    it('every supported language has at least one voice', () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const voices = getVoicesForLocale(lang.code)
        expect(voices.length).toBeGreaterThanOrEqual(1)
      }
    })
  })
})
