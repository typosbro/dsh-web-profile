import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TtsError, synthesize } from '../src/tts.js';
import { buildWav } from '../src/wav.js';

const PCM_48K = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

function config(overrides = {}) {
  return {
    ffmpegPath: 'ffmpeg',
    tts: {
      engine: 'kokoro',
      kokoroUrl: 'http://127.0.0.1:8880/v1/audio/speech',
      kokoroVoice: 'af_heart',
      kokoroModel: 'kokoro',
      sayVoice: 'Yuna',
      sayCommand: 'say',
      timeoutMs: 5000,
      ...overrides,
    },
  };
}

function kokoroWav() {
  return buildWav(Buffer.alloc(2400), { sampleRate: 24000, channels: 1 });
}

function audioFetch({ ok = true, body = kokoroWav(), status = 200 } = {}) {
  return async (url, init) => {
    if (init) audioFetch.lastRequest = { url, init };
    return {
      ok,
      status,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      text: async () => 'kokoro said no',
    };
  };
}

function ffmpegRun(calls) {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout: PCM_48K, stderr: Buffer.alloc(0) };
  };
}

test('English text goes to Kokoro and is resampled to 48 kHz stereo PCM', async () => {
  const calls = [];
  const fetchImpl = audioFetch();
  const result = await synthesize('Hello from the bridge', {
    config: config(),
    fetchImpl,
    runCommand: ffmpegRun(calls),
  });

  assert.equal(result.engine, 'kokoro');
  assert.equal(result.language, 'en');
  assert.equal(result.voice, 'af_heart');
  assert.deepEqual(result.pcm, PCM_48K);
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.channels, 2);

  const request = audioFetch.lastRequest;
  assert.equal(request.url, 'http://127.0.0.1:8880/v1/audio/speech');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'kokoro',
    input: 'Hello from the bridge',
    voice: 'af_heart',
    response_format: 'wav',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.ok(calls[0].args.includes('pipe:0'));
  assert.equal(calls[0].args[calls[0].args.indexOf('-ar') + 1], '48000');
  assert.equal(calls[0].args[calls[0].args.indexOf('-ac') + 1], '2');
});

test('Kokoro failures raise TtsError', async () => {
  await assert.rejects(
    synthesize('Hello', {
      config: config(),
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => 'TTS failed',
      }),
    }),
    (error) => {
      assert.ok(error instanceof TtsError);
      assert.match(error.message, /Kokoro HTTP 500/);
      return true;
    },
  );

  await assert.rejects(
    synthesize('Hello', {
      config: config(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('not a wav').buffer,
      }),
    }),
    /did not return a WAV/,
  );

  await assert.rejects(
    synthesize('Hello', {
      config: config(),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
    /Kokoro request failed/,
  );
});

test('empty text is rejected before any engine call', async () => {
  let called = false;
  await assert.rejects(
    synthesize('   ', {
      config: config(),
      fetchImpl: async () => {
        called = true;
      },
    }),
    TtsError,
  );
  assert.equal(called, false);
});

test('engine "auto" routes Hangul to macOS say and cleans up its temp dir', async () => {
  const calls = [];
  let tempPath = null;
  const makeTempDir = async () => {
    tempPath = await mkdtemp(path.join(tmpdir(), 'dsh-voice-test-'));
    return tempPath;
  };
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === 'say') return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    return { stdout: PCM_48K, stderr: Buffer.alloc(0) };
  };

  const result = await synthesize('안녕하세요', {
    config: config({ engine: 'auto' }),
    runCommand,
    makeTempDir,
  });

  assert.equal(result.engine, 'say');
  assert.equal(result.language, 'ko');
  assert.equal(result.voice, 'Yuna');
  assert.deepEqual(result.pcm, PCM_48K);

  const sayCall = calls.find((call) => call.command === 'say');
  assert.ok(sayCall, 'say was invoked');
  assert.ok(sayCall.args.includes('-v'));
  assert.ok(sayCall.args.includes('Yuna'));
  assert.ok(sayCall.args.includes('안녕하세요'));
  const aiffPath = sayCall.args[sayCall.args.indexOf('-o') + 1];
  assert.match(aiffPath, /tts\.aiff$/);

  const ffmpegCall = calls.find((call) => call.command === 'ffmpeg');
  assert.ok(ffmpegCall.args.includes(aiffPath));

  await assert.rejects(access(tempPath), /ENOENT/, 'temp dir is removed');
});

test('engine "kokoro" sends Korean text to Kokoro anyway (English-only MVP)', async () => {
  const fetchImpl = audioFetch();
  const result = await synthesize('안녕하세요', {
    config: config({ engine: 'kokoro' }),
    fetchImpl,
    runCommand: ffmpegRun([]),
  });
  assert.equal(result.engine, 'kokoro');
  assert.equal(JSON.parse(audioFetch.lastRequest.init.body).voice, 'af_heart');
});

test('say failures surface as TtsError and still clean up', async () => {
  let tempPath = null;
  const makeTempDir = async () => {
    tempPath = await mkdtemp(path.join(tmpdir(), 'dsh-voice-test-'));
    return tempPath;
  };
  await assert.rejects(
    synthesize('안녕하세요', {
      config: config({ engine: 'auto' }),
      makeTempDir,
      runCommand: async (command) => {
        if (command === 'say') throw new Error('voice not found');
        return { stdout: Buffer.alloc(0) };
      },
    }),
    (error) => {
      assert.ok(error instanceof TtsError);
      assert.match(error.message, /voice not found/);
      return true;
    },
  );
  await assert.rejects(access(tempPath), /ENOENT/);
});
