import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WAV_HEADER_BYTES,
  buildWav,
  parseWav,
  pcmDurationMs,
  pcmFrameBytes,
} from '../src/wav.js';

test('buildWav frames 48 kHz stereo 16-bit PCM', () => {
  const pcm = Buffer.alloc(48000 * 2 * 2); // one second
  const wav = buildWav(pcm);
  assert.equal(wav.length, WAV_HEADER_BYTES + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1, 'PCM format');
  assert.equal(wav.readUInt16LE(22), 2, 'stereo');
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 48000 * 2 * 2, 'byte rate');
  assert.equal(wav.readUInt16LE(32), 4, 'block align');
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(pcmDurationMs(pcm.length), 1000);
});

test('buildWav rejects invalid input', () => {
  assert.throws(() => buildWav('nope'), TypeError);
  assert.throws(() => buildWav(Buffer.alloc(4), { sampleRate: 0 }), RangeError);
  assert.throws(() => buildWav(Buffer.alloc(4), { channels: 0 }), RangeError);
  assert.throws(() => buildWav(Buffer.alloc(4), { bitsPerSample: 12 }), RangeError);
});

test('parseWav round-trips a built WAV', () => {
  const pcm = Buffer.alloc(1920 * 24); // 240 ms of 48 kHz stereo
  const parsed = parseWav(buildWav(pcm));
  assert.ok(parsed);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.dataLength, pcm.length);
  assert.equal(parsed.dataOffset, WAV_HEADER_BYTES);
  assert.equal(Math.round(parsed.durationMs), 240);
});

test('parseWav rejects non-PCM and truncated buffers', () => {
  assert.equal(parseWav(Buffer.alloc(10)), null);
  const wav = buildWav(Buffer.alloc(100));
  assert.equal(parseWav(wav.subarray(0, 30)), null);

  const badMagic = Buffer.from(wav);
  badMagic.write('XXXX', 0, 'ascii');
  assert.equal(parseWav(badMagic), null);

  const badLength = Buffer.from(wav);
  badLength.writeUInt32LE(999999, 40);
  assert.equal(parseWav(badLength), null);

  const notPcm = Buffer.from(wav);
  notPcm.writeUInt16LE(3, 20); // IEEE float
  assert.equal(parseWav(notPcm), null);
});

test('pcmFrameBytes matches a 20 ms Discord frame', () => {
  assert.equal(pcmFrameBytes(), 3840);
  assert.equal(pcmFrameBytes({ frameMs: 10 }), 1920);
  assert.equal(pcmFrameBytes({ sampleRate: 24000, channels: 1 }), 960);
});

test('pcmDurationMs handles unusual formats', () => {
  assert.equal(pcmDurationMs(0), 0);
  assert.equal(pcmDurationMs(24000 * 2, { sampleRate: 24000, channels: 1 }), 1000);
  assert.equal(pcmDurationMs(3840), 20);
});
