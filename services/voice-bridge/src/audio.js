/**
 * PCM helpers.
 *
 * Discord voice in and out is 16-bit signed little-endian PCM, 48 kHz,
 * stereo. Speech-to-text gets WAV, playback gets raw PCM.
 */
import { runCommand as defaultRunCommand } from './exec.js';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
/** One 20 ms Discord audio frame: 960 samples * 2 channels * 2 bytes. */
export const FRAME_BYTES = 3840;

/**
 * Root-mean-square level of an s16le PCM buffer in dBFS (0 = full scale).
 * Channels are averaged; silence yields -Infinity.
 */
export function rmsDbfs(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < BYTES_PER_SAMPLE) return -Infinity;
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/** True when the chunk is loud enough to count as speech for barge-in. */
export function isSpeechFrame(pcm, thresholdDbfs = -35) {
  return rmsDbfs(pcm) >= thresholdDbfs;
}

/** Concatenate a list of PCM chunks into one buffer. */
export function concatPcm(chunks) {
  return Buffer.concat(chunks);
}

/**
 * Convert any ffmpeg-decodable audio buffer (WAV, AIFF, ...) to 48 kHz stereo
 * s16le PCM. `runCommand` is injectable so tests never spawn ffmpeg.
 */
export async function decodeToPcm48Stereo(
  input,
  { ffmpegPath = 'ffmpeg', runCommand = defaultRunCommand, timeoutMs = 60000 } = {},
) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new TypeError('decodeToPcm48Stereo needs a non-empty Buffer');
  }
  const { stdout } = await runCommand(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      'pipe:1',
    ],
    { input, timeoutMs },
  );
  return stdout;
}

/** Convert an on-disk audio file to 48 kHz stereo s16le PCM (used for `say`). */
export async function decodeFileToPcm48Stereo(
  filePath,
  { ffmpegPath = 'ffmpeg', runCommand = defaultRunCommand, timeoutMs = 60000 } = {},
) {
  const { stdout } = await runCommand(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      'pipe:1',
    ],
    { timeoutMs },
  );
  return stdout;
}
