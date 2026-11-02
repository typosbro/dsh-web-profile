/**
 * voice-mode — pure WAV helpers for the Host half.
 *
 * Canonical PCM16 WAV encoding backs the `/voice-mode/speak` response, and a
 * tolerant RIFF parser reads recordings back from the macOS `say` fallback:
 * `say` and `afconvert` write extra metadata chunks (FLLR, LIST, ...), so the
 * audio payload does not reliably start at byte 44.
 *
 * No Node-only APIs here (Uint8Array/DataView only), so `node --test` covers
 * every branch headlessly. The encoder matches the harness's browser
 * `encodeWave`: clamp to [-1, 1] and scale negatives by 32768 and positives by
 * 32767, so a re-encoded recording round-trips through the same codec.
 */

/** Canonical PCM16 mono WAV header length. */
export const WAV_HEADER_BYTES = 44;

/** RIFF `fmt ` audio format tags understood by {@link parseWav}. */
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** Bytes per sample for the bit depths {@link parseWav} decodes. */
const BYTES_PER_SAMPLE = new Map([
  [8, 1],
  [16, 2],
  [24, 3],
  [32, 4],
]);

/**
 * Coerce an audio buffer-ish value to `Uint8Array` without copying.
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} audio - caller-supplied bytes.
 * @returns {Uint8Array} a view over the same memory.
 */
export function toBytes(audio) {
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio)) return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  throw new TypeError('Audio must be a Uint8Array, an ArrayBuffer, or a view over one');
}

/**
 * Clamp one sample into the PCM16 domain; NaN reads as silence.
 * @param {number} sample - floating-point sample.
 * @returns {number} value in [-1, 1].
 */
function clampSample(sample) {
  if (!Number.isFinite(sample)) return 0;
  return sample < -1 ? -1 : sample > 1 ? 1 : sample;
}

/**
 * Convert floating-point samples to signed 16-bit PCM using the harness scaling.
 * @param {ArrayLike<number>} samples - samples, nominally in [-1, 1].
 * @returns {Int16Array} one PCM16 value per input sample.
 */
export function float32ToPcm16(samples) {
  if (samples === undefined || samples === null || typeof samples.length !== 'number') {
    throw new TypeError('samples must be an array-like of numbers');
  }
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clampSample(samples[index]);
    out[index] = Math.round(value * (value < 0 ? 32768 : 32767));
  }
  return out;
}

/**
 * Encode mono floating-point samples as a canonical 44-byte-header PCM16 WAV.
 * @param {ArrayLike<number>} samples - mono samples, nominally in [-1, 1].
 * @param {number} sampleRate - positive integer sample rate in Hz.
 * @returns {Uint8Array} complete little-endian WAV bytes.
 */
export function encodeWav16(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError('sampleRate must be a positive integer');
  }
  const pcm = samples instanceof Int16Array ? samples : float32ToPcm16(samples);
  const dataBytes = pcm.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const header = new DataView(bytes.buffer);
  const writeAscii = (at, text) => {
    for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  header.setUint32(4, bytes.length - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, FORMAT_PCM, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  writeAscii(36, 'data');
  header.setUint32(40, dataBytes, true);
  const payload = new DataView(bytes.buffer, WAV_HEADER_BYTES, dataBytes);
  for (let index = 0; index < pcm.length; index += 1) payload.setInt16(index * 2, pcm[index], true);
  return bytes;
}

/**
 * Read a signed little-endian PCM sample at a byte offset.
 * @param {Uint8Array} bytes - sample buffer.
 * @param {DataView} view - view over the same memory.
 * @param {number} offset - byte offset of the first sample byte.
 * @param {number} bitsPerSample - 8, 16, 24, or 32.
 * @param {number} format - RIFF audio format tag (PCM or float).
 * @returns {number} normalised sample in [-1, 1].
 */
function readSample(bytes, view, offset, bitsPerSample, format) {
  if (bitsPerSample === 8) return (bytes[offset] - 128) / 128;
  if (bitsPerSample === 16) {
    const value = view.getInt16(offset, true);
    return value / (value < 0 ? 32768 : 32767);
  }
  if (bitsPerSample === 24) {
    let value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    if ((value & 0x800000) !== 0) value -= 0x1000000;
    return value / 8388608;
  }
  if (format === FORMAT_FLOAT) return view.getFloat32(offset, true);
  const value = view.getInt32(offset, true);
  return value / (value < 0 ? 2147483648 : 2147483647);
}

/**
 * Read one RIFF/WAVE file tolerantly: any chunk order, extra metadata chunks,
 * mono or stereo, PCM 8/16/24/32-bit, or 32-bit float.
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} audio - complete file bytes.
 * @returns {{samples: Float32Array, sampleRate: number, channels: number, bitsPerSample: number, durationSeconds: number}} decoded audio.
 * @throws {Error} when the bytes are not a readable WAVE file.
 */
export function parseWav(audio) {
  const bytes = toBytes(audio);
  if (bytes.length < 12) throw new Error('WAV data is too short to hold a RIFF header');
  const fourcc = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format;
  let channels;
  let sampleRate;
  let bitsPerSample;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new Error('WAV fmt chunk is truncated');
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE stores the real tag in the first two GUID bytes.
      if (format === FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= bytes.length) {
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, bytes.length - body);
      break;
    }
    // RIFF chunks are word-aligned: an odd body is padded by one byte.
    offset = body + size + (size % 2);
  }

  if (format === undefined) throw new Error('WAV file has no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV file has no data chunk');
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) throw new Error(`Unsupported WAV audio format: ${format}`);
  if (channels !== 1 && channels !== 2) throw new Error(`Unsupported WAV channel count: ${channels}`);
  const bytesPerSample = BYTES_PER_SAMPLE.get(bitsPerSample);
  if (bytesPerSample === undefined) throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  if (format === FORMAT_FLOAT && bitsPerSample !== 32) throw new Error(`Unsupported float WAV bit depth: ${bitsPerSample}`);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('WAV sample rate is invalid');

  const frameBytes = channels * bytesPerSample;
  const frames = Math.floor(dataSize / frameBytes);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = dataOffset + frame * frameBytes;
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += readSample(bytes, view, frameOffset + channel * bytesPerSample, bitsPerSample, format);
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, channels, bitsPerSample, durationSeconds: frames / sampleRate };
}

/**
 * Validate the canonical recording the Host's SenseVoice provider accepts:
 * 16 kHz, mono, PCM16, 44-byte header, self-consistent lengths.
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} audio - complete recording.
 * @param {number} maxDurationSeconds - longest admitted recording.
 * @returns {{sampleRate: number, channels: number, durationSeconds: number}} admitted recording facts.
 * @throws {Error} with the same wording the harness uses, plus the duration bound.
 */
export function validatePcm16Wav(audio, maxDurationSeconds = 120) {
  const bytes = toBytes(audio);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const canonical = bytes.length >= 46
    && fourcc(0) === 'RIFF'
    && fourcc(8) === 'WAVE'
    && fourcc(12) === 'fmt '
    && view.getUint32(16, true) === 16
    && view.getUint16(20, true) === FORMAT_PCM
    && view.getUint16(22, true) === 1
    && view.getUint32(24, true) === 16000
    && view.getUint32(28, true) === 32000
    && view.getUint16(32, true) === 2
    && view.getUint16(34, true) === 16
    && fourcc(36) === 'data'
    && view.getUint32(4, true) === bytes.length - 8
    && view.getUint32(40, true) === bytes.length - 44
    && (bytes.length - 44) % 2 === 0;
  if (!canonical) throw new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording');
  const durationSeconds = (bytes.length - 44) / 32000;
  if (durationSeconds > maxDurationSeconds) throw new Error(`Audio exceeds ${maxDurationSeconds} seconds`);
  return { sampleRate: 16000, channels: 1, durationSeconds };
}
