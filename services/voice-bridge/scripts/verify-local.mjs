#!/usr/bin/env node
/**
 * Manual verification against the REAL local services (not part of `pnpm test`).
 *
 *   node scripts/verify-local.mjs
 *
 * Exercises what can be proven without a valid Discord bot token:
 *   1. macOS say -> 48 kHz stereo WAV -> whisper (language=en) transcript;
 *   2. Kokoro TTS -> PCM -> WAV -> whisper round-trip;
 *   3. energy VAD segmentation on synthetic speech + silence;
 *   4. loopback control API over a real HTTP socket;
 *   5. token redaction in log output.
 *
 * It talks to 127.0.0.1:2022 (whisper) and 127.0.0.1:8880 (Kokoro), so start
 * those services first. Exit code 1 if any check fails.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeFileToPcm48Stereo } from '../src/audio.js';
import { createControlServer } from '../src/control.js';
import { runCommand } from '../src/exec.js';
import { createLogger } from '../src/logger.js';
import { transcribeWav } from '../src/stt.js';
import { synthesize } from '../src/tts.js';
import { EnergyVad } from '../src/vad.js';
import { buildWav } from '../src/wav.js';

const STT = {
  url: 'http://127.0.0.1:2022/v1/audio/transcriptions',
  language: 'en',
  model: 'whisper-1',
  timeoutMs: 60000,
};

const CONFIG = {
  ffmpegPath: 'ffmpeg',
  tts: {
    engine: 'kokoro',
    kokoroUrl: 'http://127.0.0.1:8880/v1/audio/speech',
    kokoroVoice: 'af_heart',
    kokoroModel: 'kokoro',
    sayVoice: 'Yuna',
    sayCommand: 'say',
    timeoutMs: 120000,
  },
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
}

async function checkMacSayToWhisper(tempDir) {
  const aiffPath = path.join(tempDir, 'say.aiff');
  const text = 'Hello, this is the voice bridge. The quick brown fox jumps over the lazy dog.';
  await runCommand('say', ['-v', 'Samantha', '-o', aiffPath, text], {
    timeoutMs: 60000,
  });
  const pcm = await decodeFileToPcm48Stereo(aiffPath, { ffmpegPath: 'ffmpeg' });
  const wav = buildWav(pcm);
  const startedAt = Date.now();
  const { text: transcript } = await transcribeWav({ wav, sttConfig: STT });
  const elapsed = Date.now() - startedAt;
  const wordsOk = ['voice', 'bridge', 'quick', 'brown', 'fox'].every((word) =>
    transcript.toLowerCase().includes(word),
  );
  record(
    'say -> 48 kHz WAV -> whisper(en)',
    wordsOk,
    `${(pcm.length / (48000 * 4) * 1000).toFixed(0)} ms audio, ${elapsed} ms STT, transcript: "${transcript}"`,
  );
}

async function checkKokoroRoundTrip() {
  const spoken = 'Good evening operator. The bridge is connected and ready.';
  const startedAt = Date.now();
  const synthesis = await synthesize(spoken, { config: CONFIG });
  const synthMs = Date.now() - startedAt;
  const wav = buildWav(synthesis.pcm);
  const { text: transcript } = await transcribeWav({ wav, sttConfig: STT });
  const audioMs = (synthesis.pcm.length / (48000 * 4)) * 1000;
  const wordsOk = ['evening', 'operator', 'bridge', 'connected', 'ready'].every((word) =>
    transcript.toLowerCase().includes(word),
  );
  record(
    'Kokoro(en) -> PCM -> whisper round-trip',
    synthesis.engine === 'kokoro' && wordsOk,
    `${audioMs.toFixed(0)} ms audio in ${synthMs} ms, transcript: "${transcript}"`,
  );
}

function checkVad() {
  const frame = (speech) => {
    const bytes = Buffer.alloc(3840);
    if (!speech) return bytes;
    for (let i = 0; i < 1920; i += 1) {
      bytes.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000)), i * 2);
    }
    return bytes;
  };
  const utterances = [];
  const vad = new EnergyVad({}, { onUtterance: (utterance) => utterances.push(utterance) });
  vad.push(Buffer.concat(Array.from({ length: 10 }, () => frame(false))));
  vad.push(Buffer.concat(Array.from({ length: 25 }, () => frame(true))));
  vad.push(Buffer.concat(Array.from({ length: 40 }, () => frame(false))));
  record(
    'energy VAD segmentation',
    utterances.length === 1 && utterances[0].speechMs === 500,
    `${utterances.length} utterance(s), ${utterances[0]?.durationMs ?? 0} ms incl. ${utterances[0]?.speechMs ?? 0} ms speech`,
  );
}

async function checkControlApi() {
  const calls = [];
  const control = createControlServer({
    port: 0,
    actions: {
      state: () => ({ connected: true, capture: { mode: 'vad', armed: true } }),
      join: () => calls.push('join'),
      leave: () => calls.push('leave'),
      listenStart: () => calls.push('listenStart'),
      listenStop: () => calls.push('listenStop'),
      say: (text) => {
        calls.push(`say:${text}`);
        return { engine: 'kokoro', audioMs: 1000 };
      },
    },
    logger: null,
  });
  const address = await control.start();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const state = await (await fetch(`${base}/state`)).json();
    const say = await (
      await fetch(`${base}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
    ).json();
    const join = await (await fetch(`${base}/join`, { method: 'POST' })).json();
    const missing = await fetch(`${base}/nope`);
    const ok =
      state.ok &&
      state.state.connected === true &&
      say.ok &&
      say.engine === 'kokoro' &&
      join.ok &&
      missing.status === 404;
    record(
      'loopback control API',
      ok,
      `GET /state 200, POST /say 200, POST /join 200, GET /nope ${missing.status}; calls=${calls.length}`,
    );
  } finally {
    await control.stop();
  }
}

function checkTokenRedaction() {
  const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'fGhIjKlMnOpQrStUvWxYz0123456789abcd'].join('.');
  const captured = [];
  const logger = createLogger({
    name: 'verify',
    secrets: [token],
    sink: { log: (line) => captured.push(line), error: (line) => captured.push(line) },
  });
  logger.info(`pretending to log in with ${token}`);
  const leaked = captured.join('\n').includes(token);
  record('token redaction', !leaked && captured.length === 1, leaked ? 'TOKEN LEAKED' : 'logged line is redacted');
}

async function main() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-voice-verify-'));
  console.log(`# dsh-voice-bridge local verification (${new Date().toISOString()})`);
  console.log(`# whisper ${STT.url}  |  Kokoro ${CONFIG.tts.kokoroUrl}\n`);
  const checks = [
    ['macOS say + whisper', () => checkMacSayToWhisper(tempDir)],
    ['Kokoro + whisper', checkKokoroRoundTrip],
    ['VAD', async () => checkVad()],
    ['control API', checkControlApi],
    ['redaction', async () => checkTokenRedaction()],
  ];
  for (const [name, run] of checks) {
    try {
      await run();
    } catch (error) {
      record(name, false, error.message);
    }
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
