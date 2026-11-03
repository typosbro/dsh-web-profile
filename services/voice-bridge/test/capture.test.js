import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PttCapture } from '../src/capture.js';

const FRAME = Buffer.alloc(3840, 1); // 20 ms at 48 kHz stereo

test('PTT capture records between start and stop', () => {
  const capture = new PttCapture();
  assert.equal(capture.isRecording, false);
  assert.equal(capture.stop(), null, 'stop before start is a no-op');

  capture.start();
  assert.equal(capture.isRecording, true);
  capture.push(FRAME);
  capture.push(FRAME);
  assert.equal(Math.round(capture.bufferedMs), 40);

  const utterance = capture.stop();
  assert.ok(utterance);
  assert.equal(utterance.pcm.length, 7680);
  assert.equal(Math.round(utterance.durationMs), 40);
  assert.equal(utterance.sampleRate, 48000);
  assert.equal(utterance.channels, 2);
  assert.equal(capture.isRecording, false);
  assert.equal(capture.stop(), null, 'second stop returns null');
});

test('PTT capture ignores pushes while not recording and after stop', () => {
  const capture = new PttCapture();
  capture.push(FRAME);
  capture.start();
  capture.push(FRAME);
  const utterance = capture.stop();
  capture.push(FRAME);
  assert.equal(utterance.pcm.length, 3840);
  assert.equal(capture.bufferedMs, 0);
});

test('PTT capture enforces the max duration and reports overflow', () => {
  const capture = new PttCapture({ maxSeconds: 1 }); // 48000 * 2 * 2 bytes
  capture.start();
  for (let index = 0; index < 60; index += 1) capture.push(FRAME);
  const utterance = capture.stop();
  assert.ok(utterance);
  assert.equal(utterance.overflowed, true);
  assert.ok(utterance.pcm.length <= 48000 * 2 * 2);
  assert.ok(Math.round(utterance.durationMs) <= 1000);
});

test('PTT capture returns null for an empty window', () => {
  const capture = new PttCapture();
  capture.start();
  assert.equal(capture.stop(), null);
});

test('reset clears a recording', () => {
  const capture = new PttCapture();
  capture.start();
  capture.push(FRAME);
  capture.reset();
  assert.equal(capture.isRecording, false);
  assert.equal(capture.bufferedMs, 0);
});
