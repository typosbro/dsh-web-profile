/**
 * Speech-to-text client for the local whisper.cpp OpenAI-compatible server.
 *
 * Contract that matters: `language` is always sent explicitly. Without it the
 * server auto-detects and Korean speech comes back transcribed as English.
 * The English-only MVP sends `language=en` from config.
 */
import { buildWav } from './wav.js';

export class SttError extends Error {
  constructor(message, { status = null, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'SttError';
    this.status = status;
  }
}

/**
 * Transcribe one PCM utterance.
 *
 * @param {object} options
 * @param {Buffer} options.pcm      48 kHz stereo s16le PCM
 * @param {object} options.config   full config (uses config.stt)
 * @param {Function} [options.fetchImpl] injected fetch for tests
 */
export async function transcribePcm({ pcm, config, fetchImpl = fetch }) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    throw new SttError('cannot transcribe an empty PCM buffer');
  }
  const wav = buildWav(pcm, { sampleRate: 48000, channels: 2 });
  return transcribeWav({ wav, sttConfig: config.stt, fetchImpl });
}

/** Transcribe an existing WAV buffer (used by tests and the local verifier). */
export async function transcribeWav({ wav, sttConfig, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', sttConfig.model);
  form.append('language', sttConfig.language);
  form.append('response_format', 'json');

  let response;
  try {
    response = await fetchImpl(sttConfig.url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(sttConfig.timeoutMs ?? 30000),
    });
  } catch (error) {
    throw new SttError(`whisper request failed: ${error.message}`, { cause: error });
  }

  if (!response.ok) {
    let snippet = '';
    try {
      snippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new SttError(`whisper HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`, {
      status: response.status,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new SttError(`whisper returned invalid JSON: ${error.message}`, { cause: error });
  }

  const text = normalizeTranscript(payload);
  if (!text) throw new SttError('whisper returned an empty transcript');
  return { text, language: sttConfig.language, raw: payload };
}

/**
 * whisper.cpp returns `{ text }`; the OpenAI verbose shape has `segments`.
 * Strip whisper's non-speech markers like "[BLANK_AUDIO]" so VAD noise does
 * not look like a real turn downstream.
 */
export function normalizeTranscript(payload) {
  let text = '';
  if (payload && typeof payload.text === 'string') {
    text = payload.text;
  } else if (payload && Array.isArray(payload.segments)) {
    text = payload.segments.map((segment) => segment?.text ?? '').join(' ');
  }
  return cleanTranscript(text);
}

export function cleanTranscript(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\[(?:BLANK_AUDIO|INAUDIBLE|NOISE|MUSIC|SILENCE)[^\]]*\]/gi, ' ')
    .replace(/\((?:blank_audio|inaudible|noise|music|silence)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
