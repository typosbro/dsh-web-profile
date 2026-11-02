/**
 * voice-mode — optional local Kokoro HTTP provider.
 *
 * A `kokoro-fastapi` service already installed on this Mac (the VoiceMode MCP
 * setup puts one at `127.0.0.1:8880`) serves the fp32 Kokoro v1.0 weights on
 * Apple MPS. That is the same model family as the plugin's built-in engine but
 * without int8 quantisation and with GPU inference, so it sounds clearer and
 * synthesises faster.
 *
 * This provider speaks that service's OpenAI-compatible protocol
 * (`POST /v1/audio/speech`, `GET /v1/audio/voices`). It is strictly optional:
 * when the service is not running every call rejects with a tagged
 * `VoiceEngineError`-style code and the Host falls back to its built-in engine.
 * No request leaves the machine — the base URL is a loopback address and is
 * ignored for any non-loopback value.
 */

import { parseWav } from './wav.js';

/** Loopback endpoint of the local kokoro-fastapi service. */
export const DEFAULT_KOKORO_HTTP_BASE_URL = 'http://127.0.0.1:8880';

/** Voice used for Latin text unless configured otherwise (the one VoiceMode liked). */
export const DEFAULT_KOKORO_HTTP_VOICE = 'af_sky';

const PROBE_TIMEOUT_MS = 1500;
const SYNTH_TIMEOUT_MS = 30_000;
/** How long one successful/failed probe is trusted, ms. */
const READINESS_TTL_MS = 15_000;

/** Rejection carrying a machine-readable code for the caller's fallback chain. */
export class KokoroHttpError extends Error {
  /**
   * @param {string} code - stable reason code.
   * @param {string} message - human-readable detail.
   * @param {{cause?: unknown}} [options] - optional cause.
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'KokoroHttpError';
    this.code = code;
  }
}

/**
 * Only a loopback host is acceptable: this provider must never become a path
 * to a remote speech service.
 *
 * @param {string} value - candidate base URL.
 * @returns {string} normalized loopback base URL.
 * @throws {KokoroHttpError} when the value is invalid or not loopback.
 */
function requireLoopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch (error) {
    throw new KokoroHttpError('kokoro-http-invalid-url', `invalid Kokoro HTTP base URL: ${String(value)}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KokoroHttpError('kokoro-http-invalid-url', `Kokoro HTTP base URL must be http(s): ${url.href}`);
  }
  const host = url.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback) {
    throw new KokoroHttpError('kokoro-http-not-loopback', `Kokoro HTTP base URL must be loopback, got ${host}`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Create the optional local Kokoro HTTP provider.
 *
 * @param {object} [options] - provider options.
 * @param {NodeJS.ProcessEnv} [options.env] - environment source.
 * @param {string} [options.baseUrl] - override base URL (loopback only).
 * @param {string} [options.defaultVoice] - Latin-script voice id.
 * @param {string} [options.cjkVoice] - CJK-script voice id.
 * @param {string} [options.kanaVoice] - kana-script voice id.
 * @param {typeof fetch} [options.fetch] - fetch implementation (tests).
 * @returns {object} provider with probe/synthesize/status.
 */
export function createKokoroHttpProvider(options = {}) {
  const env = options.env ?? process.env;
  const configured = options.baseUrl ?? env.VOICE_MODE_KOKORO_HTTP ?? DEFAULT_KOKORO_HTTP_BASE_URL;
  let baseUrl;
  try {
    baseUrl = requireLoopbackBaseUrl(configured);
    // An empty base URL disables the provider entirely.
    if (String(configured).trim() === '') baseUrl = '';
  } catch {
    baseUrl = '';
  }
  const defaultVoice = String(options.defaultVoice ?? env.VOICE_MODE_KOKORO_HTTP_VOICE ?? DEFAULT_KOKORO_HTTP_VOICE);
  const voicesByScript = {
    latin: defaultVoice,
    cjk: String(options.cjkVoice ?? 'zf_xiaoxiao'),
    kana: String(options.kanaVoice ?? 'jf_alpha'),
  };
  const fetchFn = options.fetch ?? globalThis.fetch;

  let readiness = { at: 0, available: false, voices: [], sampleRate: 24000, error: undefined };
  let inflight = null;

  const disabled = () => baseUrl === '';

  /** Probe `/v1/audio/voices` once per TTL; concurrent callers share one probe. */
  async function probe(force = false) {
    if (disabled()) {
      throw new KokoroHttpError('kokoro-http-disabled', 'Kokoro HTTP provider is disabled');
    }
    const now = Date.now();
    if (!force && now - readiness.at < READINESS_TTL_MS) {
      if (readiness.available) return readiness;
      throw new KokoroHttpError('kokoro-http-unavailable', readiness.error ?? 'Kokoro HTTP service is not reachable');
    }
    if (inflight !== null) return inflight;
    inflight = (async () => {
      let timer;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const response = await fetchFn(`${baseUrl}/v1/audio/voices`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const voices = Array.isArray(payload?.voices) ? payload.voices : [];
        readiness = { at: Date.now(), available: true, voices, sampleRate: 24000, error: undefined };
        return readiness;
      } catch (error) {
        readiness = {
          at: Date.now(),
          available: false,
          voices: readiness.voices,
          sampleRate: readiness.sampleRate,
          error: String(error?.message ?? error),
        };
        throw new KokoroHttpError('kokoro-http-unavailable', readiness.error, { cause: error });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  /** Synthesize one sentence and return decoded samples. */
  async function synthesize({ text, speed = 1, script = 'latin' }) {
    const ready = await probe();
    const voice = voicesByScript[script] ?? defaultVoice;
    if (!ready.voices.includes(voice)) {
      throw new KokoroHttpError('kokoro-http-voice-missing', `Kokoro HTTP service has no voice ${voice}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          input: text,
          voice,
          response_format: 'wav',
          speed,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new KokoroHttpError('kokoro-http-failed', `Kokoro HTTP speak failed: HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parsed = parseWav(bytes);
      if (parsed.samples.length === 0) {
        throw new KokoroHttpError('kokoro-http-failed', 'Kokoro HTTP service returned no audio');
      }
      return {
        samples: parsed.samples,
        sampleRate: parsed.sampleRate,
        engine: 'kokoro-http',
        sid: null,
        voice,
        lang: script,
      };
    } catch (error) {
      if (error instanceof KokoroHttpError) throw error;
      // A dropped connection means the service went away: force a re-probe.
      readiness = { ...readiness, at: 0, available: false, error: String(error?.message ?? error) };
      throw new KokoroHttpError('kokoro-http-failed', String(error?.message ?? error), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cheap readiness snapshot for `GET /voice-mode/status`. */
  async function status() {
    if (disabled()) {
      return { available: false, baseUrl: null, error: 'disabled' };
    }
    try {
      const ready = await probe();
      return {
        available: true,
        baseUrl,
        defaultVoice,
        voices: ready.voices.length,
        voiceByScript: { ...voicesByScript },
      };
    } catch (error) {
      return { available: false, baseUrl, error: String(error?.message ?? error) };
    }
  }

  return { probe, synthesize, status, baseUrl, defaultVoice, voicesByScript };
}
