/**
 * voice-mode — pure request validation and script detection for the Host half.
 *
 * Every rule here is a pure function over already-read bytes/JSON so
 * `node --test test/host.test.mjs` covers the wire contract without a harness,
 * a model, or an audio device. `index.js` converts the thrown
 * {@link ValidationError} into the HTTP status it carries.
 */

/** Longest text one `/voice-mode/speak` request may carry (chars, after trim). */
export const MAX_SPEAK_TEXT_CHARS = 2000;

/** Language overrides accepted by `/voice-mode/speak` (`auto` selects by script). */
export const SPEAK_LANGUAGES = ['auto', 'en', 'en-us', 'en-gb', 'zh', 'ja', 'ko'];

/** Kokoro speaker id bounds (54 voices, ids 0..53). */
export const SID_MIN = 0;
export const SID_MAX = 53;

/** Playback speed bounds accepted by the TTS engine. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

/** Hangul syllables, conjoining jamo, and compatibility jamo. */
const HANGUL_PATTERN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3\ua960-\ua97f\ud7b0-\ud7ff]/u;

/** Hiragana and katakana, including half-width katakana and their extensions. */
const KANA_PATTERN = /[\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fd-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u;

/** CJK unified ideographs (BMP, extension A, and compatibility ideographs). */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** Any Unicode letter or number: the minimum for text worth speaking. */
const SPEAKABLE_PATTERN = /[\p{L}\p{N}]/u;

/**
 * A request rejected before any engine work; carries the HTTP status to send.
 */
export class ValidationError extends Error {
  /**
   * @param {string} code - stable machine-readable reason.
   * @param {string} message - human-readable detail.
   * @param {{ status?: number, hint?: string, cause?: unknown }} [options] - HTTP status, caller hint, cause.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ValidationError';
    this.code = code;
    this.status = options.status ?? 400;
    this.hint = options.hint;
  }
}

/**
 * Classify the dominant script of a text so TTS can choose an engine and voice.
 * Hangul wins over kana, kana over ideographs, so mixed Japanese (kana + kanji)
 * reads as Japanese and mixed Chinese reads as Chinese.
 * @param {unknown} text - candidate text.
 * @returns {'hangul' | 'kana' | 'cjk' | 'latin'} dominant script family.
 */
export function detectScript(text) {
  const value = typeof text === 'string' ? text : '';
  if (HANGUL_PATTERN.test(value)) return 'hangul';
  if (KANA_PATTERN.test(value)) return 'kana';
  if (CJK_PATTERN.test(value)) return 'cjk';
  return 'latin';
}

/**
 * Whether a text contains at least one speakable letter or digit.
 * @param {unknown} text - candidate text.
 * @returns {boolean} false for emoji-only, punctuation-only, and empty text.
 */
export function hasSpeakableChars(text) {
  return typeof text === 'string' && SPEAKABLE_PATTERN.test(text);
}

/**
 * Parse a request body as a JSON object.
 * @param {string} raw - decoded request body text.
 * @returns {Record<string, unknown>} the parsed object.
 * @throws {ValidationError} on empty, invalid, or non-object JSON.
 */
export function parseJsonObject(raw) {
  if (typeof raw !== 'string') throw new ValidationError('invalid-json', 'Request body must be JSON text');
  const trimmed = raw.trim();
  if (trimmed === '') throw new ValidationError('empty-body', 'Request body must be a JSON object');
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new ValidationError('invalid-json', 'Request body is not valid JSON', { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('invalid-json', 'Request body must be a JSON object');
  }
  return value;
}

/**
 * Validate and normalise the `/voice-mode/speak` request body.
 * @param {unknown} body - parsed JSON body.
 * @returns {{text: string, sid?: number, speed: number, lang?: string}} engine input.
 * @throws {ValidationError} for an empty/too-long/unspeakable text or a bad sid, speed, or lang.
 */
export function normalizeSpeakRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('invalid-json', 'Request body must be a JSON object', { hint: 'POST {"text":"..."}' });
  }
  const rawText = body.text;
  if (typeof rawText !== 'string') {
    throw new ValidationError('empty-text', 'text must be a non-empty string', { hint: 'POST {"text":"..."}' });
  }
  const text = rawText.replace(/\s+/gu, ' ').trim();
  if (text === '') {
    throw new ValidationError('empty-text', 'text must be a non-empty string', { hint: 'POST {"text":"..."}' });
  }
  if (text.length > MAX_SPEAK_TEXT_CHARS) {
    throw new ValidationError(
      'text-too-long',
      `text exceeds ${MAX_SPEAK_TEXT_CHARS} characters`,
      { hint: 'Speak one sentence (or a short paragraph) per request' },
    );
  }
  if (!hasSpeakableChars(text)) {
    throw new ValidationError('unspeakable-text', 'text contains no letters or digits to speak');
  }

  let sid;
  if (body.sid !== undefined && body.sid !== null) {
    if (typeof body.sid !== 'number' || !Number.isInteger(body.sid) || body.sid < SID_MIN || body.sid > SID_MAX) {
      throw new ValidationError('invalid-sid', `sid must be an integer between ${SID_MIN} and ${SID_MAX}`);
    }
    sid = body.sid;
  }

  let speed = 1;
  if (body.speed !== undefined && body.speed !== null) {
    if (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < SPEED_MIN || body.speed > SPEED_MAX) {
      throw new ValidationError('invalid-speed', `speed must be a number between ${SPEED_MIN} and ${SPEED_MAX}`);
    }
    speed = body.speed;
  }

  let lang;
  if (body.lang !== undefined && body.lang !== null) {
    const value = typeof body.lang === 'string' ? body.lang.trim().toLowerCase() : '';
    if (!SPEAK_LANGUAGES.includes(value)) {
      throw new ValidationError('invalid-lang', `lang must be one of ${SPEAK_LANGUAGES.join(', ')}`);
    }
    lang = value;
  }

  return { text, ...(sid === undefined ? {} : { sid }), speed, ...(lang === undefined ? {} : { lang }) };
}

/**
 * Read the optional language hint from a transcribe request URL.
 * @param {URLSearchParams} searchParams - parsed query string.
 * @returns {{language?: string}} a lower-case hint, or nothing to let the harness default apply.
 * @throws {ValidationError} when the hint is not a short language code.
 */
export function normalizeTranscribeQuery(searchParams) {
  const raw = searchParams?.get?.('lang') ?? searchParams?.get?.('language') ?? '';
  const language = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (language === '' || language === 'auto') return {};
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(language)) {
    throw new ValidationError('invalid-lang', 'lang must be a short language code such as en or ko', { hint: 'accepted: auto, zh, en, yue, ja, ko' });
  }
  return { language };
}

/**
 * Match a language hint to the selected provider's accepted list, trying the
 * base code for a region variant (`en-us` -> `en`).
 * @param {string | undefined} language - requested hint.
 * @param {readonly string[] | undefined} accepted - provider-advertised languages.
 * @returns {string | undefined} accepted hint, or undefined when none was requested.
 * @throws {ValidationError} when the provider does not accept the hint.
 */
export function coerceProviderLanguage(language, accepted) {
  if (language === undefined) return undefined;
  if (!Array.isArray(accepted) || accepted.length === 0) return language;
  if (accepted.includes(language)) return language;
  const base = language.split('-')[0];
  if (accepted.includes(base)) return base;
  throw new ValidationError(
    'unsupported-language',
    `Speech provider does not support language: ${language}`,
    { hint: `accepted: ${accepted.join(', ')}` },
  );
}
