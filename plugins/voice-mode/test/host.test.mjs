/**
 * Host-half unit tests for @local/voice-mode.
 *
 * Covers, with no harness, no microphone, and no native model load:
 *   - lib/wav.js: canonical encoding, tolerant RIFF parsing, recording validation
 *   - lib/validate.js: speak/transcribe request validation, script detection
 *   - lib/tts.js: engine routing, hangul -> say, Kokoro -> say fallback, status
 *   - index.js: all three routes over a real loopback HTTP server, against a
 *     fake `ctx` with `webServer.register`, the connection gate, and a fake
 *     `speechToText` service (the same shape the harness mounts).
 *
 * Run with: node --test test/host.test.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, readSttStatus } from '../index.js';
import { VoiceEngineError, createTtsEngine, pickSayVoice } from '../lib/tts.js';
import {
  ValidationError,
  coerceProviderLanguage,
  detectScript,
  hasSpeakableChars,
  normalizeSpeakRequest,
  normalizeTranscribeQuery,
  parseJsonObject,
} from '../lib/validate.js';
import { encodeWav16, float32ToPcm16, parseWav, validatePcm16Wav } from '../lib/wav.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A canonical 16 kHz mono PCM16 WAV with `frames` zero samples. */
function canonicalRecording(frames = 1600) {
  return encodeWav16(new Float32Array(frames), 16000);
}

/** Build a WAV file with an extra chunk before `data`, like `say`/afconvert write. */
function wavWithExtraChunk(samples, sampleRate) {
  const pcm = float32ToPcm16(samples);
  const filler = new Uint8Array(6); // even length, like FLLR in CoreAudio output
  const bytes = new Uint8Array(44 + 8 + filler.length + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'FLLR');
  view.setUint32(40, filler.length, true);
  for (let i = 0; i < filler.length; i += 1) bytes[44 + i] = i;
  const dataAt = 44 + filler.length;
  ascii(dataAt, 'data');
  view.setUint32(dataAt + 4, pcm.length * 2, true);
  const payload = new DataView(bytes.buffer, dataAt + 8, pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) payload.setInt16(i * 2, pcm[i], true);
  return bytes;
}

/** Build an interleaved stereo PCM16 WAV. */
function stereoWav(left, right, sampleRate) {
  const frames = left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 4, true);
  const payload = new DataView(bytes.buffer, 44, frames * 4);
  for (let i = 0; i < frames; i += 1) {
    payload.setInt16(i * 4, Math.round(left[i] * 32767), true);
    payload.setInt16(i * 4 + 2, Math.round(right[i] * 32767), true);
  }
  return bytes;
}

/** The `say -v '?'` listing shape, including a parenthetical multilingual voice. */
const SAY_VOICE_LISTING = [
  'Yuna                ko_KR    # 안녕하세요. 제 이름은 유나입니다.',
  'Eddy (Korean (South Korea)) ko_KR    # 안녕하세요.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Fred                en_US    # Hello! My name is Fred.',
  'Tingting            zh_CN    # 你好！我叫婷婷。',
  'Kyoko               ja_JP    # こんにちは!',
].join('\n');

/**
 * Fake promisified `execFile` that answers the voice probe and renders a WAV
 * when `say -o <path>` is invoked, so the say path never shells out in tests.
 */
function createFakeExecFile({ failSay = false } = {}) {
  const calls = [];
  const execFileFn = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === '-v' && args[1] === '?') return { stdout: SAY_VOICE_LISTING, stderr: '' };
    if (command.endsWith('say')) {
      if (failSay) throw new Error('say refused to render');
      const outPath = args[args.indexOf('-o') + 1];
      const samples = new Float32Array(2400).fill(0.25);
      await writeFile(outPath, encodeWav16(samples, 24000));
      return { stdout: '', stderr: '' };
    }
    if (command.endsWith('afconvert')) return { stdout: '', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };
  return { execFileFn, calls };
}

/** Fake `ctx.speechToText` matching the harness service shape used by the routes. */
function createFakeSpeechToText({ phase = 'standby', location = 'host-local', transcript = 'hello world', failures } = {}) {
  const calls = { resolve: [], transcribe: [], snapshot: 0 };
  const provider = {
    id: 'sensevoice-local',
    name: 'SenseVoiceSmall (INT8)',
    location,
    languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
    preparation: { phase },
  };
  const service = {
    snapshot() {
      calls.snapshot += 1;
      return { providers: [provider], selection: { providerId: 'sensevoice-local', language: 'auto' } };
    },
    resolve(request) {
      calls.resolve.push(request);
      if (failures?.resolve !== undefined) throw failures.resolve;
      if (request.language === 'xx') throw new Error('Speech provider sensevoice-local does not support language: xx');
      return { provider, audio: request.audio, language: request.language ?? 'auto' };
    },
    async transcribe(spec, signal) {
      calls.transcribe.push({ spec, signal });
      if (failures?.transcribe !== undefined) throw failures.transcribe;
      return { text: transcript, audioSeconds: 0.5, inferenceSeconds: 0.05 };
    },
  };
  return { service, calls, provider };
}

/** Fake TTS engine for route tests; audio is deterministic and instant. */
function createFakeTts({ error, statusError } = {}) {
  const calls = { synthesize: [], status: 0, disposed: false };
  const samples = new Float32Array(1200);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 8) * 0.4;
  const engine = {
    modelDir: '/tmp/fake-kokoro',
    async status() {
      calls.status += 1;
      if (statusError !== undefined) throw statusError;
      return {
        ready: true,
        engine: 'kokoro',
        sampleRate: 24000,
        modelDir: '/tmp/fake-kokoro',
        speakerCount: 54,
        sids: [{ sid: 3, name: 'af_heart' }],
        langs: ['en', 'zh', 'ja', 'ko'],
      };
    },
    async synthesize(input) {
      calls.synthesize.push(input);
      if (error !== undefined) throw error;
      return { samples, sampleRate: 24000, engine: 'kokoro', sid: input.sid ?? 3, voice: 'af_heart' };
    },
    dispose() {
      calls.disposed = true;
    },
  };
  return { engine, calls, samples };
}

/**
 * Start a real loopback HTTP server dispatching to the routes `apply()` mounted
 * on a fake context; return its base URL and a disposer.
 */
async function startHarness({ speechToText, tts, rejection, config } = {}) {
  const routes = new Map();
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connection: { requestRejection: rejection ?? (() => undefined) },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    speechToText: speechToText ?? createFakeSpeechToText().service,
    effect(callback) {
      const disposer = callback();
      effects.push(disposer);
      return disposer;
    },
  };
  const ttsHarness = tts ?? createFakeTts().engine;
  apply(ctx, { tts: ttsHarness, ...(config ?? {}) });
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '/';
    }
    const route = routes.get(pathname);
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    routes,
    async close() {
      for (const disposer of effects.reverse()) {
        try {
          await disposer?.();
        } catch {
          /* disposal is best effort in tests */
        }
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** POST one JSON body. */
function postJson(url, value) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

// ---------------------------------------------------------------------------
// lib/wav.js
// ---------------------------------------------------------------------------

test('encodeWav16 writes a canonical 44-byte PCM16 mono header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const bytes = encodeWav16(samples, 24000);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, 44 + samples.length * 2);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...bytes.subarray(12, 16)), 'fmt ');
  assert.equal(String.fromCharCode(...bytes.subarray(36, 40)), 'data');
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(28, true), 48000); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits
  assert.equal(view.getUint32(40, true), samples.length * 2);
});

test('encodeWav16 rejects an invalid sample rate', () => {
  assert.throws(() => encodeWav16(new Float32Array(2), 0), TypeError);
  assert.throws(() => encodeWav16(new Float32Array(2), 16000.5), TypeError);
});

test('float32ToPcm16 clamps to the harness scaling and maps NaN to silence', () => {
  const pcm = float32ToPcm16(new Float32Array([1, -1, 0.5, -0.5, 2, -2, Number.NaN]));
  assert.equal(pcm[0], 32767);
  assert.equal(pcm[1], -32768);
  assert.equal(pcm[2], Math.round(0.5 * 32767));
  assert.equal(pcm[3], Math.round(-0.5 * 32768));
  assert.equal(pcm[4], 32767);
  assert.equal(pcm[5], -32768);
  assert.equal(pcm[6], 0);
});

test('parseWav round-trips encoded samples within PCM16 precision', () => {
  const samples = new Float32Array(240);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 15) * 0.8;
  const encoded = encodeWav16(samples, 16000);
  const parsed = parseWav(encoded);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.samples.length, samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    assert.ok(Math.abs(parsed.samples[i] - samples[i]) <= 2 / 32768, `sample ${i} round-trips`);
  }
  assert.ok(Math.abs(parsed.durationSeconds - 240 / 16000) < 1e-9);
});

test('parseWav skips metadata chunks before data (say/afconvert output shape)', () => {
  const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
  const bytes = wavWithExtraChunk(samples, 24000);
  const parsed = parseWav(bytes);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.samples.length, 4);
  assert.ok(parsed.samples[0] > 0.2);
  assert.ok(parsed.samples[1] < -0.2);
});

test('parseWav downmixes stereo by averaging channels', () => {
  const left = new Float32Array([0.5, 0.5, 0.5]);
  const right = new Float32Array([-0.5, 0.25, 0.5]);
  const parsed = parseWav(stereoWav(left, right, 22050));
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 22050);
  assert.equal(parsed.samples.length, 3);
  assert.ok(Math.abs(parsed.samples[0]) < 0.01);
  assert.ok(Math.abs(parsed.samples[1] - 0.375) < 0.01);
  assert.ok(Math.abs(parsed.samples[2] - 0.5) < 0.01);
});

test('parseWav and validatePcm16Wav reject malformed audio', () => {
  assert.throws(() => parseWav(new Uint8Array(4)), /too short/);
  const notRiff = new Uint8Array(64);
  assert.throws(() => parseWav(notRiff), /Not a RIFF\/WAVE/);
  const wrongRate = encodeWav16(new Float32Array(10), 24000);
  assert.throws(() => validatePcm16Wav(wrongRate), /canonical 16 kHz mono PCM16 WAV/);
  assert.throws(() => validatePcm16Wav(canonicalRecording(10), -1), /exceeds/);
});

test('validatePcm16Wav accepts canonical recordings and enforces duration', () => {
  const bytes = canonicalRecording(16000); // exactly one second
  const facts = validatePcm16Wav(bytes, 5);
  assert.equal(facts.sampleRate, 16000);
  assert.equal(facts.channels, 1);
  assert.equal(facts.durationSeconds, 1);
  assert.throws(() => validatePcm16Wav(canonicalRecording(32000), 1), /exceeds 1 seconds/);
  const truncated = bytes.subarray(0, bytes.length - 2);
  assert.throws(() => validatePcm16Wav(truncated), /canonical/);
});

// ---------------------------------------------------------------------------
// lib/validate.js
// ---------------------------------------------------------------------------

test('detectScript classifies Hangul, kana, CJK, and Latin text', () => {
  assert.equal(detectScript('Hello there'), 'latin');
  assert.equal(detectScript('안녕하세요'), 'hangul');
  assert.equal(detectScript('这是一次测试'), 'cjk');
  assert.equal(detectScript('これはテストです'), 'kana');
  assert.equal(detectScript('日本語のテスト'), 'kana'); // kanji + kana reads Japanese
  assert.equal(detectScript('1234 !!!'), 'latin');
  assert.equal(detectScript(undefined), 'latin');
});

test('hasSpeakableChars requires at least one letter or digit', () => {
  assert.equal(hasSpeakableChars('hi'), true);
  assert.equal(hasSpeakableChars('123'), true);
  assert.equal(hasSpeakableChars('안녕'), true);
  assert.equal(hasSpeakableChars('!!! ...'), false);
  assert.equal(hasSpeakableChars('🎉🎉'), false);
  assert.equal(hasSpeakableChars(''), false);
  assert.equal(hasSpeakableChars(undefined), false);
});

test('parseJsonObject accepts objects and rejects everything else', () => {
  assert.deepEqual(parseJsonObject('{"text":"hi"}'), { text: 'hi' });
  assert.throws(() => parseJsonObject(''), /must be a JSON object/);
  assert.throws(() => parseJsonObject('not json'), /not valid JSON/);
  assert.throws(() => parseJsonObject('[1,2]'), /must be a JSON object/);
  assert.throws(() => parseJsonObject('null'), /must be a JSON object/);
});

test('normalizeSpeakRequest applies defaults and validates every field', () => {
  assert.deepEqual(normalizeSpeakRequest({ text: '  Hello   world  ' }), { text: 'Hello world', speed: 1 });
  assert.deepEqual(normalizeSpeakRequest({ text: 'Hi', sid: 7, speed: 1.5, lang: 'EN' }), { text: 'Hi', sid: 7, speed: 1.5, lang: 'en' });
  const cases = [
    [{}, 'empty-text'],
    [{ text: '   ' }, 'empty-text'],
    [{ text: 42 }, 'empty-text'],
    [{ text: 'x'.repeat(2001) }, 'text-too-long'],
    [{ text: '🎉🎉' }, 'unspeakable-text'],
    [{ text: 'Hi', sid: 99 }, 'invalid-sid'],
    [{ text: 'Hi', sid: 2.5 }, 'invalid-sid'],
    [{ text: 'Hi', sid: '3' }, 'invalid-sid'],
    [{ text: 'Hi', speed: 0.1 }, 'invalid-speed'],
    [{ text: 'Hi', speed: 3 }, 'invalid-speed'],
    [{ text: 'Hi', lang: 'klingon' }, 'invalid-lang'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeSpeakRequest(input), (error) => error instanceof ValidationError && error.code === code, code);
  }
  assert.equal(normalizeSpeakRequest({ text: 'Hello.' }).sid, undefined);
});

test('normalizeTranscribeQuery reads lang and defaults to the harness language', () => {
  assert.deepEqual(normalizeTranscribeQuery(new URLSearchParams('')), {});
  assert.deepEqual(normalizeTranscribeQuery(new URLSearchParams('lang=auto')), {});
  assert.deepEqual(normalizeTranscribeQuery(new URLSearchParams('lang=KO')), { language: 'ko' });
  assert.deepEqual(normalizeTranscribeQuery(new URLSearchParams('language=en-US')), { language: 'en-us' });
  assert.throws(() => normalizeTranscribeQuery(new URLSearchParams('lang=e')), /short language code/);
  assert.throws(() => normalizeTranscribeQuery(new URLSearchParams('lang=english-language')), /short language code/);
});

test('coerceProviderLanguage maps region variants and rejects unknown hints', () => {
  const accepted = ['auto', 'zh', 'en', 'ja', 'ko'];
  assert.equal(coerceProviderLanguage(undefined, accepted), undefined);
  assert.equal(coerceProviderLanguage('ko', accepted), 'ko');
  assert.equal(coerceProviderLanguage('en-us', accepted), 'en');
  assert.equal(coerceProviderLanguage('zh', []), 'zh');
  assert.throws(
    () => coerceProviderLanguage('xx', accepted),
    (error) => error instanceof ValidationError && error.code === 'unsupported-language' && /accepted: auto, zh, en, ja, ko/.test(error.hint),
  );
});

// ---------------------------------------------------------------------------
// lib/tts.js
// ---------------------------------------------------------------------------

test('pickSayVoice honours natural-voice preferences, overrides, and parenthetical names', () => {
  const voices = [
    { name: 'Eddy', locale: 'ko_KR', natural: false },
    { name: 'Yuna', locale: 'ko_KR', natural: true },
    { name: 'Fred', locale: 'en_US', natural: true },
    { name: 'Samantha', locale: 'en_US', natural: true },
  ];
  assert.deepEqual(pickSayVoice(voices, 'hangul'), { name: 'Yuna', locale: 'ko_KR', natural: true });
  assert.deepEqual(pickSayVoice(voices, 'latin'), { name: 'Samantha', locale: 'en_US', natural: true });
  assert.deepEqual(pickSayVoice(voices, 'hangul', new Map([['hangul', 'Eddy']])), { name: 'Eddy', locale: 'ko_KR', natural: false });
  assert.equal(pickSayVoice([], 'cjk'), undefined);
});

/** Fake fetch for the loopback Kokoro service: voices + one WAV response. */
function fakeKokoroFetch(calls = []) {
  return async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.endsWith('/v1/audio/voices')) {
      return new Response(JSON.stringify({ voices: ['af_sky', 'zf_xiaoxiao', 'jf_alpha'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target.endsWith('/v1/audio/speech')) {
      return new Response(encodeWav16(new Float32Array(2400).fill(0.1), 24000), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

test('createTtsEngine uses exactly one Kokoro version: the loopback service', async () => {
  const calls = [];
  const engine = createTtsEngine({
    kokoroHttp: { baseUrl: 'http://127.0.0.1:9', fetch: fakeKokoroFetch(calls) },
  });
  const status = await engine.status();
  assert.equal(status.engine, 'kokoro-http');
  assert.equal(status.ready, true);
  assert.equal(status.policy.singleService, true);
  assert.equal(status.policy.int8KokoroEnabled, false);
  assert.equal(status.sampleRate, 24000);
  assert.equal(status.http.available, true);
  await engine.dispose();
});

test('createTtsEngine synthesises through the service and reports its voice', async () => {
  const calls = [];
  const engine = createTtsEngine({
    kokoroHttp: { baseUrl: 'http://127.0.0.1:9', fetch: fakeKokoroFetch(calls) },
  });
  const audio = await engine.synthesize({ text: 'One local sentence.' });
  assert.equal(audio.engine, 'kokoro-http');
  assert.equal(audio.voice, 'af_sky');
  assert.equal(audio.sampleRate, 24000);
  assert.ok(audio.samples.length > 0);
  assert.equal(calls.filter((call) => call.url.endsWith('/v1/audio/speech')).length, 1);
  await engine.dispose();
});

test('createTtsEngine routes Hangul away from the Kokoro service to say', async () => {
  const calls = [];
  const engine = createTtsEngine({
    kokoroHttp: { baseUrl: 'http://127.0.0.1:9', fetch: fakeKokoroFetch(calls) },
  });
  let audio;
  try {
    audio = await engine.synthesize({ text: '안녕하세요, 반갑습니다.' });
  } catch (error) {
    // A machine without a ko_KR say voice cannot render Hangul; that is fine.
    assert.equal(error instanceof VoiceEngineError, true);
  }
  if (audio !== undefined) assert.equal(audio.engine, 'say');
  assert.equal(calls.filter((call) => call.url.endsWith('/v1/audio/speech')).length, 0);
  await engine.dispose();
});

test('createTtsEngine falls back to say when the local service is unreachable', async () => {
  const engine = createTtsEngine({
    kokoroHttp: {
      baseUrl: 'http://127.0.0.1:9',
      fetch: async () => {
        throw new Error('connection refused');
      },
    },
  });
  let audio;
  try {
    audio = await engine.synthesize({ text: 'Fallback sentence.' });
  } catch (error) {
    assert.equal(error instanceof VoiceEngineError, true);
  }
  if (audio !== undefined) assert.equal(audio.engine, 'say');
  const status = await engine.status();
  assert.notEqual(status.engine, 'kokoro-http');
  await engine.dispose();
});

test('readSttStatus reports missing service, missing provider, and cloud refusal', () => {
  const missing = readSttStatus({});
  assert.equal(missing.ready, false);
  assert.equal(missing.provider, 'none');
  assert.match(missing.hint, /not mounted/);

  const throwing = readSttStatus({ speechToText: { snapshot() { throw new Error('registry gone'); } } });
  assert.equal(throwing.ready, false);
  assert.match(throwing.hint, /registry gone/);

  const unregistered = readSttStatus({
    speechToText: {
      snapshot: () => ({ providers: [], selection: { providerId: 'sensevoice-local', language: 'auto' } }),
    },
  });
  assert.equal(unregistered.ready, false);
  assert.equal(unregistered.phase, 'missing');

  const cloud = createFakeSpeechToText({ location: 'cloud' });
  const cloudStatus = readSttStatus({ speechToText: cloud.service });
  assert.equal(cloudStatus.ready, false);
  assert.equal(cloudStatus.location, 'cloud');
  assert.match(cloudStatus.hint, /refuses cloud transcription/);
});

// ---------------------------------------------------------------------------
// index.js — routes
// ---------------------------------------------------------------------------

test('GET /voice-mode/status reports local STT and Kokoro TTS readiness', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/status`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stt.ready, true);
  assert.equal(body.stt.provider, 'sensevoice');
  assert.equal(body.stt.location, 'host-local');
  assert.equal(body.stt.phase, 'standby');
  assert.deepEqual(body.stt.languages, ['auto', 'zh', 'en', 'yue', 'ja', 'ko']);
  assert.equal(body.tts.ready, true);
  assert.equal(body.tts.engine, 'kokoro');
  assert.equal(body.tts.sampleRate, 24000);
});

test('GET /voice-mode/status explains an unprepared local provider', async (t) => {
  const speech = createFakeSpeechToText({ phase: 'unprepared' });
  const harness = await startHarness({ speechToText: speech.service });
  t.after(() => harness.close());
  const body = await (await fetch(`${harness.url}/voice-mode/status`)).json();
  assert.equal(body.ok, false);
  assert.equal(body.stt.ready, false);
  assert.match(body.stt.hint, /not prepared/);
});

test('GET /voice-mode/status survives a TTS status failure', async (t) => {
  const tts = createFakeTts({ statusError: new Error('engine probe failed') });
  const harness = await startHarness({ tts: tts.engine });
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.tts.engine, 'none');
  assert.match(body.tts.error, /engine probe failed/);
});

test('the connection gate rejects every route', async (t) => {
  const harness = await startHarness({ rejection: () => 403 });
  t.after(() => harness.close());
  const status = await fetch(`${harness.url}/voice-mode/status`);
  assert.equal(status.status, 403);
  const speak = await postJson(`${harness.url}/voice-mode/speak`, { text: 'Hi' });
  assert.equal(speak.status, 403);
  const transcribe = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(transcribe.status, 403);
});

test('routes answer 405 for the wrong method', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const status = await fetch(`${harness.url}/voice-mode/status`, { method: 'POST' });
  assert.equal(status.status, 405);
  assert.equal(status.headers.get('allow'), 'GET, HEAD');
  const transcribe = await fetch(`${harness.url}/voice-mode/transcribe`);
  assert.equal(transcribe.status, 405);
  assert.equal(transcribe.headers.get('allow'), 'POST');
  const speak = await fetch(`${harness.url}/voice-mode/speak`);
  assert.equal(speak.status, 405);
});

test('POST /voice-mode/transcribe returns local transcript text', async (t) => {
  const speech = createFakeSpeechToText({ transcript: 'open the pod bay doors' });
  const harness = await startHarness({ speechToText: speech.service });
  t.after(() => harness.close());
  const audio = canonicalRecording();
  const res = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: audio });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'open the pod bay doors');
  assert.equal(body.provider, 'sensevoice');
  assert.equal(body.language, null);
  assert.equal(body.audioSeconds, 0.5);
  assert.equal(speech.calls.resolve.length, 1);
  assert.equal(speech.calls.resolve[0].audio.byteLength, audio.byteLength);
  assert.equal(speech.calls.resolve[0].language, undefined);
  assert.equal(speech.calls.transcribe.length, 1);
});

test('POST /voice-mode/transcribe forwards and validates a language hint', async (t) => {
  const speech = createFakeSpeechToText();
  const harness = await startHarness({ speechToText: speech.service });
  t.after(() => harness.close());
  const ok = await fetch(`${harness.url}/voice-mode/transcribe?lang=KO`, { method: 'POST', body: canonicalRecording() });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).language, 'ko');
  assert.equal(speech.calls.resolve[0].language, 'ko');

  const rejected = await fetch(`${harness.url}/voice-mode/transcribe?lang=xx`, { method: 'POST', body: canonicalRecording() });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'unsupported-language');
});

test('POST /voice-mode/transcribe rejects malformed or empty recordings', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const empty = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: new Uint8Array(0) });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'empty-audio');

  const wrongRate = await fetch(`${harness.url}/voice-mode/transcribe`, {
    method: 'POST',
    body: encodeWav16(new Float32Array(100), 24000),
  });
  assert.equal(wrongRate.status, 400);
  const body = await wrongRate.json();
  assert.equal(body.error, 'invalid-audio');
  assert.match(body.hint, /16 kHz mono PCM16/);
});

test('POST /voice-mode/transcribe answers 503 when the local provider is not ready', async (t) => {
  const speech = createFakeSpeechToText({ phase: 'unprepared' });
  const harness = await startHarness({ speechToText: speech.service });
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'stt-not-ready');
  assert.equal(speech.calls.resolve.length, 0, 'no provider call when not ready');
  assert.equal(speech.calls.transcribe.length, 0);
});

test('POST /voice-mode/transcribe refuses a cloud provider', async (t) => {
  const speech = createFakeSpeechToText({ location: 'cloud' });
  const harness = await startHarness({ speechToText: speech.service });
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(res.status, 503);
  assert.equal(speech.calls.transcribe.length, 0, 'no audio leaves the machine');
});

test('POST /voice-mode/transcribe maps provider failures to JSON errors', async (t) => {
  const notReady = createFakeSpeechToText({ failures: { transcribe: new Error('Prepare the local speech provider before recording') } });
  const harness = await startHarness({ speechToText: notReady.service });
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(res.status, 503);

  const broken = createFakeSpeechToText({ failures: { transcribe: new Error('worker died') } });
  const harness2 = await startHarness({ speechToText: broken.service });
  t.after(() => harness2.close());
  const res2 = await fetch(`${harness2.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(res2.status, 500);
  assert.equal((await res2.json()).error, 'transcription-failed');

  const resolveFailed = createFakeSpeechToText({ failures: { resolve: new Error('Speech provider is unavailable: sensevoice-local') } });
  const harness3 = await startHarness({ speechToText: resolveFailed.service });
  t.after(() => harness3.close());
  const res3 = await fetch(`${harness3.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording() });
  assert.equal(res3.status, 503);
});

test('POST /voice-mode/transcribe caps the body size', async (t) => {
  const harness = await startHarness({ config: { limits: { audioBodyBytes: 512 } } });
  t.after(() => harness.close());
  const res = await fetch(`${harness.url}/voice-mode/transcribe`, { method: 'POST', body: canonicalRecording(1600) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'body-too-large');
});

test('POST /voice-mode/speak returns PCM16 mono WAV audio', async (t) => {
  const tts = createFakeTts();
  const harness = await startHarness({ tts: tts.engine });
  t.after(() => harness.close());
  const res = await postJson(`${harness.url}/voice-mode/speak`, { text: 'Hello, this is local speech.' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-voice-mode-engine'), 'kokoro');
  assert.equal(res.headers.get('x-voice-mode-sample-rate'), '24000');
  assert.equal(res.headers.get('x-voice-mode-sid'), String(3));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.byteLength > 44);
  const parsed = parseWav(bytes);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.samples.length, 1200);
  assert.deepEqual(tts.calls.synthesize, [{ text: 'Hello, this is local speech.', speed: 1 }]);
});

test('POST /voice-mode/speak validates text, sid, speed, and lang', async (t) => {
  const tts = createFakeTts();
  const harness = await startHarness({ tts: tts.engine });
  t.after(() => harness.close());
  const cases = [
    [{ text: '' }, 400, 'empty-text'],
    [{}, 400, 'empty-text'],
    [{ text: 'Hi', sid: 99 }, 400, 'invalid-sid'],
    [{ text: 'Hi', speed: 9 }, 400, 'invalid-speed'],
    [{ text: 'Hi', lang: 'xx' }, 400, 'invalid-lang'],
  ];
  for (const [payload, status, code] of cases) {
    const res = await postJson(`${harness.url}/voice-mode/speak`, payload);
    assert.equal(res.status, status, `${code} status`);
    assert.equal((await res.json()).error, code);
  }
  const badJson = await postJson(`${harness.url}/voice-mode/speak`, 'not json');
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, 'invalid-json');
  assert.equal(tts.calls.synthesize.length, 0, 'invalid requests never reach the engine');

  const valid = await postJson(`${harness.url}/voice-mode/speak`, { text: 'Hi', sid: 7, speed: 1.25, lang: 'en' });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('x-voice-mode-sid'), '7');
  assert.deepEqual(tts.calls.synthesize[0], { text: 'Hi', sid: 7, speed: 1.25, lang: 'en' });
});

test('POST /voice-mode/speak caps the body size', async (t) => {
  const harness = await startHarness({ config: { limits: { speakBodyBytes: 256 } } });
  t.after(() => harness.close());
  const res = await postJson(`${harness.url}/voice-mode/speak`, { text: 'x'.repeat(600) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'body-too-large');
});

test('POST /voice-mode/speak maps engine unavailability to 503 and crashes to 500', async (t) => {
  const unavailable = createFakeTts({
    error: new VoiceEngineError('tts-unavailable', 'no local engine produced audio', { hint: 'check the model' }),
  });
  const harness = await startHarness({ tts: unavailable.engine });
  t.after(() => harness.close());
  const res = await postJson(`${harness.url}/voice-mode/speak`, { text: 'Hello.' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
  const body = await res.json();
  assert.equal(body.error, 'tts-unavailable');
  assert.equal(body.hint, 'check the model');

  const crashed = createFakeTts({ error: new Error('unexpected native crash') });
  const harness2 = await startHarness({ tts: crashed.engine });
  t.after(() => harness2.close());
  const res2 = await postJson(`${harness2.url}/voice-mode/speak`, { text: 'Hello.' });
  assert.equal(res2.status, 500);
  assert.equal((await res2.json()).error, 'internal-error');
});

test('plugin disposal unregisters routes and disposes the engine', async (t) => {
  const tts = createFakeTts();
  const harness = await startHarness({ tts: tts.engine });
  await harness.close();
  assert.equal(harness.routes.size, 0);
  assert.equal(tts.calls.disposed, true);
});
