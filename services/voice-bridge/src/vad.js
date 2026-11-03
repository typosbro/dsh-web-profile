/**
 * Energy-based voice activity detection with hangover.
 *
 * Discord delivers 20 ms Opus frames decoded to 48 kHz stereo s16le. This
 * segmenter turns that stream into utterances: a frame above `thresholdDbfs`
 * opens a candidate segment, `minSpeechMs` of speech confirms it (with
 * `preRollMs` of audio kept before onset), `silenceMs` of trailing quiet ends
 * it, and `maxUtteranceMs` force-splits long turns.
 *
 * It is deliberately deterministic (frame counting, no wall clock), which is
 * both cheap and unit-testable. No dependency needed; `webrtcvad` can replace
 * this class later behind the same interface.
 */
import { rmsDbfs } from './audio.js';
import { pcmFrameBytes } from './wav.js';

export class EnergyVad {
  constructor(
    {
      frameMs = 20,
      sampleRate = 48000,
      channels = 2,
      thresholdDbfs = -35,
      minSpeechMs = 200,
      silenceMs = 600,
      preRollMs = 300,
      minUtteranceMs = 300,
      maxUtteranceMs = 15000,
    } = {},
    { onUtterance = null } = {},
  ) {
    this.frameMs = frameMs;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.thresholdDbfs = thresholdDbfs;
    this.minSpeechMs = minSpeechMs;
    this.silenceMs = silenceMs;
    this.preRollMs = preRollMs;
    this.minUtteranceMs = minUtteranceMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.frameBytes = pcmFrameBytes({ sampleRate, channels, frameMs });
    this.preRollFrames = Math.floor(preRollMs / frameMs);
    this.onUtterance = onUtterance;
    this.stats = { utterances: 0, lastUtteranceMs: 0 };
    this.reset();
  }

  /** Drop any buffered audio and return to idle. */
  reset() {
    this._pending = Buffer.alloc(0);
    this._preRoll = [];
    this._onsetFrames = [];
    this._utteranceFrames = [];
    this._speechFrames = 0;
    this._lastSpeechIndex = -1;
    this._state = 'idle';
  }

  get isSpeaking() {
    return this._state === 'active';
  }

  /** Feed an arbitrary chunk of s16le PCM. Emits utterances via onUtterance. */
  push(pcmChunk) {
    if (!Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) return;
    let data = pcmChunk;
    if (this._pending.length > 0) {
      data = Buffer.concat([this._pending, pcmChunk]);
      this._pending = Buffer.alloc(0);
    }
    let offset = 0;
    while (data.length - offset >= this.frameBytes) {
      const frame = data.subarray(offset, offset + this.frameBytes);
      offset += this.frameBytes;
      this._handleFrame(frame);
    }
    if (offset < data.length) {
      this._pending = Buffer.from(data.subarray(offset));
    }
  }

  /** Force the active utterance out (e.g. when capture is disarmed). */
  flush() {
    if (this._state === 'active') {
      this._lastSpeechIndex = this._utteranceFrames.length - 1;
      this._emit();
    }
    this._onsetFrames = [];
    this._preRoll = [];
  }

  _handleFrame(frame) {
    const speech = rmsDbfs(frame) >= this.thresholdDbfs;

    if (this._state === 'idle') {
      if (!speech) {
        this._onsetFrames = [];
        this._pushPreRoll(frame);
        return;
      }
      this._onsetFrames.push(Buffer.from(frame));
      if (this._onsetFrames.length * this.frameMs >= this.minSpeechMs) {
        this._state = 'active';
        this._utteranceFrames = [...this._preRoll, ...this._onsetFrames];
        this._speechFrames = this._onsetFrames.length;
        this._lastSpeechIndex = this._utteranceFrames.length - 1;
        this._onsetFrames = [];
        this._preRoll = [];
        this._checkMaxLength();
      }
      return;
    }

    // active
    this._utteranceFrames.push(Buffer.from(frame));
    if (speech) {
      this._speechFrames += 1;
      this._lastSpeechIndex = this._utteranceFrames.length - 1;
    }
    const trailingSilenceFrames = this._utteranceFrames.length - 1 - this._lastSpeechIndex;
    if (trailingSilenceFrames * this.frameMs >= this.silenceMs) {
      this._emit();
      return;
    }
    this._checkMaxLength();
  }

  _pushPreRoll(frame) {
    if (this.preRollFrames <= 0) return;
    this._preRoll.push(Buffer.from(frame));
    while (this._preRoll.length > this.preRollFrames) this._preRoll.shift();
  }

  _checkMaxLength() {
    if (this._utteranceFrames.length * this.frameMs >= this.maxUtteranceMs && this._state === 'active') {
      this._lastSpeechIndex = this._utteranceFrames.length - 1;
      this._emit();
    }
  }

  _emit() {
    const frames = this._lastSpeechIndex >= 0
      ? this._utteranceFrames.slice(0, this._lastSpeechIndex + 1)
      : [];
    const speechMs = this._speechFrames * this.frameMs;
    const pcm = Buffer.concat(frames);
    const utterance = {
      pcm,
      durationMs: (frames.length * this.frameMs),
      speechMs,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frameMs: this.frameMs,
    };
    this.reset();
    if (pcm.length > 0 && speechMs >= this.minUtteranceMs) {
      this.stats.utterances += 1;
      this.stats.lastUtteranceMs = utterance.durationMs;
      this.onUtterance?.(utterance);
    }
  }
}
