import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SttError,
  cleanTranscript,
  normalizeTranscript,
  transcribePcm,
  transcribeWav,
} from '../src/stt.js';
import { buildWav } from '../src/wav.js';

const STT = {
  url: 'http://127.0.0.1:2022/v1/audio/transcriptions',
  language: 'en',
  model: 'whisper-1',
  timeoutMs: 5000,
};

function okResponse(text) {
  return { ok: true, status: 200, json: async () => ({ text }) };
}

test('transcribeWav posts multipart audio with an EXPLICIT language', async () => {
  const wav = buildWav(Buffer.alloc(3840));
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return okResponse(' hello from the bridge ');
  };

  const result = await transcribeWav({ wav, sttConfig: STT, fetchImpl });
  assert.equal(result.text, 'hello from the bridge');
  assert.equal(result.language, 'en');
  assert.equal(captured.url, STT.url);
  assert.equal(captured.init.method, 'POST');

  const body = captured.init.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('model'), 'whisper-1');
  assert.equal(body.get('language'), 'en', 'language must never be omitted');
  assert.equal(body.get('response_format'), 'json');
  const file = body.get('file');
  assert.equal(file.name, 'utterance.wav');
  assert.equal(file.type, 'audio/wav');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(wav));
});

test('transcribeWav passes whatever language the config names', async () => {
  let language;
  await transcribeWav({
    wav: buildWav(Buffer.alloc(100)),
    sttConfig: { ...STT, language: 'ko' },
    fetchImpl: async (url, init) => {
      language = init.body.get('language');
      return okResponse('안녕하세요');
    },
  });
  assert.equal(language, 'ko');
});

test('transcribeWav surfaces HTTP errors with status and snippet', async () => {
  await assert.rejects(
    transcribeWav({
      wav: buildWav(Buffer.alloc(100)),
      sttConfig: STT,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => 'model not loaded',
      }),
    }),
    (error) => {
      assert.ok(error instanceof SttError);
      assert.equal(error.status, 503);
      assert.match(error.message, /503/);
      assert.match(error.message, /model not loaded/);
      return true;
    },
  );
});

test('transcribeWav reports network failures and invalid JSON', async () => {
  await assert.rejects(
    transcribeWav({
      wav: buildWav(Buffer.alloc(100)),
      sttConfig: STT,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:2022');
      },
    }),
    /whisper request failed: connect ECONNREFUSED/,
  );

  await assert.rejects(
    transcribeWav({
      wav: buildWav(Buffer.alloc(100)),
      sttConfig: STT,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('unexpected token');
        },
      }),
    }),
    /invalid JSON/,
  );
});

test('empty transcripts are rejected', async () => {
  await assert.rejects(
    transcribeWav({
      wav: buildWav(Buffer.alloc(100)),
      sttConfig: STT,
      fetchImpl: async () => okResponse(' [BLANK_AUDIO] '),
    }),
    /empty transcript/,
  );
});

test('transcribePcm wraps PCM in a valid WAV before posting', async () => {
  let received;
  const result = await transcribePcm({
    pcm: Buffer.alloc(3840),
    config: { stt: STT },
    fetchImpl: async (url, init) => {
      received = Buffer.from(await init.body.get('file').arrayBuffer());
      return okResponse('what time is it');
    },
  });
  assert.equal(result.text, 'what time is it');
  assert.equal(received.toString('ascii', 0, 4), 'RIFF');
  assert.equal(received.readUInt32LE(24), 48000);
  assert.equal(received.readUInt16LE(22), 2);
  assert.equal(received.length, 44 + 3840);
});

test('transcribePcm rejects empty audio before any request', async () => {
  let called = false;
  await assert.rejects(
    transcribePcm({
      pcm: Buffer.alloc(0),
      config: { stt: STT },
      fetchImpl: async () => {
        called = true;
        return okResponse('x');
      },
    }),
    SttError,
  );
  assert.equal(called, false);
});

test('normalizeTranscript handles verbose segment payloads and markers', () => {
  assert.equal(normalizeTranscript({ text: '  hello  ' }), 'hello');
  assert.equal(
    normalizeTranscript({ segments: [{ text: 'hello' }, { text: 'world' }] }),
    'hello world',
  );
  assert.equal(normalizeTranscript({ text: '' }), '');
  assert.equal(normalizeTranscript(null), '');
  assert.equal(cleanTranscript('[BLANK_AUDIO] (inaudible)  hi   there '), 'hi there');
  assert.equal(cleanTranscript(undefined), '');
});
