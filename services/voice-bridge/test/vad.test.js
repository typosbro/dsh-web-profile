import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnergyVad } from '../src/vad.js';

const SPEECH_DB = -20;
const SILENCE_DB = null;

function frame(dbfs) {
  const bytes = Buffer.alloc(3840);
  if (dbfs === SILENCE_DB) return bytes;
  const amplitude = Math.round(10 ** (dbfs / 20) * 32767);
  for (let i = 0; i < 1920; i += 1) bytes.writeInt16LE(amplitude, i * 2);
  return bytes;
}

function frames(count, dbfs = SPEECH_DB) {
  return Buffer.concat(Array.from({ length: count }, () => frame(dbfs)));
}

function collect(options = {}) {
  const utterances = [];
  const vad = new EnergyVad(options, { onUtterance: (utterance) => utterances.push(utterance) });
  return { vad, utterances };
}

test('a speech burst surrounded by silence emits one trimmed utterance', () => {
  const { vad, utterances } = collect();

  vad.push(frames(5, SILENCE_DB));
  vad.push(frames(20, SPEECH_DB));
  vad.push(frames(35, SILENCE_DB)); // 700 ms > 600 ms silence hangover

  assert.equal(utterances.length, 1);
  const [utterance] = utterances;
  // 300 ms pre-roll + 400 ms speech; trailing silence is trimmed.
  assert.equal(utterance.durationMs, 500);
  assert.equal(utterance.speechMs, 400);
  assert.equal(utterance.pcm.length, 25 * 3840);
  assert.equal(utterance.sampleRate, 48000);
  assert.equal(utterance.channels, 2);
  assert.equal(vad.stats.utterances, 1);
  assert.equal(vad.stats.lastUtteranceMs, 500);
  assert.equal(vad.isSpeaking, false);
});

test('a blip shorter than minSpeechMs never opens an utterance', () => {
  const { vad, utterances } = collect();
  vad.push(frames(10, SILENCE_DB));
  vad.push(frames(5, SPEECH_DB)); // 100 ms < 200 ms
  vad.push(frames(40, SILENCE_DB));
  assert.equal(utterances.length, 0);
  assert.equal(vad.isSpeaking, false);
});

test('speech shorter than minUtteranceMs is discarded', () => {
  const { vad, utterances } = collect({ minUtteranceMs: 500 });
  vad.push(frames(12, SPEECH_DB)); // 240 ms of speech, above minSpeechMs
  vad.push(frames(35, SILENCE_DB));
  assert.equal(utterances.length, 0, '240 ms is below the 500 ms minimum');
});

test('two separate turns produce two utterances', () => {
  const { vad, utterances } = collect();
  vad.push(frames(20, SPEECH_DB));
  vad.push(frames(35, SILENCE_DB));
  vad.push(frames(20, SPEECH_DB));
  vad.push(frames(35, SILENCE_DB));
  assert.equal(utterances.length, 2);
  assert.equal(vad.stats.utterances, 2);
});

test('arbitrary chunk boundaries produce the same utterance as whole frames', () => {
  const whole = collect();
  whole.vad.push(Buffer.concat([
    frames(5, SILENCE_DB),
    frames(20, SPEECH_DB),
    frames(35, SILENCE_DB),
  ]));

  const chunked = collect();
  const stream = Buffer.concat([
    frames(5, SILENCE_DB),
    frames(20, SPEECH_DB),
    frames(35, SILENCE_DB),
  ]);
  for (let offset = 0; offset < stream.length; offset += 913) {
    chunked.vad.push(stream.subarray(offset, offset + 913));
  }

  assert.equal(chunked.utterances.length, whole.utterances.length);
  assert.equal(chunked.utterances[0].pcm.length, whole.utterances[0].pcm.length);
  assert.ok(chunked.utterances[0].pcm.equals(whole.utterances[0].pcm));
});

test('partial frames stay buffered instead of being dropped', () => {
  const { vad, utterances } = collect();
  const stream = Buffer.concat([frames(20, SPEECH_DB), frames(35, SILENCE_DB)]);
  // Deliberately stop one byte before a full frame boundary first.
  vad.push(stream.subarray(0, 3839));
  vad.push(stream.subarray(3839));
  assert.equal(utterances.length, 1);
});

test('maxUtteranceMs force-splits a long monologue', () => {
  const { vad, utterances } = collect({ maxUtteranceMs: 600, minSpeechMs: 200 });
  vad.push(frames(100, SPEECH_DB));
  assert.equal(utterances.length, 3, 'each 600 ms chunk is emitted while speech continues');
  for (const utterance of utterances) assert.equal(utterance.durationMs, 600);
});

test('flush emits the in-flight utterance and discharge an idle segmenter', () => {
  const { vad, utterances } = collect({ minUtteranceMs: 200 });
  vad.push(frames(5, SILENCE_DB));
  vad.push(frames(15, SPEECH_DB)); // in flight, no trailing silence yet
  assert.equal(utterances.length, 0);
  vad.flush();
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].speechMs, 300);
  assert.equal(vad.isSpeaking, false);

  vad.flush(); // no-op when idle
  assert.equal(utterances.length, 1);
});

test('reset drops buffered audio', () => {
  const { vad, utterances } = collect({ minUtteranceMs: 200 });
  vad.push(frames(15, SPEECH_DB));
  vad.reset();
  vad.push(frames(40, SILENCE_DB));
  assert.equal(utterances.length, 0);
});

test('preRollMs = 0 starts the utterance exactly at speech onset', () => {
  const { vad, utterances } = collect({ preRollMs: 0, minUtteranceMs: 200 });
  vad.push(frames(10, SILENCE_DB));
  vad.push(frames(20, SPEECH_DB));
  vad.push(frames(35, SILENCE_DB));
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].durationMs, 400);
});

test('empty or non-buffer pushes are ignored', () => {
  const { vad, utterances } = collect();
  vad.push(null);
  vad.push(Buffer.alloc(0));
  vad.push('not a buffer');
  assert.equal(utterances.length, 0);
});
