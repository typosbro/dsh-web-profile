/**
 * Language questions for the voice bridge.
 *
 * MVP is English only: everything goes to Kokoro (English) and whisper is
 * always told `language=en`. Hangul detection is kept because `tts.engine:
 * "auto"` can route Korean text to the macOS `say` voice as an optional
 * fallback; it is off by default.
 */

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

export function hasHangul(text) {
  return typeof text === 'string' && HANGUL.test(text);
}

/**
 * Pick the TTS engine for one utterance.
 *
 * - engine "kokoro" (default): everything through Kokoro, English only.
 * - engine "auto": Hangul -> macOS say (Korean), anything else -> Kokoro.
 */
export function pickTtsEngine(text, ttsConfig = {}) {
  const engine = ttsConfig.engine ?? 'kokoro';
  if (engine === 'auto' && hasHangul(text)) {
    return {
      engine: 'say',
      voice: ttsConfig.sayVoice ?? 'Yuna',
      language: 'ko',
    };
  }
  return {
    engine: 'kokoro',
    voice: ttsConfig.kokoroVoice ?? 'af_heart',
    language: 'en',
  };
}

/** Human-readable language of a transcript for logs (not used for routing). */
export function describeLanguage(language) {
  return language === 'ko' ? 'Korean' : language === 'en' ? 'English' : String(language ?? 'unknown');
}
