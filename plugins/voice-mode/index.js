/**
 * voice-mode — host half.
 *
 * Speech-to-text and text-to-speech both run on this Mac. The browser keeps the
 * microphone capture, the VAD, and playback; it never touches the Web Speech
 * API, and no audio or transcript leaves the machine:
 *
 *   GET  /voice-mode/status      JSON: STT provider readiness + TTS engine and voices
 *   POST /voice-mode/transcribe  raw canonical 16 kHz mono PCM16 WAV -> {"text": "..."}
 *   POST /voice-mode/speak       {"text","sid","speed"} -> audio/wav (PCM16 mono)
 *
 * Transcription is delegated to the harness's own `ctx.speechToText` service,
 * which the `web` profile already mounts with the local SenseVoice provider; a
 * non-local (cloud) provider is refused rather than used. Synthesis is the local
 * Kokoro int8 multi-lang model with a macOS `say` fallback (see `lib/tts.js`).
 *
 * Every route sits behind `ctx.connection.requestRejection` exactly like
 * `browser-live`, answers 405/400/413/503 instead of throwing, and caps request
 * bodies before reading them into memory.
 */

import { homedir } from 'node:os';

import { VoiceEngineError, createTtsEngine } from './lib/tts.js';
import {
  ValidationError,
  coerceProviderLanguage,
  normalizeSpeakRequest,
  normalizeTranscribeQuery,
  parseJsonObject,
} from './lib/validate.js';
import { encodeWav16, validatePcm16Wav } from './lib/wav.js';

/** Cordis plugin name. */
export const name = 'voice-mode';

/** Required services: loopback Web routes, the trust gate, and local transcription. */
export const inject = ['webServer', 'connection', 'speechToText'];

const STATUS_PATH = '/voice-mode/status';
const TRANSCRIBE_PATH = '/voice-mode/transcribe';
const SPEAK_PATH = '/voice-mode/speak';

/** Largest `/voice-mode/speak` JSON body admitted, bytes. */
const MAX_SPEAK_BODY_BYTES = 64 * 1024;

/** Largest recording admitted by `/voice-mode/transcribe`, bytes (the harness cap). */
const MAX_AUDIO_BODY_BYTES = 4 * 1024 * 1024;

/** Longest recording admitted by `/voice-mode/transcribe`, seconds. */
const MAX_AUDIO_SECONDS = 120;

/** Bound on one transcription round trip, ms. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Provider preparation phases that accept recordings (worker warm or woken on demand). */
const READY_PHASES = new Set(['ready', 'standby']);

/**
 * Parse a request URL defensively: a handler may run on a bare request object.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {URLSearchParams} query parameters, empty on malformed URLs.
 */
function searchParamsOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Replace the home prefix so diagnostics do not print absolute local paths.
 * @param {unknown} value - message, error, or other detail.
 * @returns {string} printable detail.
 */
function sanitizeDetail(value) {
  const text = value instanceof Error ? value.message : String(value ?? 'unknown error');
  try {
    const home = homedir();
    return home === '' ? text : text.split(home).join('~');
  } catch {
    return text;
  }
}

/**
 * Read a raw request body with a hard byte cap.
 *
 * `content-length` short-circuits obvious oversize uploads; the streaming cap
 * backstops chunked bodies. On overflow the rest of the request is drained and
 * the caller answers 413 with `Connection: close`.
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {number} limit - maximum body bytes.
 * @returns {Promise<Buffer>} complete body.
 * @throws {ValidationError} with status 413 when the body exceeds the cap.
 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new ValidationError('body-too-large', `request body exceeds ${limit} bytes`, { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        fail(new ValidationError('body-too-large', `request body exceeds ${limit} bytes`, { status: 413 }));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      fail(new ValidationError('request-aborted', 'request was aborted before the body completed', { status: 400 }));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Read a UTF-8 text body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {number} limit - maximum body bytes.
 * @returns {Promise<string>} decoded body.
 */
async function readTextBody(req, limit) {
  return (await readRawBody(req, limit)).toString('utf8');
}

/**
 * Write one JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} res - response owner.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON-serialisable body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function sendJson(res, status, value, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, headerValue] of Object.entries(headers)) res.setHeader(key, headerValue);
  res.end(body);
}

/**
 * Answer a method mismatch with the allowed verbs.
 * @param {import('node:http').ServerResponse} res - response owner.
 * @param {string[]} allowed - accepted methods.
 * @returns {void}
 */
function methodNotAllowed(res, allowed) {
  res.statusCode = 405;
  res.setHeader('Allow', allowed.join(', '));
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Map the selected speech provider to a stable short label.
 * @param {unknown} id - provider id, e.g. `sensevoice-local`.
 * @returns {string} `sensevoice`, another id, or `none`.
 */
function providerLabel(id) {
  const value = typeof id === 'string' ? id : '';
  if (value === '') return 'none';
  return value.includes('sensevoice') ? 'sensevoice' : value;
}

/**
 * Explain why a speech provider cannot accept a recording right now.
 * @param {object} provider - provider view from `ctx.speechToText.snapshot()`.
 * @param {string} phase - preparation phase.
 * @returns {string} caller-facing hint.
 */
function sttHint(provider, phase) {
  if (provider?.location !== 'host-local') {
    return 'Speech-to-text must be a local provider; voice-mode refuses cloud transcription.';
  }
  if (phase === 'unprepared') {
    return 'The local SenseVoice model is not prepared. Prepare local speech in Settings, then retry (models are cached under ~/.dsh/speech-to-text).';
  }
  if (phase === 'failed') {
    const detail = provider?.preparation?.message;
    return `Local speech preparation failed${typeof detail === 'string' && detail !== '' ? `: ${sanitizeDetail(detail)}` : ''}.`;
  }
  if (phase === 'checking' || phase === 'loading' || phase === 'waking' || phase === 'downloading' || phase === 'cancelling') {
    return 'The local speech provider is preparing; retry shortly.';
  }
  return `Local speech provider is not ready (phase: ${phase}).`;
}

/**
 * Describe the selected speech provider without loading or downloading anything.
 * @param {{ speechToText?: object }} ctx - host context.
 * @returns {{ ready: boolean, provider: string, phase: string, location: string, languages: string[], hint?: string }} status.
 */
export function readSttStatus(ctx) {
  let snapshot;
  try {
    snapshot = ctx.speechToText?.snapshot?.();
  } catch (error) {
    return {
      ready: false,
      provider: 'none',
      phase: 'unavailable',
      location: 'unknown',
      languages: [],
      hint: `speechToText snapshot failed: ${sanitizeDetail(error)}`,
    };
  }
  if (snapshot === undefined || snapshot === null) {
    return {
      ready: false,
      provider: 'none',
      phase: 'unavailable',
      location: 'unknown',
      languages: [],
      hint: 'The harness speechToText service is not mounted in this profile.',
    };
  }
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const selectedId = snapshot.selection?.providerId;
  const provider = providers.find((view) => view?.id === selectedId);
  if (provider === undefined) {
    return {
      ready: false,
      provider: 'none',
      phase: 'missing',
      location: 'unknown',
      languages: [],
      hint: `The selected speech provider is not registered: ${typeof selectedId === 'string' ? selectedId : 'none'}`,
    };
  }
  const phase = typeof provider?.preparation?.phase === 'string' ? provider.preparation.phase : 'unavailable';
  const location = typeof provider?.location === 'string' ? provider.location : 'unknown';
  const ready = location === 'host-local' && READY_PHASES.has(phase);
  const status = {
    ready,
    provider: providerLabel(provider.id),
    phase,
    location,
    languages: Array.isArray(provider.languages) ? [...provider.languages] : [],
  };
  if (!ready) status.hint = sttHint(provider, phase);
  return status;
}

/**
 * Validate plugin config into concrete options, keeping a test injection seat
 * for the TTS engine and hard caps for request bodies.
 * @param {unknown} config - Cordis config row (may be absent).
 * @returns {{tts?: object, ttsOptions: object, limits: object, transcribeTimeoutMs: number}} resolved options.
 */
function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const limits = source.limits !== null && typeof source.limits === 'object' ? source.limits : {};
  const positiveInteger = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  const finitePositive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
  const injected = source.tts;
  const tts = injected !== null && typeof injected === 'object'
    && typeof injected.synthesize === 'function'
    && typeof injected.status === 'function'
    ? injected
    : undefined;
  return {
    ...(tts === undefined ? {} : { tts }),
    ttsOptions: source.ttsOptions !== null && typeof source.ttsOptions === 'object' ? source.ttsOptions : {},
    limits: {
      speakBodyBytes: positiveInteger(limits.speakBodyBytes, MAX_SPEAK_BODY_BYTES),
      audioBodyBytes: positiveInteger(limits.audioBodyBytes, MAX_AUDIO_BODY_BYTES),
      maxAudioSeconds: finitePositive(limits.maxAudioSeconds, MAX_AUDIO_SECONDS),
    },
    transcribeTimeoutMs: positiveInteger(source.transcribeTimeoutMs, TRANSCRIBE_TIMEOUT_MS),
  };
}

/**
 * Mount the local voice routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {unknown} [config] - optional Cordis config row.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveOptions(config);
  const tts = options.tts ?? createTtsEngine({
    ...options.ttsOptions,
    logger: options.ttsOptions.logger ?? ctx.logger,
  });

  /** Gate every request behind the connection trust check. */
  const rejected = (req, res) => {
    let rejection;
    try {
      rejection = ctx.connection.requestRejection(req);
    } catch (error) {
      ctx.logger?.warn?.(`voice-mode: connection gate failed: ${sanitizeDetail(error)}`);
      rejection = 403;
    }
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return true;
  };

  /** Wrap one route so no handler can throw into the HTTP server. */
  const wrap = (label, handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error instanceof ValidationError
        ? error.status
        : error instanceof VoiceEngineError && error.code === 'empty-text'
          ? 400
          : 500;
      ctx.logger?.warn?.(`voice-mode: ${label} failed: ${sanitizeDetail(error)}`);
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* peer already gone */
        }
        return;
      }
      sendJson(res, status, {
        error: error instanceof ValidationError || error instanceof VoiceEngineError ? error.code : 'internal-error',
        detail: sanitizeDetail(error),
      });
    }
  };

  /** GET /voice-mode/status */
  const statusRoute = async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, ['GET', 'HEAD']);
      return;
    }
    const stt = readSttStatus(ctx);
    let ttsStatus;
    try {
      ttsStatus = await tts.status();
    } catch (error) {
      ttsStatus = { ready: false, engine: 'none', sampleRate: 0, error: sanitizeDetail(error) };
    }
    sendJson(res, 200, {
      ok: stt.ready === true && ttsStatus.ready === true,
      stt,
      tts: ttsStatus,
    });
  };

  /** POST /voice-mode/transcribe — raw canonical 16 kHz mono PCM16 WAV body. */
  const transcribeRoute = async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    let query;
    try {
      query = normalizeTranscribeQuery(searchParamsOf(req));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      sendJson(res, error.status, { error: error.code, detail: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) });
      return;
    }

    const stt = readSttStatus(ctx);
    if (!stt.ready) {
      req.resume();
      sendJson(res, 503, { error: 'stt-not-ready', stt, hint: stt.hint }, { 'Retry-After': '2', Connection: 'close' });
      return;
    }

    let audio;
    try {
      audio = await readRawBody(req, options.limits.audioBodyBytes);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      sendJson(res, error.status, { error: error.code, detail: error.message }, { Connection: 'close' });
      return;
    }
    if (audio.length === 0) {
      sendJson(res, 400, { error: 'empty-audio', detail: 'request body is empty', hint: 'Send a 16 kHz mono PCM16 WAV recording as the raw body' });
      return;
    }

    let recording;
    try {
      recording = validatePcm16Wav(audio, options.limits.maxAudioSeconds);
    } catch (error) {
      sendJson(res, 400, {
        error: 'invalid-audio',
        detail: sanitizeDetail(error),
        hint: 'Send a canonical 16 kHz mono PCM16 WAV recording as the raw POST body',
      });
      return;
    }

    let language;
    try {
      language = coerceProviderLanguage(query.language, stt.languages);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      sendJson(res, error.status, { error: error.code, detail: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) });
      return;
    }

    let spec;
    try {
      spec = ctx.speechToText.resolve({
        audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
        ...(language === undefined ? {} : { language }),
      });
    } catch (error) {
      sendJson(res, 503, {
        error: 'stt-not-ready',
        detail: sanitizeDetail(error),
        hint: 'The selected local speech provider is unavailable',
      });
      return;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`transcription exceeded ${options.transcribeTimeoutMs} ms`));
    }, options.transcribeTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const result = await ctx.speechToText.transcribe(spec, controller.signal);
      sendJson(res, 200, {
        text: typeof result?.text === 'string' ? result.text : '',
        provider: stt.provider,
        language: language ?? null,
        audioSeconds: typeof result?.audioSeconds === 'number' ? result.audioSeconds : recording.durationSeconds,
        inferenceSeconds: typeof result?.inferenceSeconds === 'number' ? result.inferenceSeconds : null,
      });
    } catch (error) {
      if (timedOut) {
        sendJson(res, 504, { error: 'transcription-timeout', detail: `transcription exceeded ${options.transcribeTimeoutMs} ms` });
        return;
      }
      const detail = sanitizeDetail(error);
      if (/prepare the local speech provider/i.test(detail)) {
        sendJson(res, 503, { error: 'stt-not-ready', detail, hint: 'Prepare the local speech provider, then retry' }, { 'Retry-After': '2' });
        return;
      }
      if (/does not support language|provider is unavailable|no longer registered/i.test(detail)) {
        sendJson(res, 400, { error: 'stt-rejected', detail });
        return;
      }
      sendJson(res, 500, { error: 'transcription-failed', detail });
    } finally {
      clearTimeout(timer);
    }
  };

  /** POST /voice-mode/speak — {"text","sid","speed","lang"} -> audio/wav. */
  const speakRoute = async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    let raw;
    try {
      raw = await readTextBody(req, options.limits.speakBodyBytes);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      sendJson(res, error.status, { error: error.code, detail: error.message }, { Connection: 'close' });
      return;
    }

    let input;
    try {
      input = normalizeSpeakRequest(parseJsonObject(raw));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      sendJson(res, error.status, { error: error.code, detail: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) });
      return;
    }

    let result;
    try {
      result = await tts.synthesize(input);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, error.status, { error: error.code, detail: sanitizeDetail(error), ...(error.hint === undefined ? {} : { hint: error.hint }) });
        return;
      }
      if (error instanceof VoiceEngineError) {
        if (error.code === 'empty-text' || error.code === 'invalid-sid' || error.code === 'invalid-speed') {
          sendJson(res, 400, { error: error.code, detail: sanitizeDetail(error) });
          return;
        }
        if (error.code === 'timeout') {
          sendJson(res, 504, { error: error.code, detail: sanitizeDetail(error) });
          return;
        }
        sendJson(res, 503, {
          error: 'tts-unavailable',
          detail: sanitizeDetail(error),
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        }, { 'Retry-After': '5' });
        return;
      }
      throw error;
    }

    let wav;
    try {
      wav = encodeWav16(result.samples, result.sampleRate);
    } catch (error) {
      sendJson(res, 500, { error: 'tts-encode-failed', detail: sanitizeDetail(error) });
      return;
    }
    if (wav.byteLength <= 44) {
      sendJson(res, 503, { error: 'tts-unavailable', detail: 'the local engine produced no audio for this text' });
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(wav.byteLength));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Mode-Engine', String(result.engine ?? 'unknown'));
    res.setHeader('X-Voice-Mode-Sample-Rate', String(result.sampleRate));
    res.setHeader('X-Voice-Mode-Sid', result.sid === null || result.sid === undefined ? 'none' : String(result.sid));
    if (typeof result.voice === 'string' && result.voice !== '') res.setHeader('X-Voice-Mode-Voice', result.voice);
    res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: wrap('GET /voice-mode/status', statusRoute),
  }), `voice-mode: GET ${STATUS_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TRANSCRIBE_PATH,
    handler: wrap('POST /voice-mode/transcribe', transcribeRoute),
  }), `voice-mode: POST ${TRANSCRIBE_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SPEAK_PATH,
    handler: wrap('POST /voice-mode/speak', speakRoute),
  }), `voice-mode: POST ${SPEAK_PATH}`);

  ctx.effect(() => () => {
    try {
      tts.dispose?.();
    } catch (error) {
      ctx.logger?.warn?.(`voice-mode: TTS dispose failed: ${sanitizeDetail(error)}`);
    }
  }, 'voice-mode.dispose');

  ctx.logger?.info?.(`voice-mode: local voice routes mounted (${STATUS_PATH}, ${TRANSCRIBE_PATH}, ${SPEAK_PATH})`);
}

export default { name, inject, apply };
