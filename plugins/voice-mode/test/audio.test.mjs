/* Unit tests for the dependency-free audio helpers of @local/voice-mode.
 *
 *   node --test test/audio.test.mjs
 *
 * These tests import src/audio.mjs directly as ESM; the browser artifact strips
 * the "export " tokens in scripts/build.mjs, so no browser globals are needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as audio from '../src/audio.mjs';
import { createVad, encodeWav16, float32ToPcm16, resampleLinear, scriptProcessorSizeMs } from '../src/audio.mjs';

const RATE = 16000;
const FRAME = 1600; // 100 ms at 16 kHz
const LOUD = 0.1; // well above both default thresholds
const MID = 0.015; // between continueThreshold (0.012) and startThreshold (0.02)

function approx(actual, expected, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

/** A constant-level frame of `samples` samples. */
function level(value, samples = FRAME) {
  const frame = new Float32Array(samples);
  if (value !== 0) frame.fill(value);
  return frame;
}

function feed(vad, count, value, samples = FRAME) {
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(vad.push(level(value, samples)));
  return results;
}

/* ------------------------------------------------------------------------- *
 * Exported surface
 * ------------------------------------------------------------------------- */

test('exports the dependency-free audio surface', () => {
  for (const name of [
    'createVad',
    'encodeWav16',
    'float32ToPcm16',
    'resampleLinear',
    'scriptProcessorSizeMs',
  ]) {
    assert.equal(typeof audio[name], 'function', `${name} must be exported`);
  }
});

/* ------------------------------------------------------------------------- *
 * scriptProcessorSizeMs
 * ------------------------------------------------------------------------- */

test('scriptProcessorSizeMs derives frame duration from the sample rate', () => {
  assert.equal(scriptProcessorSizeMs(48000, 4096), (4096 / 48000) * 1000);
  approx(scriptProcessorSizeMs(48000, 4096), 85.3333, 1e-3);
  assert.equal(scriptProcessorSizeMs(16000, 1600), 100);
  assert.equal(scriptProcessorSizeMs(8000, 800), 100);
  assert.equal(scriptProcessorSizeMs(0, 4096), 0);
  assert.equal(scriptProcessorSizeMs(48000, 0), 0);
});

/* ------------------------------------------------------------------------- *
 * resampleLinear
 * ------------------------------------------------------------------------- */

test('resampleLinear returns a copy for equal rates', () => {
  const input = new Float32Array([0.25, -0.5, 1, 0]);
  const output = resampleLinear(input, 48000, 48000);
  assert.ok(output instanceof Float32Array);
  assert.notEqual(output, input);
  assert.equal(output.length, input.length);
  assert.deepEqual(Array.from(output), Array.from(input));
});

test('resampleLinear down-samples 48 kHz to 16 kHz with monotonic positions', () => {
  const input = new Float32Array(48);
  for (let i = 0; i < input.length; i += 1) input[i] = i;
  const output = resampleLinear(input, 48000, 16000);
  assert.equal(output.length, Math.round((48 * 16000) / 48000)); // 16
  // source position is exactly 3 * i, so linear interpolation is exact here
  for (let i = 0; i < output.length; i += 1) assert.equal(output[i], input[i * 3]);
  assert.equal(output[0], 0);
  assert.equal(output[15], 45);
});

test('resampleLinear handles the 44.1 kHz to 16 kHz capture path', () => {
  const input = new Float32Array(4410);
  for (let i = 0; i < input.length; i += 1) input[i] = i;
  const output = resampleLinear(input, 44100, 16000);
  assert.equal(output.length, Math.round((4410 * 16000) / 44100)); // 1600
  assert.equal(output[0], input[0]);
  for (let i = 1; i < output.length; i += 1) assert.ok(output[i] >= output[i - 1], 'monotonic input stays monotonic');
  assert.ok(output.every((value) => Number.isFinite(value)));
  // a position between source samples interpolates linearly
  approx(output[1], input[2] + (input[3] - input[2]) * 0.75625, 1e-3);
});

test('resampleLinear honours the exact output-length formula', () => {
  const output = resampleLinear(new Float32Array(1000), 48000, 44100);
  assert.equal(output.length, Math.round((1000 * 44100) / 48000)); // 919
  assert.ok(output.every((value) => value === 0));
});

test('resampleLinear up-samples and clamps the last source sample', () => {
  const input = new Float32Array([0, 0.25, 0.5, 1]);
  const output = resampleLinear(input, 16000, 48000);
  assert.equal(output.length, 12);
  assert.equal(output[0], 0);
  assert.equal(output[11], 1);
});

test('resampleLinear handles empty input and rejects bad rates', () => {
  const empty = resampleLinear(new Float32Array(0), 48000, 16000);
  assert.ok(empty instanceof Float32Array);
  assert.equal(empty.length, 0);
  assert.throws(() => resampleLinear(new Float32Array(4), 0, 16000), RangeError);
  assert.throws(() => resampleLinear(new Float32Array(4), 16000, Number.NaN), RangeError);
  // plain arrays are accepted by the same contract
  assert.deepEqual(Array.from(resampleLinear([0, 1, 2, 3], 16000, 16000)), [0, 1, 2, 3]);
});

/* ------------------------------------------------------------------------- *
 * PCM16 / WAV encoding
 * ------------------------------------------------------------------------- */

test('float32ToPcm16 clamps and scales like the harness encodeWave', () => {
  const pcm = float32ToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]));
  assert.ok(pcm instanceof Int16Array);
  assert.equal(pcm.length, 7);
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 16384); // round(0.5 * 32767)
  assert.equal(pcm[2], -16384); // round(-0.5 * 32768)
  assert.equal(pcm[3], 32767);
  assert.equal(pcm[4], -32768);
  assert.equal(pcm[5], 32767);
  assert.equal(pcm[6], -32768);
  // non-finite samples become silence rather than garbage
  assert.deepEqual(Array.from(float32ToPcm16(new Float32Array([NaN, Infinity, -Infinity]))), [0, 32767, -32768]);
  assert.equal(float32ToPcm16(new Float32Array(0)).length, 0);
});

test('encodeWav16 writes a canonical mono PCM16 header', () => {
  const samples = new Float32Array([0.5, -0.5, 0, 1, -1]);
  const bytes = encodeWav16(samples, 16000);
  const view = new DataView(bytes.buffer);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 44 + samples.length * 2);
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(4, true), bytes.length - 8); // RIFF chunk size
  assert.equal(view.getUint32(16, true), 16); // fmt chunk size
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000); // sample rate
  assert.equal(view.getUint32(28, true), 32000); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), samples.length * 2); // data size

  const pcm = float32ToPcm16(samples);
  for (let i = 0; i < pcm.length; i += 1) assert.equal(view.getInt16(44 + i * 2, true), pcm[i]);
});

test('encodeWav16 tracks the requested sample rate and clips samples', () => {
  const bytes = encodeWav16(new Float32Array([2, -2, 1, -1]), 48000);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 96000);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
  assert.equal(view.getInt16(50, true), -32768);
});

test('encodeWav16 writes a valid empty payload', () => {
  const bytes = encodeWav16(new Float32Array(0), 16000);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.length, 44);
  assert.equal(view.getUint32(4, true), 36);
  assert.equal(view.getUint32(40, true), 0);
});

/* ------------------------------------------------------------------------- *
 * VAD: idle behaviour
 * ------------------------------------------------------------------------- */

test('a silent room never enters speech', () => {
  const vad = createVad({ sampleRate: RATE });
  const results = feed(vad, 40, 0);
  assert.ok(results.every((result) => result === 'idle'));
  assert.equal(vad.state, 'idle');
  assert.equal(vad.speechMs, 0);
  assert.equal(vad.takeUtterance().length, 0);
  // an empty frame is ignored rather than counted as silence
  assert.equal(vad.push(new Float32Array(0)), 'idle');
  assert.equal(vad.state, 'idle');
});

test('a 100 ms blip does not trigger speech (door slam)', () => {
  const vad = createVad({ sampleRate: RATE });
  const results = [vad.push(level(LOUD)), ...feed(vad, 10, 0)];
  assert.ok(results.every((result) => result === 'idle'));
  assert.equal(vad.state, 'idle');
  assert.equal(vad.speechMs, 0);
  assert.equal(vad.takeUtterance().length, 0);
});

test('200 ms of loud frames enters speech, then silence ends it exactly once', () => {
  const vad = createVad({ sampleRate: RATE });
  const results = [];
  results.push(vad.push(level(LOUD)));
  assert.equal(results[0], 'idle'); // 100 ms of sustained speech < startMs
  results.push(vad.push(level(LOUD)));
  assert.equal(results[1], 'speech'); // 200 ms >= startMs
  assert.equal(vad.state, 'speech');
  assert.equal(vad.speechMs, 200);

  assert.deepEqual(feed(vad, 6, 0), ['speech', 'speech', 'speech', 'speech', 'speech', 'speech']);
  assert.equal(vad.state, 'speech'); // 600 ms of silence is not enough yet
  results.push(vad.push(level(0)));
  assert.equal(results[2], 'ended'); // 700 ms of silence closes the utterance
  assert.equal(vad.state, 'ended');
  assert.equal(results.filter((result) => result === 'ended').length, 1);
  // 200 ms of speech is below the default minSpeechMs: reported, not transcribable
  assert.equal(vad.speechMs, 200);
  assert.equal(vad.takeUtterance().length, 0);

  // the next frame re-arms the detector; 'ended' is never reported twice
  assert.deepEqual(feed(vad, 3, 0), ['idle', 'idle', 'idle']);
  assert.equal(vad.state, 'idle');
});

/* ------------------------------------------------------------------------- *
 * VAD: utterance capture
 * ------------------------------------------------------------------------- */

test('takeUtterance returns pre-roll + speech + a short tail exactly', () => {
  const vad = createVad({ sampleRate: RATE });
  for (let i = 0; i < 5; i += 1) assert.equal(vad.push(level(0)), 'idle'); // 500 ms room tone
  assert.equal(vad.push(level(LOUD)), 'idle'); // 100 ms, candidate only
  assert.equal(vad.push(level(LOUD)), 'speech'); // 200 ms, speech confirmed
  assert.equal(vad.push(level(LOUD)), 'speech'); // 300 ms
  assert.equal(vad.speechMs, 300);

  let ended = 0;
  for (let i = 0; i < 7; i += 1) {
    const result = vad.push(level(0));
    if (result === 'ended') ended += 1;
    else assert.equal(result, 'speech');
  }
  assert.equal(ended, 1);
  assert.equal(vad.state, 'ended');

  const utterance = vad.takeUtterance();
  assert.ok(utterance instanceof Float32Array);
  // 250 ms pre-roll + 300 ms speech + 200 ms kept tail = 750 ms = 12000 samples
  assert.equal(utterance.length, 12000);
  assert.ok(utterance.every((value) => Number.isFinite(value)));
  // the window opens 250 ms before the onset: the first 4000 samples are room tone
  approx(utterance[0], 0);
  approx(utterance[3999], 0);
  approx(utterance[4000], LOUD);
  approx(utterance[8799], LOUD);
  // trailing silence beyond ~200 ms is dropped
  approx(utterance[8800], 0);
  approx(utterance[11999], 0);
  assert.ok(utterance.length > 4800 + 3200); // pre-roll really is included

  // takeUtterance returns a fresh copy and is idempotent
  utterance[4000] = 9;
  const again = vad.takeUtterance();
  assert.equal(again.length, 12000);
  approx(again[4000], LOUD);
});

test('maxUtteranceMs force-closes a pathological utterance', () => {
  const vad = createVad({ sampleRate: RATE, maxUtteranceMs: 500 });
  const results = feed(vad, 5, LOUD);
  assert.deepEqual(results.slice(0, 2), ['idle', 'speech']);
  assert.deepEqual(results.slice(2, 4), ['speech', 'speech']);
  assert.equal(results[4], 'ended');
  assert.equal(results.filter((result) => result === 'ended').length, 1);
  assert.equal(vad.state, 'ended');
  assert.equal(vad.speechMs, 500);

  const utterance = vad.takeUtterance();
  assert.equal(utterance.length, 8000); // all 500 ms; there was no pre-roll history
  approx(utterance[0], LOUD);
  approx(utterance[7999], LOUD);
});

test('reset clears state, counters, and the captured utterance', () => {
  const vad = createVad({ sampleRate: RATE });
  vad.push(level(LOUD));
  assert.equal(vad.push(level(LOUD)), 'speech');
  assert.equal(vad.state, 'speech');
  assert.equal(vad.reset(), undefined);
  assert.equal(vad.state, 'idle');
  assert.equal(vad.speechMs, 0);
  assert.equal(vad.takeUtterance().length, 0);

  // a blip after reset starts a fresh candidate, not a continuation
  assert.equal(vad.push(level(LOUD)), 'idle');
  assert.equal(vad.state, 'idle');

  // capture a real utterance again, then reset from 'ended'
  assert.equal(vad.push(level(LOUD)), 'speech');
  assert.equal(vad.push(level(LOUD)), 'speech');
  assert.deepEqual(feed(vad, 7, 0), [
    'speech',
    'speech',
    'speech',
    'speech',
    'speech',
    'speech',
    'ended',
  ]);
  assert.equal(vad.takeUtterance().length, 8000); // 300 ms speech + 200 ms tail
  vad.reset();
  assert.equal(vad.state, 'idle');
  assert.equal(vad.takeUtterance().length, 0);
});

test('an utterance shorter than minSpeechMs is reported but discarded', () => {
  const vad = createVad({ sampleRate: RATE });
  vad.push(level(LOUD));
  assert.equal(vad.push(level(LOUD)), 'speech'); // 200 ms < 250 ms default
  assert.deepEqual(feed(vad, 7, 0).slice(-1), ['ended']);
  assert.equal(vad.state, 'ended');
  assert.equal(vad.speechMs, 200);
  assert.equal(vad.takeUtterance().length, 0);

  const shortVad = createVad({ sampleRate: RATE, minSpeechMs: 100 });
  shortVad.push(level(LOUD));
  assert.equal(shortVad.push(level(LOUD)), 'speech');
  feed(shortVad, 7, 0);
  assert.equal(shortVad.state, 'ended');
  // 200 ms speech + 200 ms kept tail; the 500 ms of extra silence was trimmed
  assert.equal(shortVad.takeUtterance().length, 6400);
});

/* ------------------------------------------------------------------------- *
 * VAD: thresholds and timing options
 * ------------------------------------------------------------------------- */

test('continueThreshold keeps one quiet syllable from ending an utterance', () => {
  const vad = createVad({ sampleRate: RATE });
  vad.push(level(LOUD));
  assert.equal(vad.push(level(LOUD)), 'speech');
  assert.equal(vad.speechMs, 200);

  // one 800 ms frame at a level above continueThreshold but below startThreshold
  const quietSyllable = level(MID, 12800);
  assert.equal(vad.push(quietSyllable), 'speech');
  assert.equal(vad.state, 'speech');
  assert.equal(vad.speechMs, 1000); // 200 + 800: counted as speech, not silence

  assert.deepEqual(feed(vad, 7, 0).slice(-1), ['ended']);
  assert.equal(vad.speechMs, 1000);
  assert.equal(vad.state, 'ended');
  // 200 ms + 800 ms speech, 200 ms kept tail; 500 ms of trailing silence trimmed
  assert.equal(vad.takeUtterance().length, 19200);
  approx(vad.takeUtterance()[3200], MID); // the quiet syllable is in the audio

  // the same mid-level frame in idle does not start an utterance
  const idleVad = createVad({ sampleRate: RATE });
  assert.deepEqual(feed(idleVad, 2, MID), ['idle', 'idle']);
  assert.equal(idleVad.state, 'idle');
});

test('setThresholds retunes live without touching state or captured audio', () => {
  const vad = createVad({ sampleRate: RATE });
  const mid = level(MID); // between the default continue and start thresholds
  assert.deepEqual(feed(vad, 2, MID), ['idle', 'idle']);
  assert.equal(vad.state, 'idle');

  // lowering startThreshold live lets mid-level frames start speech
  assert.equal(vad.setThresholds({ startThreshold: 0.01 }), undefined);
  assert.equal(vad.state, 'idle'); // no state change
  assert.equal(vad.speechMs, 0); // no counter change
  assert.equal(vad.push(mid), 'idle'); // first 100 ms of sustained speech
  assert.equal(vad.push(mid), 'speech'); // 200 ms >= startMs
  assert.equal(vad.state, 'speech');
  assert.equal(vad.speechMs, 200);

  // at the old continue threshold a mid-level frame still counts as speech
  assert.equal(vad.push(mid), 'speech');
  assert.equal(vad.speechMs, 300);
  const capturedBefore = vad.speechMs;

  // raising continueThreshold live changes the decision for the same frame level
  vad.setThresholds({ continueThreshold: 0.03 });
  assert.equal(vad.state, 'speech'); // state untouched
  assert.equal(vad.speechMs, capturedBefore); // counters untouched
  const results = feed(vad, 7, MID);
  assert.deepEqual(results.slice(0, 6), ['speech', 'speech', 'speech', 'speech', 'speech', 'speech']);
  assert.equal(results[6], 'ended'); // same frames now count as silence
  assert.equal(vad.state, 'ended');
  assert.equal(vad.speechMs, 300);

  // the captured buffer was not disturbed: 200 ms of pre-roll from the idle
  // frames, 2 candidate frames, 1 speech frame, 7 now-silent frames, with
  // 500 ms of trailing silence trimmed
  assert.equal(vad.takeUtterance().length, 11200);

  // reset keeps the configured thresholds (missing keys keep the current value)
  vad.reset();
  assert.deepEqual(feed(vad, 2, MID), ['idle', 'speech']);

  // invalid values are ignored instead of adopted
  const invalid = createVad({ sampleRate: RATE });
  invalid.setThresholds({ startThreshold: -5, continueThreshold: 0 });
  invalid.setThresholds(null);
  assert.deepEqual(feed(invalid, 2, MID), ['idle', 'idle']);
  assert.equal(invalid.state, 'idle');
});

test('VAD timing options are plumbed through', () => {
  // a longer startMs demands more sustained speech
  const slow = createVad({ sampleRate: RATE, startMs: 300 });
  assert.deepEqual(feed(slow, 2, LOUD), ['idle', 'idle']); // 200 ms < 300 ms
  assert.equal(slow.push(level(LOUD)), 'speech'); // 300 ms
  assert.equal(slow.speechMs, 300);

  // preRollMs: 0 starts the utterance exactly at the onset
  const noPreRoll = createVad({ sampleRate: RATE, preRollMs: 0 });
  feed(noPreRoll, 5, 0);
  assert.deepEqual(feed(noPreRoll, 3, LOUD), ['idle', 'speech', 'speech']);
  feed(noPreRoll, 7, 0);
  assert.equal(noPreRoll.state, 'ended');
  assert.equal(noPreRoll.takeUtterance().length, 8000); // 300 ms speech + 200 ms tail
});

test('VAD milliseconds are derived from sampleRate, not a fixed frame count', () => {
  const vad = createVad({ sampleRate: 8000 });
  const frame = level(LOUD, 800); // 100 ms at 8 kHz
  assert.equal(vad.push(frame), 'idle');
  assert.equal(vad.push(frame), 'speech');
  assert.equal(vad.speechMs, 200);
  assert.equal(vad.push(frame), 'speech');
  assert.equal(vad.speechMs, 300); // 300 ms of speech clears minSpeechMs
  for (let i = 0; i < 7; i += 1) vad.push(level(0, 800));
  assert.equal(vad.state, 'ended');
  // 300 ms speech + 200 ms kept tail at 8 kHz = 4000 samples
  assert.equal(vad.takeUtterance().length, 4000);
});
