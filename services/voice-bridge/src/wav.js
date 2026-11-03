/**
 * WAV (RIFF/PCM) framing helpers.
 *
 * Capture output is 16-bit signed little-endian PCM and is posted to the
 * whisper.cpp server as a WAV file. Discord voice is 48 kHz stereo.
 */

export const WAV_HEADER_BYTES = 44;

export function buildWav(
  pcm,
  { sampleRate = 48000, channels = 2, bitsPerSample = 16 } = {},
) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError('pcm must be a Buffer');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`invalid sampleRate: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError(`invalid channels: ${channels}`);
  }
  if (!Number.isInteger(bitsPerSample) || bitsPerSample <= 0 || bitsPerSample % 8 !== 0) {
    throw new RangeError(`invalid bitsPerSample: ${bitsPerSample}`);
  }

  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Parse a canonical 44-byte-header PCM RIFF/WAVE buffer.
 * Returns null when the buffer is not a PCM WAV this project can read.
 */
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < WAV_HEADER_BYTES) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return null;
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (audioFormat !== 1) return null;
  if (buffer.toString('ascii', 36, 40) !== 'data') return null;
  const dataLength = buffer.readUInt32LE(40);
  if (dataLength > buffer.length - WAV_HEADER_BYTES) return null;
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataOffset: WAV_HEADER_BYTES,
    dataLength,
    durationMs: (dataLength / (sampleRate * channels * (bitsPerSample / 8))) * 1000,
  };
}

export function pcmDurationMs(
  byteLength,
  { sampleRate = 48000, channels = 2, bitsPerSample = 16 } = {},
) {
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (bytesPerSecond <= 0) return 0;
  return (byteLength / bytesPerSecond) * 1000;
}

export function pcmFrameBytes({ sampleRate = 48000, channels = 2, bitsPerSample = 16, frameMs = 20 } = {}) {
  return (sampleRate * frameMs * channels * bitsPerSample) / 1000 / 8;
}
