/* @local/voice-mode -- pure, dependency-free audio helpers for the local voice client.
 *
 * Build contract for scripts/build.mjs: this file is concatenated into the classic
 * browser artifact after src/engine.mjs by removing the leading "export " token
 * from exported declarations. Keep this file free of imports, "export default",
 * "export { }", and top-level side effects. Every exported declaration starts its
 * own line with "export ". Plain ES2020: it runs inside the ModuleLoader factory,
 * and the Node unit tests import it directly as ESM.
 *
 * Capture path, entirely local:
 *   getUserMedia -> AudioContext -> ScriptProcessor frame (Float32Array)
 *     -> createVad().push(frame) -> 'ended' -> takeUtterance()
 *     -> resampleLinear(samples, captureRate, 16000) -> encodeWav16(..., 16000)
 *     -> POST /voice-mode/transcribe (host-local SenseVoice)
 *
 * The VAD is a pure state machine: no timers and no ambient clock. It derives
 * milliseconds only from pushed frame lengths and sampleRate, so the caller can
 * drive it from a ScriptProcessor/AudioWorklet callback at whatever rate the
 * AudioContext runs at.
 *
 *   idle   --(startMs of sustained frames >= startThreshold)-->  speech
 *   speech --(endSilenceMs of frames < continueThreshold)-->      ended
 *   speech --(maxUtteranceMs of speech, forced)-->                ended
 *   ended  --(next push, or reset())-->                           idle
 *
 * push() returns the new state on the transition push and the current state
 * otherwise, so one utterance reports 'ended' exactly once. The frame after an
 * 'ended' report re-arms the machine and is processed as the start of the next
 * capture window (the client keeps pushing frames and never has to call
 * reset()). takeUtterance() returns exactly the captured audio of the last
 * utterance: preRollMs of audio before the speech onset is kept so the first
 * word is not clipped, and trailing silence is trimmed to ~200 ms. An utterance
 * with less than minSpeechMs of speech is still reported as 'ended' but is
 * discarded (takeUtterance() returns an empty Float32Array), so a cough cannot
 * become a transcription request.
 *
 * setThresholds({ startThreshold, continueThreshold }) retunes the two energy
 * thresholds live, without touching the state, the speech/silence counters, or
 * the captured utterance buffer. The client raises both while its own speaker
 * is playing so speaker echo is not mistaken for a barge-in, and restores the
 * quiet-room pair when playback stops. Either key may be omitted to keep the
 * current value; non-positive, non-finite, or non-numeric values are ignored
 * and thresholds are clamped into (0, 1].
 */

/** AudioContexts normally run at 44.1 kHz or 48 kHz; this is only a fallback. */
const VOICE_MODE_AUDIO_DEFAULT_SAMPLE_RATE = 48000;

const VOICE_MODE_AUDIO_DEFAULT_START_THRESHOLD = 0.02;
const VOICE_MODE_AUDIO_DEFAULT_CONTINUE_THRESHOLD = 0.012;
const VOICE_MODE_AUDIO_DEFAULT_START_MS = 150;
const VOICE_MODE_AUDIO_DEFAULT_END_SILENCE_MS = 700;
const VOICE_MODE_AUDIO_DEFAULT_MIN_SPEECH_MS = 250;
const VOICE_MODE_AUDIO_DEFAULT_MAX_UTTERANCE_MS = 30000;
const VOICE_MODE_AUDIO_DEFAULT_PRE_ROLL_MS = 250;

/** Silence kept after the last speech frame when an utterance closes. */
const VOICE_MODE_AUDIO_TAIL_SILENCE_MS = 200;

/** Lower clamp for an energy threshold; anything below this is measurement noise. */
const VOICE_MODE_AUDIO_MIN_THRESHOLD = 1e-6;

/** Coerce an ArrayLike of samples to a Float32Array without mutating the caller's. */
function voiceModeAudioSamples(input) {
  if (input instanceof Float32Array) return input;
  if (input && typeof input.length === 'number' && Number.isFinite(input.length) && input.length >= 0) {
    return Float32Array.from(input);
  }
  return new Float32Array(0);
}

/** A finite, strictly positive number, else the fallback. */
function voiceModeAudioPositive(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** A finite, non-negative number, else the fallback. */
function voiceModeAudioNonNegative(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** A usable energy threshold in (0, 1], else the fallback. */
function voiceModeAudioThreshold(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, Math.max(VOICE_MODE_AUDIO_MIN_THRESHOLD, value));
}

/** Root-mean-square energy of one frame; a cheap speech/silence discriminator. */
function voiceModeAudioRms(frame) {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i];
    sum += value * value;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Duration of one capture frame in milliseconds, derived from the AudioContext
 * rate. `scriptProcessorSizeMs(48000, 4096)` is ~85.33 ms; useful for logging
 * and for deriving VAD timing from a frame budget.
 */
export function scriptProcessorSizeMs(sampleRate, bufferSize) {
  const rate = voiceModeAudioPositive(sampleRate, 0);
  const frames = voiceModeAudioPositive(bufferSize, 0);
  if (rate === 0 || frames === 0) return 0;
  return (frames / rate) * 1000;
}

/**
 * Linear-interpolation resampler, mono. Output length is exactly
 * Math.round(input.length * toRate / fromRate) and output positions are
 * monotonic (`source = i * fromRate / toRate`), so a 48 kHz capture becomes the
 * 16 kHz mono stream the host transcribers expect. Equal rates return a copy;
 * empty input returns an empty Float32Array.
 */
export function resampleLinear(input, fromRate, toRate) {
  const samples = voiceModeAudioSamples(input);
  const from = voiceModeAudioPositive(fromRate, 0);
  const to = voiceModeAudioPositive(toRate, 0);
  if (samples.length === 0) return new Float32Array(0);
  if (from === 0 || to === 0) throw new RangeError('resampleLinear needs a positive fromRate and toRate');
  if (from === to) return new Float32Array(samples);

  const length = Math.round((samples.length * to) / from);
  if (length === 0) return new Float32Array(0);

  const output = new Float32Array(length);
  const last = samples.length - 1;
  const step = from / to; // source samples advanced per output sample
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const base = Math.floor(position);
    if (base >= last) {
      output[i] = samples[last];
      continue;
    }
    const fraction = position - base;
    output[i] =
      fraction === 0 ? samples[base] : samples[base] + (samples[base + 1] - samples[base]) * fraction;
  }
  return output;
}

/**
 * Float samples in [-1, 1] to signed 16-bit PCM. Values outside the range are
 * clamped; negatives scale by 32768 and positives by 32767, matching the
 * harness's own encodeWave so host decoders see the same amplitudes.
 */
export function float32ToPcm16(samples) {
  const input = voiceModeAudioSamples(samples);
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let value = input[i];
    if (Number.isNaN(value)) value = 0; // Infinity still clamps like the harness
    if (value > 1) value = 1;
    else if (value < -1) value = -1;
    output[i] = Math.round(value * (value < 0 ? 32768 : 32767));
  }
  return output;
}

/**
 * Canonical little-endian mono PCM16 WAV bytes (RIFF/WAVE, 44-byte header,
 * "fmt " chunk of 16, format 1, one channel, 16 bits per sample). This is what
 * POST /voice-mode/transcribe accepts as a raw `audio/wav` body.
 */
export function encodeWav16(samples, sampleRate) {
  const pcm = float32ToPcm16(samples);
  const rate = Math.max(1, Math.round(voiceModeAudioPositive(sampleRate, 16000)));
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);

  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true); // RIFF chunk size
  writeText(8, 'WAVE');
  writeText(12, 'fmt '); // fmt chunk id
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true); // sample rate
  view.setUint32(28, rate * 2, true); // byte rate: rate * channels * bytesPerSample
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true); // data chunk size
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

/**
 * Create a frame-driven voice-activity detector.
 *
 * @param {{sampleRate?: number, startThreshold?: number, continueThreshold?: number,
 *          startMs?: number, endSilenceMs?: number, minSpeechMs?: number,
 *          maxUtteranceMs?: number, preRollMs?: number}} [options]
 *   sampleRate is the AudioContext rate the frames come from (default 48000).
 *   startThreshold decides when speech may begin; the lower continueThreshold
 *   keeps an utterance open through quiet syllables. startMs is how long speech
 *   must be sustained before `speech` is reported (a door slam is too short).
 *   endSilenceMs closes an utterance, maxUtteranceMs force-closes a pathological
 *   one, preRollMs is how much audio before the onset is kept, and minSpeechMs
 *   is the least speech that is worth transcribing.
 *
 * @returns {{push: Function, reset: Function, takeUtterance: Function,
 *            setThresholds: Function, state: string, speechMs: number}}
 *   push(frame) returns 'idle' | 'speech' | 'ended' for each frame; 'ended' is
 *   reported once per utterance and the following push re-arms the detector.
 */
export function createVad(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const sampleRate = Math.max(
    1,
    Math.round(voiceModeAudioPositive(settings.sampleRate, VOICE_MODE_AUDIO_DEFAULT_SAMPLE_RATE)),
  );
  let startThreshold = voiceModeAudioThreshold(
    settings.startThreshold,
    VOICE_MODE_AUDIO_DEFAULT_START_THRESHOLD,
  );
  let continueThreshold = voiceModeAudioThreshold(
    settings.continueThreshold,
    VOICE_MODE_AUDIO_DEFAULT_CONTINUE_THRESHOLD,
  );
  const startMs = voiceModeAudioNonNegative(settings.startMs, VOICE_MODE_AUDIO_DEFAULT_START_MS);
  const endSilenceMs = voiceModeAudioNonNegative(
    settings.endSilenceMs,
    VOICE_MODE_AUDIO_DEFAULT_END_SILENCE_MS,
  );
  const minSpeechMs = voiceModeAudioNonNegative(settings.minSpeechMs, VOICE_MODE_AUDIO_DEFAULT_MIN_SPEECH_MS);
  const maxUtteranceMs = voiceModeAudioPositive(
    settings.maxUtteranceMs,
    VOICE_MODE_AUDIO_DEFAULT_MAX_UTTERANCE_MS,
  );
  const preRollMs = voiceModeAudioNonNegative(settings.preRollMs, VOICE_MODE_AUDIO_DEFAULT_PRE_ROLL_MS);

  /** Samples of recent idle audio kept for the pre-roll. */
  const preRollSamples = Math.round((preRollMs / 1000) * sampleRate);
  /** Trailing silence kept when an utterance closes. */
  const tailSilenceSamples = Math.round((VOICE_MODE_AUDIO_TAIL_SILENCE_MS / 1000) * sampleRate);
  /** Sustained speech needed to report 'speech', in samples. */
  const startSamples = (startMs / 1000) * sampleRate;

  let state = 'idle';
  let speechMs = 0;

  // Current utterance.
  let captureChunks = []; // Float32Array copies, in time order
  let captureSamples = 0;
  let trailingSilenceSamples = 0;
  let lastUtterance = null; // finalized audio of the last 'ended' utterance

  // Idle -> speech candidate (sustained-energy test).
  let candidateActive = false;
  let candidateFrames = [];
  let candidateSamples = 0;
  let candidatePreRoll = new Float32Array(0);

  // Recent idle audio, so the first word is not clipped.
  let history = [];
  let historySamples = 0;

  function clearCandidate() {
    candidateActive = false;
    candidateFrames = [];
    candidateSamples = 0;
    candidatePreRoll = new Float32Array(0);
  }

  function clearHistory() {
    history = [];
    historySamples = 0;
  }

  /** Keep at most preRollSamples of recent idle audio, dropping whole frames. */
  function pushHistory(frame) {
    if (preRollSamples === 0) return;
    history.push(frame);
    historySamples += frame.length;
    while (history.length > 1 && historySamples - history[0].length >= preRollSamples) {
      historySamples -= history.shift().length;
    }
  }

  /** The last preRollSamples of audio captured before the current onset. */
  function takePreRoll() {
    const keep = Math.min(preRollSamples, historySamples);
    const preRoll = new Float32Array(keep);
    let write = keep;
    for (let i = history.length - 1; i >= 0 && write > 0; i -= 1) {
      const chunk = history[i];
      const take = Math.min(chunk.length, write);
      preRoll.set(chunk.subarray(chunk.length - take), write - take);
      write -= take;
    }
    return preRoll;
  }

  /** Close the current utterance: trim trailing silence and park in 'ended'. */
  function finishUtterance() {
    const keepSilence = Math.min(trailingSilenceSamples, tailSilenceSamples);
    const length = Math.max(0, captureSamples - (trailingSilenceSamples - keepSilence));
    const accepted = speechMs >= minSpeechMs;
    const utterance = accepted ? new Float32Array(length) : new Float32Array(0);
    if (accepted) {
      let write = 0;
      for (let i = 0; i < captureChunks.length && write < length; i += 1) {
        const chunk = captureChunks[i];
        const take = Math.min(chunk.length, length - write);
        utterance.set(take === chunk.length ? chunk : chunk.subarray(0, take), write);
        write += take;
      }
    }
    lastUtterance = utterance;
    captureChunks = [];
    captureSamples = 0;
    trailingSilenceSamples = 0;
    clearCandidate();
    clearHistory();
    state = 'ended';
  }

  /** Leave 'ended' and start listening again; the utterance stays takeable. */
  function armIdle() {
    state = 'idle';
    speechMs = 0;
    captureChunks = [];
    captureSamples = 0;
    trailingSilenceSamples = 0;
    clearCandidate();
    clearHistory();
  }

  /** Feed one fixed-size capture frame. Returns the current state. */
  function push(input) {
    const frame = voiceModeAudioSamples(input);
    if (frame.length === 0) return state;
    if (state === 'ended') armIdle();

    const rms = voiceModeAudioRms(frame);

    if (state === 'idle') {
      if (rms >= startThreshold) {
        if (!candidateActive) {
          candidateActive = true;
          candidateFrames = [];
          candidateSamples = 0;
          candidatePreRoll = takePreRoll();
        }
        const copy = frame.slice();
        candidateFrames.push(copy);
        candidateSamples += copy.length;
        pushHistory(copy);
        if (candidateSamples >= startSamples) {
          state = 'speech';
          speechMs = (candidateSamples / sampleRate) * 1000;
          captureChunks =
            candidatePreRoll.length > 0 ? [candidatePreRoll, ...candidateFrames] : candidateFrames.slice();
          captureSamples = candidatePreRoll.length + candidateSamples;
          trailingSilenceSamples = 0;
          clearCandidate();
          clearHistory();
          if (speechMs >= maxUtteranceMs) {
            finishUtterance();
            return 'ended';
          }
          return 'speech';
        }
        return 'idle';
      }
      clearCandidate();
      pushHistory(frame.slice());
      return 'idle';
    }

    // state === 'speech'
    const copy = frame.slice();
    captureChunks.push(copy);
    captureSamples += copy.length;
    if (rms >= continueThreshold) {
      speechMs += (copy.length / sampleRate) * 1000;
      trailingSilenceSamples = 0;
      if (speechMs >= maxUtteranceMs) {
        finishUtterance();
        return 'ended';
      }
      return 'speech';
    }
    trailingSilenceSamples += copy.length;
    if ((trailingSilenceSamples / sampleRate) * 1000 >= endSilenceMs) {
      finishUtterance();
      return 'ended';
    }
    return 'speech';
  }

  /** Drop everything and listen again (thresholds are configuration and stay). */
  function reset() {
    state = 'idle';
    speechMs = 0;
    captureChunks = [];
    captureSamples = 0;
    trailingSilenceSamples = 0;
    clearCandidate();
    clearHistory();
    lastUtterance = null;
  }

  /**
   * Exactly the captured audio of the last utterance, as a fresh Float32Array.
   * Empty before the first utterance and for utterances below minSpeechMs.
   */
  function takeUtterance() {
    return lastUtterance ? lastUtterance.slice() : new Float32Array(0);
  }

  /** Retune the energy thresholds live; missing or invalid keys keep the value. */
  function setThresholds(next) {
    if (!next || typeof next !== 'object') return;
    startThreshold = voiceModeAudioThreshold(next.startThreshold, startThreshold);
    continueThreshold = voiceModeAudioThreshold(next.continueThreshold, continueThreshold);
  }

  return {
    push,
    reset,
    takeUtterance,
    setThresholds,
    get state() {
      return state;
    },
    get speechMs() {
      return speechMs;
    },
  };
}
