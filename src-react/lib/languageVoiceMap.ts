// Language-to-Voice Mapping Utility
// Maps BCP-47 language codes to Azure Neural TTS voices

export interface LanguageVoiceEntry {
  voiceName: string
  label: string
  locale: string
  gender: 'Female' | 'Male'
  /** Whether this voice supports mstts:express-as styles */
  supportsStyles: boolean
  /** Voice quality tier: 'hd' for Dragon HD voices, 'standard' for regular Neural */
  tier: 'hd' | 'standard'
}

export interface SupportedLanguage {
  code: string
  label: string
  flag: string
}

/**
 * Multi-language Azure Neural voices grouped by locale.
 * Each locale has a primary (female) and secondary (male) voice.
 */
export const AZURE_VOICES_MULTILANG: LanguageVoiceEntry[] = [
  // English (US) - HD
  { voiceName: 'en-US-Ava:DragonHDLatestNeural', label: '✨ Ava HD (English US, Female)', locale: 'en-US', gender: 'Female', supportsStyles: true, tier: 'hd' },
  { voiceName: 'en-US-Emma:DragonHDLatestNeural', label: '✨ Emma HD (English US, Female)', locale: 'en-US', gender: 'Female', supportsStyles: true, tier: 'hd' },
  { voiceName: 'en-US-Andrew:DragonHDLatestNeural', label: '✨ Andrew HD (English US, Male)', locale: 'en-US', gender: 'Male', supportsStyles: true, tier: 'hd' },
  { voiceName: 'en-US-Brian:DragonHDLatestNeural', label: '✨ Brian HD (English US, Male)', locale: 'en-US', gender: 'Male', supportsStyles: true, tier: 'hd' },
  { voiceName: 'en-US-Adam:DragonHDLatestNeural', label: '✨ Adam HD (English US, Male)', locale: 'en-US', gender: 'Male', supportsStyles: true, tier: 'hd' },
  // English (US)
  { voiceName: 'en-US-JennyNeural', label: 'Jenny (English US, Female)', locale: 'en-US', gender: 'Female', supportsStyles: true, tier: 'standard' },
  { voiceName: 'en-US-AriaNeural', label: 'Aria (English US, Female)', locale: 'en-US', gender: 'Female', supportsStyles: true, tier: 'standard' },
  { voiceName: 'en-US-GuyNeural', label: 'Guy (English US, Male)', locale: 'en-US', gender: 'Male', supportsStyles: true, tier: 'standard' },
  { voiceName: 'en-US-DavisNeural', label: 'Davis (English US, Male)', locale: 'en-US', gender: 'Male', supportsStyles: true, tier: 'standard' },
  // English (UK) - HD
  { voiceName: 'en-GB-Libby:DragonHDLatestNeural', label: '✨ Libby HD (English UK, Female)', locale: 'en-GB', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // English (UK)
  { voiceName: 'en-GB-SoniaNeural', label: 'Sonia (English UK, Female)', locale: 'en-GB', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'en-GB-RyanNeural', label: 'Ryan (English UK, Male)', locale: 'en-GB', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Italian
  { voiceName: 'it-IT-ElsaNeural', label: 'Elsa (Italian, Female)', locale: 'it-IT', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'it-IT-DiegoNeural', label: 'Diego (Italian, Male)', locale: 'it-IT', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // French - HD
  { voiceName: 'fr-FR-Vivienne:DragonHDLatestNeural', label: '✨ Vivienne HD (French, Female)', locale: 'fr-FR', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // French
  { voiceName: 'fr-FR-DeniseNeural', label: 'Denise (French, Female)', locale: 'fr-FR', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'fr-FR-HenriNeural', label: 'Henri (French, Male)', locale: 'fr-FR', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // German - HD
  { voiceName: 'de-DE-Seraphina:DragonHDLatestNeural', label: '✨ Seraphina HD (German, Female)', locale: 'de-DE', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // German
  { voiceName: 'de-DE-KatjaNeural', label: 'Katja (German, Female)', locale: 'de-DE', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'de-DE-ConradNeural', label: 'Conrad (German, Male)', locale: 'de-DE', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Spanish (Spain) - HD
  { voiceName: 'es-ES-Arabella:DragonHDLatestNeural', label: '✨ Arabella HD (Spanish, Female)', locale: 'es-ES', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // Spanish (Spain)
  { voiceName: 'es-ES-ElviraNeural', label: 'Elvira (Spanish, Female)', locale: 'es-ES', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'es-ES-AlvaroNeural', label: 'Alvaro (Spanish, Male)', locale: 'es-ES', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Spanish (Mexico)
  { voiceName: 'es-MX-DaliaNeural', label: 'Dalia (Spanish MX, Female)', locale: 'es-MX', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'es-MX-JorgeNeural', label: 'Jorge (Spanish MX, Male)', locale: 'es-MX', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Portuguese (Brazil) - HD
  { voiceName: 'pt-BR-Thalita:DragonHDLatestNeural', label: '✨ Thalita HD (Portuguese BR, Female)', locale: 'pt-BR', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // Portuguese (Brazil)
  { voiceName: 'pt-BR-FranciscaNeural', label: 'Francisca (Portuguese BR, Female)', locale: 'pt-BR', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'pt-BR-AntonioNeural', label: 'Antonio (Portuguese BR, Male)', locale: 'pt-BR', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Portuguese (Portugal)
  { voiceName: 'pt-PT-RaquelNeural', label: 'Raquel (Portuguese PT, Female)', locale: 'pt-PT', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'pt-PT-DuarteNeural', label: 'Duarte (Portuguese PT, Male)', locale: 'pt-PT', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Japanese - HD
  { voiceName: 'ja-JP-Masaru:DragonHDLatestNeural', label: '✨ Masaru HD (Japanese, Male)', locale: 'ja-JP', gender: 'Male', supportsStyles: true, tier: 'hd' },
  // Japanese
  { voiceName: 'ja-JP-NanamiNeural', label: 'Nanami (Japanese, Female)', locale: 'ja-JP', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'ja-JP-KeitaNeural', label: 'Keita (Japanese, Male)', locale: 'ja-JP', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Korean
  { voiceName: 'ko-KR-SunHiNeural', label: 'SunHi (Korean, Female)', locale: 'ko-KR', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'ko-KR-InJoonNeural', label: 'InJoon (Korean, Male)', locale: 'ko-KR', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Chinese (Mandarin) - HD
  { voiceName: 'zh-CN-Xiaochen:DragonHDLatestNeural', label: '✨ Xiaochen HD (Chinese CN, Female)', locale: 'zh-CN', gender: 'Female', supportsStyles: true, tier: 'hd' },
  // Chinese (Mandarin)
  { voiceName: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (Chinese CN, Female)', locale: 'zh-CN', gender: 'Female', supportsStyles: true, tier: 'standard' },
  { voiceName: 'zh-CN-YunxiNeural', label: 'Yunxi (Chinese CN, Male)', locale: 'zh-CN', gender: 'Male', supportsStyles: true, tier: 'standard' },
  // Dutch
  { voiceName: 'nl-NL-ColetteNeural', label: 'Colette (Dutch, Female)', locale: 'nl-NL', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'nl-NL-MaartenNeural', label: 'Maarten (Dutch, Male)', locale: 'nl-NL', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Polish
  { voiceName: 'pl-PL-AgnieszkaNeural', label: 'Agnieszka (Polish, Female)', locale: 'pl-PL', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'pl-PL-MarekNeural', label: 'Marek (Polish, Male)', locale: 'pl-PL', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Russian
  { voiceName: 'ru-RU-SvetlanaNeural', label: 'Svetlana (Russian, Female)', locale: 'ru-RU', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'ru-RU-DmitryNeural', label: 'Dmitry (Russian, Male)', locale: 'ru-RU', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Arabic
  { voiceName: 'ar-SA-ZariyahNeural', label: 'Zariyah (Arabic, Female)', locale: 'ar-SA', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'ar-SA-HamedNeural', label: 'Hamed (Arabic, Male)', locale: 'ar-SA', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Hindi
  { voiceName: 'hi-IN-SwaraNeural', label: 'Swara (Hindi, Female)', locale: 'hi-IN', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'hi-IN-MadhurNeural', label: 'Madhur (Hindi, Male)', locale: 'hi-IN', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Turkish
  { voiceName: 'tr-TR-EmelNeural', label: 'Emel (Turkish, Female)', locale: 'tr-TR', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'tr-TR-AhmetNeural', label: 'Ahmet (Turkish, Male)', locale: 'tr-TR', gender: 'Male', supportsStyles: false, tier: 'standard' },
  // Swedish
  { voiceName: 'sv-SE-SofieNeural', label: 'Sofie (Swedish, Female)', locale: 'sv-SE', gender: 'Female', supportsStyles: false, tier: 'standard' },
  { voiceName: 'sv-SE-MattiasNeural', label: 'Mattias (Swedish, Male)', locale: 'sv-SE', gender: 'Male', supportsStyles: false, tier: 'standard' },
]

/** Default voice per locale (first female voice) */
const DEFAULT_VOICE_BY_LOCALE: Record<string, string> = {}
for (const v of AZURE_VOICES_MULTILANG) {
  if (!DEFAULT_VOICE_BY_LOCALE[v.locale]) {
    DEFAULT_VOICE_BY_LOCALE[v.locale] = v.voiceName
  }
}

/** Supported languages for UI dropdowns and ACS caption configuration */
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧' },
  { code: 'it-IT', label: 'Italian', flag: '🇮🇹' },
  { code: 'fr-FR', label: 'French', flag: '🇫🇷' },
  { code: 'de-DE', label: 'German', flag: '🇩🇪' },
  { code: 'es-ES', label: 'Spanish (Spain)', flag: '🇪🇸' },
  { code: 'es-MX', label: 'Spanish (Mexico)', flag: '🇲🇽' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', flag: '🇵🇹' },
  { code: 'ja-JP', label: 'Japanese', flag: '🇯🇵' },
  { code: 'ko-KR', label: 'Korean', flag: '🇰🇷' },
  { code: 'zh-CN', label: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'nl-NL', label: 'Dutch', flag: '🇳🇱' },
  { code: 'pl-PL', label: 'Polish', flag: '🇵🇱' },
  { code: 'ru-RU', label: 'Russian', flag: '🇷🇺' },
  { code: 'ar-SA', label: 'Arabic', flag: '🇸🇦' },
  { code: 'hi-IN', label: 'Hindi', flag: '🇮🇳' },
  { code: 'tr-TR', label: 'Turkish', flag: '🇹🇷' },
  { code: 'sv-SE', label: 'Swedish', flag: '🇸🇪' },
]

/**
 * Get the best default voice for a given BCP-47 language code.
 * Matches exact locale first, then language prefix (e.g., 'it' matches 'it-IT').
 */
export function getVoiceForLanguage(lang: string): { voiceName: string; locale: string } | null {
  const normalized = lang.trim()

  // Exact locale match
  if (DEFAULT_VOICE_BY_LOCALE[normalized]) {
    return { voiceName: DEFAULT_VOICE_BY_LOCALE[normalized], locale: normalized }
  }

  // Case-insensitive match
  const lower = normalized.toLowerCase()
  for (const [locale, voice] of Object.entries(DEFAULT_VOICE_BY_LOCALE)) {
    if (locale.toLowerCase() === lower) {
      return { voiceName: voice, locale }
    }
  }

  // Language prefix match (e.g., 'it' → 'it-IT', 'en' → 'en-US')
  const prefix = lower.split('-')[0]
  for (const [locale, voice] of Object.entries(DEFAULT_VOICE_BY_LOCALE)) {
    if (locale.toLowerCase().startsWith(prefix + '-')) {
      return { voiceName: voice, locale }
    }
  }

  return null
}

/**
 * Extract the locale from an Azure voice name (e.g., 'en-US-JennyNeural' → 'en-US').
 */
export function extractLanguageFromVoice(voiceName: string): string {
  const parts = voiceName.split('-')
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`
  }
  return 'en-US'
}

/**
 * Check if a voice supports mstts:express-as speaking styles.
 */
export function voiceSupportsStyles(voiceName: string): boolean {
  const entry = AZURE_VOICES_MULTILANG.find(v => v.voiceName === voiceName)
  return entry?.supportsStyles ?? false
}

/**
 * Check if a voice is a Dragon HD (high-definition) voice.
 */
export function isHDVoice(voiceName: string): boolean {
  const entry = AZURE_VOICES_MULTILANG.find(v => v.voiceName === voiceName)
  return entry?.tier === 'hd'
}

/**
 * Get voices filtered by locale.
 */
export function getVoicesForLocale(locale: string): LanguageVoiceEntry[] {
  return AZURE_VOICES_MULTILANG.filter(v => v.locale === locale)
}

/**
 * Get all supported languages for UI dropdowns.
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return SUPPORTED_LANGUAGES
}
