/**
 * Push-to-talk capture (debug control path).
 *
 * VAD (`./vad.js`) is the default hands-free mode. This class stays for the
 * manual flow: POST /listen/start begins recording the operator's decoded PCM,
 * POST /listen/stop returns one utterance. It is also handy for testing a
 * specific line without VAD tuning.
 */
import { pcmDurationMs } from './wav.js';

export class PttCapture {
  constructor({ sampleRate = 48000, channels = 2, maxSeconds = 60 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.maxSeconds = maxSeconds;
    this._chunks = [];
    this._bytes = 0;
    this._recording = false;
    this._startedAt = 0;
    this._overflowed = false;
  }

  get isRecording() {
    return this._recording;
  }

  get bufferedMs() {
    return pcmDurationMs(this._bytes, {
      sampleRate: this.sampleRate,
      channels: this.channels,
    });
  }

  start() {
    this._chunks = [];
    this._bytes = 0;
    this._overflowed = false;
    this._recording = true;
    this._startedAt = Date.now();
    return { recording: true };
  }

  push(pcmChunk) {
    if (!this._recording || !Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) return;
    const maxBytes = this.sampleRate * this.channels * 2 * this.maxSeconds;
    if (this._bytes + pcmChunk.length > maxBytes) {
      const room = Math.max(0, maxBytes - this._bytes);
      if (room > 0) {
        this._chunks.push(pcmChunk.subarray(0, room));
        this._bytes += room;
      }
      this._overflowed = true;
      return;
    }
    this._chunks.push(pcmChunk);
    this._bytes += pcmChunk.length;
  }

  /** End the recording and return the buffered utterance (or null). */
  stop() {
    if (!this._recording) return null;
    this._recording = false;
    const pcm = Buffer.concat(this._chunks);
    this._chunks = [];
    this._bytes = 0;
    if (pcm.length === 0) return null;
    return {
      pcm,
      durationMs: pcmDurationMs(pcm.length, {
        sampleRate: this.sampleRate,
        channels: this.channels,
      }),
      speechMs: null,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frameMs: null,
      overflowed: this._overflowed,
      wallMs: Date.now() - this._startedAt,
    };
  }

  reset() {
    this._chunks = [];
    this._bytes = 0;
    this._recording = false;
    this._overflowed = false;
  }
}
