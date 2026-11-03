import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeFileToPcm48Stereo,
  decodeToPcm48Stereo,
  isSpeechFrame,
  rmsDbfs,
} from '../src/audio.js';

/** Build a constant-amplitude stereo s16le frame whose RMS is `dbfs`. */
function frameAt(dbfs, { samples = 960, channels = 2 } = {}) {
  const amplitude = Math.round(10 ** (dbfs / 20) * 32767);
  const frame = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples * channels; i += 1) frame.writeInt16LE(amplitude, i * 2);
  return frame;
}

test('rmsDbfs measures silence and known levels', () => {
  assert.equal(rmsDbfs(Buffer.alloc(3840)), -Infinity);
  assert.equal(rmsDbfs(Buffer.alloc(0)), -Infinity);
  assert.equal(rmsDbfs(null), -Infinity);

  const halfScale = Math.round(0.5 * 32767);
  const buffer = Buffer.alloc(960 * 2 * 2); // 20 ms stereo, constant half scale
  for (let i = 0; i < 960; i += 1) {
    buffer.writeInt16LE(halfScale, i * 2);
    buffer.writeInt16LE(halfScale, (960 + i) * 2);
  }
  assert.ok(Math.abs(rmsDbfs(buffer) - -6.02) < 0.05);
});

test('isSpeechFrame applies the threshold', () => {
  assert.equal(isSpeechFrame(frameAt(-20), -35), true);
  assert.equal(isSpeechFrame(frameAt(-50), -35), false);
  assert.equal(isSpeechFrame(Buffer.alloc(3840), -35), false);
});

test('decodeToPcm48Stereo calls ffmpeg with the right target format', async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: Buffer.from([1, 2, 3, 4]), stderr: Buffer.alloc(0) };
  };
  const input = Buffer.from('fake-wav');
  const pcm = await decodeToPcm48Stereo(input, { ffmpegPath: '/opt/homebrew/bin/ffmpeg', runCommand });

  assert.deepEqual(pcm, Buffer.from([1, 2, 3, 4]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/opt/homebrew/bin/ffmpeg');
  assert.ok(calls[0].args.includes('pipe:0'));
  assert.ok(calls[0].args.includes('pipe:1'));
  assert.equal(calls[0].args[calls[0].args.indexOf('-ar') + 1], '48000');
  assert.equal(calls[0].args[calls[0].args.indexOf('-ac') + 1], '2');
  assert.equal(calls[0].args[calls[0].args.indexOf('-f') + 1], 's16le');
  assert.equal(calls[0].options.input, input);
});

test('decodeToPcm48Stereo rejects empty input before spawning', async () => {
  let called = false;
  await assert.rejects(
    decodeToPcm48Stereo(Buffer.alloc(0), {
      runCommand: async () => {
        called = true;
        return { stdout: Buffer.alloc(0) };
      },
    }),
    TypeError,
  );
  assert.equal(called, false);
});

test('decodeFileToPcm48Stereo passes the file path to ffmpeg', async () => {
  const calls = [];
  await decodeFileToPcm48Stereo('/tmp/tts.aiff', {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: Buffer.alloc(10) };
    },
  });
  assert.ok(calls[0].args.includes('/tmp/tts.aiff'));
  assert.equal(calls[0].command, 'ffmpeg');
});
