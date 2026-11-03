/**
 * voice-mode — optional local `whisper.cpp` HTTP provider for speech-to-text.
 *
 * The harness's only built-in local provider is SenseVoice (int8 ONNX). For
 * accented English that model mishears a lot of words, so this provider lets the
 * Host route the same canonical 16 kHz mono PCM16 WAV recording to a local
 * `whisper-server` speaking the OpenAI transcription protocol
 * (`POST /v1/audio/transcriptions`) — for example whisper.cpp's server with a
 * large-v3-turbo GGML model on `127.0.0.1:2023`.
 *
 * Strictly loopback, like the Kokoro provider: a non-loopback base URL disables
 * the provider instead of sending audio to a remote service. When the service is
 * not running the caller keeps the harness provider as the fallback, so a
 * missing whisper-server is never an error the user has to see.
 */

/** Loopback endpoint of the local whisper.cpp server. */
export const DEFAULT_WHISPER_HTTP_BASE_URL = 'http://127.0.0.1:2023';

/** Model name sent in the form; whisper.cpp ignores it, other servers need one. */
export const DEFAULT_WHISPER_HTTP_MODEL = 'whisper-1';

/**
 * Language hint. English is the conversation language on this machine, and an
 * explicit hint stops a short mumbling utterance from being auto-detected as
 * another language. `VOICE_MODE_WHISPER_LANGUAGE=auto` restores auto-detection.
 */
export const DEFAULT_WHISPER_HTTP_LANGUAGE = 'en';

/**
 * Prompt biasing. whisper.cpp accepts a `prompt` form field and uses it to spell
 * domain words the acoustic model would otherwise mangle (proper nouns, product
 * names, mixed-case identifiers).
 */
export const DEFAULT_WHISPER_HTTP_PROMPT =
  'Azizbek Umidjonov, career-ops, TechTree, FuriosaAI, Fieldguide, StackBlitz, DeepSeek, Anthropic, Cloudflare Workers, Hono, Spiko, Arbee, Brivva, OpenAI.';

/** Probe bound, ms. A dead loopback port fails in microseconds; a hung one must not stall status. */
const PROBE_TIMEOUT_MS = 1200;

/** One transcription round trip bound, ms. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** How long one successful/failed probe is trusted, ms. */
const READINESS_TTL_MS = 15_000;

/** A rejection carrying a stable code for the caller's fallback chain. */
export class WhisperHttpError extends Error {
  /**
   * @param {string} code - stable reason code.
   * @param {string} message - human-readable detail.
   * @param {{cause?: unknown}} [options] - optional cause.
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WhisperHttpError';
    this.code = code;
  }
}

/**
 * Only a loopback host is acceptable: this provider must never become a path to
 * a remote speech service.
 *
 * @param {string} value - candidate base URL.
 * @returns {string} normalized loopback base URL, or '' when explicitly disabled.
 * @throws {WhisperHttpError} when the value is invalid or not loopback.
 */
function requireLoopbackBaseUrl(value) {
  const text = String(value ?? '').trim();
  // An empty value disables the provider (used by tests and by an explicit opt-out).
  if (text === '') return '';
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new WhisperHttpError('whisper-http-invalid-url', `invalid whisper HTTP base URL: ${text}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WhisperHttpError('whisper-http-invalid-url', `whisper HTTP base URL must be http(s): ${url.href}`);
  }
  const host = url.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback) {
    throw new WhisperHttpError('whisper-http-not-loopback', `whisper HTTP base URL must be loopback, got ${host}`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Create the optional local whisper HTTP provider.
 *
 * @param {object} [options] - provider options.
 * @param {NodeJS.ProcessEnv} [options.env] - environment source.
 * @param {string} [options.baseUrl] - override base URL (loopback only).
 * @param {string} [options.model] - form model name.
 * @param {string} [options.language] - default language hint; `auto` omits it.
 * @param {string} [options.prompt] - biasing prompt; empty omits it.
 * @param {number} [options.timeoutMs] - override transcription timeout.
 * @param {typeof fetch} [options.fetch] - fetch implementation (tests).
 * @returns {{probe: Function, transcribe: Function, status: Function, baseUrl: string, model: string}} provider.
 */
export function createWhisperHttpProvider(options = {}) {
  const env = options.env ?? process.env;
  const configured = options.baseUrl ?? env.VOICE_MODE_WHISPER_HTTP ?? DEFAULT_WHISPER_HTTP_BASE_URL;
  let baseUrl;
  try {
    baseUrl = requireLoopbackBaseUrl(configured);
  } catch {
    baseUrl = '';
  }
  const model = String(options.model ?? env.VOICE_MODE_WHISPER_MODEL ?? DEFAULT_WHISPER_HTTP_MODEL);
  const language = String(options.language ?? env.VOICE_MODE_WHISPER_LANGUAGE ?? DEFAULT_WHISPER_HTTP_LANGUAGE);
  const prompt = String(options.prompt ?? env.VOICE_MODE_WHISPER_PROMPT ?? DEFAULT_WHISPER_HTTP_PROMPT);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : TRANSCRIBE_TIMEOUT_MS;
  const fetchFn = options.fetch ?? globalThis.fetch;

  let readiness = { at: 0, available: false, error: undefined };
  let inflight = null;

  const disabled = () => baseUrl === '';

  /**
   * Probe the service once per TTL. Any HTTP answer proves the port has a
   * listener; only a network error counts as unavailable, because different
   * whisper servers disagree on whether `/` returns 200 or 404.
   *
   * @param {boolean} [force] - ignore the cached result.
   * @returns {Promise<{at: number, available: boolean, error?: string}>} readiness.
   * @throws {WhisperHttpError} when the provider is disabled or unreachable.
   */
  async function probe(force = false) {
    if (disabled()) {
      throw new WhisperHttpError('whisper-http-disabled', 'whisper HTTP provider is disabled');
    }
    const now = Date.now();
    if (!force && now - readiness.at < READINESS_TTL_MS) {
      if (readiness.available) return readiness;
      throw new WhisperHttpError('whisper-http-unavailable', readiness.error ?? 'whisper HTTP service is not reachable');
    }
    if (inflight !== null) return inflight;
    inflight = (async () => {
      let timer;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const response = await fetchFn(`${baseUrl}/`, { signal: controller.signal });
        readiness = { at: Date.now(), available: true, error: undefined };
        void response;
        return readiness;
      } catch (error) {
        readiness = { at: Date.now(), available: false, error: String(error?.message ?? error) };
        throw new WhisperHttpError('whisper-http-unavailable', readiness.error, { cause: error });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * Transcribe one canonical WAV byte stream.
   *
   * @param {{audio: Uint8Array, language?: string, signal?: AbortSignal}} request - recording.
   * @returns {Promise<{text: string, language: string|null, inferenceSeconds: number|null}>} transcript.
   * @throws {WhisperHttpError} on a transport or protocol failure.
   */
  async function transcribe({ audio, language: languageHint, signal }) {
    await probe();
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
      throw new WhisperHttpError('whisper-http-empty-audio', 'recording is empty');
    }
    const wanted = String(languageHint ?? language ?? '').trim();
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (wanted !== '' && wanted !== 'auto') form.append('language', wanted);
    if (prompt.trim() !== '') form.append('prompt', prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal !== undefined) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const started = Date.now();
    try {
      const response = await fetchFn(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WhisperHttpError('whisper-http-failed', `whisper transcription failed: HTTP ${response.status}`);
      }
      const payload = await response.json();
      return {
        text: typeof payload?.text === 'string' ? payload.text.trim() : '',
        language: wanted !== '' && wanted !== 'auto' ? wanted : null,
        inferenceSeconds: (Date.now() - started) / 1000,
      };
    } catch (error) {
      if (error instanceof WhisperHttpError) throw error;
      // A dropped connection means the service went away: force a re-probe next time.
      readiness = { ...readiness, at: 0, available: false, error: String(error?.message ?? error) };
      throw new WhisperHttpError('whisper-http-failed', String(error?.message ?? error), { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  }

  /** Cheap readiness snapshot for `GET /voice-mode/status`. */
  async function status() {
    if (disabled()) return { available: false, baseUrl: null, error: 'disabled' };
    try {
      await probe();
      return { available: true, baseUrl, model, language: language === 'auto' ? null : language };
    } catch (error) {
      return { available: false, baseUrl, model, error: String(error?.message ?? error) };
    }
  }

  return { probe, transcribe, status, baseUrl, model };
}
