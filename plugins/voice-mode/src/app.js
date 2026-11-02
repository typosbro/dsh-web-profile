/**
 * voice-mode — client half (Web GUI), local voice edition.
 *
 * Everything audio runs on this machine through the plugin's own host routes:
 *   POST /voice-mode/transcribe   WAV in, text out   (harness SenseVoice, local)
 *   POST /voice-mode/speak        text in, WAV out   (Kokoro / macOS say, local)
 *   GET  /voice-mode/status       engine readiness
 *
 * The browser's cloud speech APIs are deliberately not used. The page only
 * opens the microphone, cuts utterances with a local VAD, ships the utterance
 * to the host, and plays the returned speech through Web Audio — which makes
 * interruption immediate: stopping playback is local and instant, cancelling
 * the running turn follows over the Session Remote.
 *
 * Runs inside the ModuleLoader factory: React is in scope and the engine
 * helpers (stripMarkdown, splitSentences, resampleLinear, encodeWav16,
 * createVad) were concatenated ahead of this file by scripts/build.mjs.
 */

const SLOT = 'conversation.composer.dock';
const NS = 'voice-mode';
const PKG = '@local/voice-mode';
const VERSION = '0.2.0';
const STATUS_URL = '/voice-mode/status';
const TRANSCRIBE_URL = '/voice-mode/transcribe';
const SPEAK_URL = '/voice-mode/speak';
/** Host speech engines expect 16 kHz mono PCM16 WAV from the browser. */
const STT_RATE = 16000;
/** Capture frame size; 4096 frames at 48 kHz is ~85 ms per VAD step. */
const CAPTURE_FRAME = 4096;
/** Quiet time that ends an utterance. Natural thinking pauses run 1-2 s, and a
 *  0.7 s cut split one thought into several short prompts, each answered
 *  separately; 1.4 s keeps the thought whole. */
const END_SILENCE_MS = 1400;
/** A fragment that lands right after a prompt is a continuation, not a new
 *  request: steer it into the turn instead of starting another short turn. */
const CONTINUATION_WINDOW_MS = 4500;
/** VAD thresholds: quiet room, then a raised pair while our own speaker is live. */
const VAD_IDLE = { startThreshold: 0.022, continueThreshold: 0.011 };
const VAD_PLAYING = { startThreshold: 0.06, continueThreshold: 0.03 };

const DICTS = {
  en: {
    start: 'Start voice conversation (local)',
    stop: 'Stop voice conversation',
    listening: 'Listening',
    hearing: 'Hearing you',
    thinking: 'Thinking',
    speaking: 'Speaking — talk to interrupt',
    insecure: 'Voice mode needs HTTPS or localhost',
    microphone: 'Microphone unavailable — check the permission',
    engine: 'Local voice engine is not ready',
    sttFailed: 'Could not transcribe the utterance',
    speakFailed: 'Could not speak the reply',
    composer: 'The message composer is not ready',
    promptFailed: 'Could not send the message',
  },
  zh: {
    start: '开始本地语音对话',
    stop: '结束语音对话',
    listening: '正在聆听',
    hearing: '正在听你说',
    thinking: '思考中',
    speaking: '朗读中 — 说话即可打断',
    insecure: '语音模式需要 HTTPS 或 localhost',
    microphone: '麦克风不可用 — 请检查权限',
    engine: '本地语音引擎尚未就绪',
    sttFailed: '无法识别这段语音',
    speakFailed: '无法朗读回复',
    composer: '消息输入框尚未就绪',
    promptFailed: '消息发送失败',
  },
};

/** Current tab language, used only as an STT language hint. */
function voiceLanguage() {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

/** Time zone label the Host records with a prompt. */
function voiceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error) {
    return undefined;
  }
}

/** Client-minted identity for one prompt; the Host persists it on the message. */
function voiceRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Best-effort assistant text from a durable `assistant/message` event. */
function messageText(data) {
  if (!data || typeof data !== 'object') return '';
  const message = data.message;
  if (message && Array.isArray(message.content)) {
    const parts = [];
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (Array.isArray(data.stream)) {
    const parts = [];
    for (const record of data.stream) {
      if (record && record.chunk && record.chunk.type === 'text-delta' && typeof record.chunk.text === 'string') {
        parts.push(record.chunk.text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  return '';
}

/** Sleep helper used by the follow-stream reconnect loop. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Cut one early clause out of a still-streaming sentence, at a comma or a word
 * boundary, so the first audio of a reply is not held back by a long sentence.
 *
 * @param {string} text - accumulated speakable text.
 * @param {number} limit - preferred maximum length of the head.
 * @returns {{head: string, tail: string}|undefined} split, or undefined when too short.
 */
function cutSpeechClause(text, limit) {
  if (typeof text !== 'string' || text.length < 32) return undefined;
  const cap = Math.min(limit, text.length - 1);
  let cut = -1;
  for (let index = cap; index > 20; index -= 1) {
    const char = text[index];
    if (char === ',' || char === ';' || char === ':' || char === '\u2014') {
      cut = index + 1;
      break;
    }
  }
  if (cut < 0) {
    for (let index = cap; index > 20; index -= 1) {
      if (text[index] === ' ') {
        cut = index;
        break;
      }
    }
  }
  if (cut <= 0) return undefined;
  const head = text.slice(0, cut).trim();
  const tail = text.slice(cut).trim();
  if (head.length < 24 || !/[\p{L}\p{N}]/u.test(head)) return undefined;
  return { head, tail };
}

/**
 * Build the per-Session voice controller. It owns microphone capture, the VAD,
 * host transcription, playback of local speech, and the assistant text stream.
 *
 * @param {object} options - owning client context, prop reader, translator, state publisher.
 * @returns {object} controller with start/stop/dispose.
 */
function createVoiceController(options) {
  const { ctx, getProps, getT, publish } = options;
  const remote = ctx.remote;

  let active = false;
  let disposed = false;
  let generation = 0;
  let followAbort = null;
  let followFrames = 0;

  let mediaStream = null;
  let inputContext = null;
  let outputContext = null;
  let sourceNode = null;
  let processorNode = null;
  let sinkNode = null;
  let vad = null;
  let captureRate = 48000;

  let rawReply = '';
  let speakableSoFar = '';
  let speechBuffer = '';
  let speechQueue = [];
  let speaking = false;
  const speakControllers = new Set();
  const liveSources = new Set();
  let engineTts = 'unknown';
  let lastSubmitAt = 0;

  const post = (patch) => publish(patch);
  const t = (key) => String(getT()(key));

  /**
   * Publish machine-readable runtime state next to the boot marker so a
   * headless probe can prove the loop reached its transport without sending
   * anything itself.
   *
   * @param {object} patch - fields merged into `window.__DSH_VOICE_MODE__`.
   */
  function diag(patch) {
    if (typeof window === 'undefined') return;
    const marker = window.__DSH_VOICE_MODE__;
    if (!marker || marker.plugin !== PKG) return;
    Object.assign(marker, patch);
  }

  function phase(value) {
    post({ phase: value });
  }

  function isPlaying() {
    return speaking || liveSources.size > 0;
  }

  function settlePhase() {
    if (!active) return;
    if (isPlaying()) {
      phase('speaking');
      return;
    }
    phase(getProps().running ? 'thinking' : 'listening');
  }

  /** Raise the VAD thresholds while our own speaker is producing sound. */
  function tuneVad(playing) {
    if (!vad || typeof vad.setThresholds !== 'function') return;
    try {
      vad.setThresholds(playing ? VAD_PLAYING : VAD_IDLE);
    } catch (error) {
      /* thresholds are best-effort */
    }
  }

  /** Release audio and transport resources without touching rendered state. */
  function teardown() {
    active = false;
    diag({ mode: 'off', capture: 'stopped', vad: 'idle', follow: 'closed' });

    const recognizer = processorNode;
    processorNode = null;
    if (recognizer) {
      recognizer.onaudioprocess = null;
      try {
        recognizer.disconnect();
      } catch (error) {
        /* already detached */
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (error) {
        /* already detached */
      }
      sourceNode = null;
    }
    if (sinkNode) {
      try {
        sinkNode.disconnect();
      } catch (error) {
        /* already detached */
      }
      sinkNode = null;
    }
    const stream = mediaStream;
    mediaStream = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch (error) {
          /* already ended */
        }
      }
    }
    const input = inputContext;
    inputContext = null;
    if (input && typeof input.close === 'function') input.close().catch(() => {});
    vad = null;

    stopPlayback();
    const output = outputContext;
    outputContext = null;
    if (output && typeof output.close === 'function') output.close().catch(() => {});

    const streamAbort = followAbort;
    followAbort = null;
    if (streamAbort) {
      try {
        streamAbort.abort();
      } catch (error) {
        /* already closed */
      }
    }
    rawReply = '';
    speakableSoFar = '';
    speechBuffer = '';
  }

  function stop() {
    teardown();
    post({ phase: 'off', caption: '', note: '' });
  }

  /** Fatal setup or engine failure: release everything and show one note. */
  function fail(message) {
    teardown();
    post({ phase: 'error', caption: '', note: String(message) });
  }

  /** Stop every scheduled or in-flight speech fetch. Local and immediate. */
  function stopPlayback() {
    speechQueue = [];
    speechBuffer = '';
    for (const controller of [...speakControllers]) {
      try {
        controller.abort();
      } catch (error) {
        /* already aborted */
      }
    }
    speakControllers.clear();
    for (const source of [...liveSources]) {
      try {
        source.stop();
      } catch (error) {
        /* already ended */
      }
    }
    liveSources.clear();
    speaking = false;
  }

  /** User talked over the assistant: stop speech now, cancel the turn after. */
  function bargeIn() {
    if (!active) return;
    diag({ bargeIn: true });
    stopPlayback();
    const props = getProps();
    if (props && props.running && remote && remote.session) {
      Promise.resolve(remote.session.cancel({ sessionId: props.sessionId })).catch(() => {});
    }
    phase('hearing');
  }

  /** Fetch one sentence's audio from the local host engine. */
  async function fetchSpeech(text) {
    const controller = new AbortController();
    speakControllers.add(controller);
    try {
      const response = await fetch(SPEAK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (!active || !outputContext) return null;
      return await outputContext.decodeAudioData(bytes);
    } finally {
      speakControllers.delete(controller);
    }
  }

  /** Play one decoded buffer; resolves when it ends, is stopped, or fails. */
  function playBuffer(buffer) {
    return new Promise((resolve) => {
      if (!active || !outputContext || !buffer) {
        resolve();
        return;
      }
      const source = outputContext.createBufferSource();
      source.buffer = buffer;
      source.connect(outputContext.destination);
      liveSources.add(source);
      source.onended = () => {
        liveSources.delete(source);
        resolve();
      };
      try {
        source.start();
        diag({ speak: 'playing', playingSources: liveSources.size, speakQueued: speechQueue.length });
      } catch (error) {
        liveSources.delete(source);
        resolve();
      }
    });
  }

  /**
   * Speak queued sentences through the local engine, prefetching the next
   * sentence while the current one plays. Kokoro runs faster than real time on
   * this host, so prefetching keeps speech gapless after the first sentence.
   */
  async function pumpSpeech() {
    if (speaking || !outputContext) return;
    speaking = true;
    tuneVad(true);
    phase('speaking');
    try {
      let pending = null;
      while (active && (pending || speechQueue.length > 0)) {
        const current = pending || fetchSpeech(speechQueue.shift());
        pending = null;
        let buffer = null;
        try {
          buffer = await current;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          diag({ speak: 'error', speakError: String((error && error.message) || error) });
          continue;
        }
        if (!active) return;
        if (speechQueue.length > 0) pending = fetchSpeech(speechQueue.shift());
        await playBuffer(buffer);
      }
    } finally {
      speaking = false;
      if (active) tuneVad(isPlaying());
      settlePhase();
    }
  }

  /** Queue one complete sentence for playback. */
  function queueSpeech(text) {
    const sentence = String(text || '').trim();
    if (!sentence) return;
    speechQueue.push(sentence);
    void pumpSpeech();
  }

  /** Split newly arrived reply text into speakable sentences. */
  function feedSpeech() {
    const speakable = stripMarkdown(rawReply);
    if (speakable === speakableSoFar) return;
    if (!speakable.startsWith(speakableSoFar)) {
      speakableSoFar = speakable;
      return;
    }
    const delta = speakable.slice(speakableSoFar.length);
    speakableSoFar = speakable;
    if (!delta.trim()) return;
    speechBuffer += delta;
    const split = splitSentences(speechBuffer);
    speechBuffer = split.rest;
    for (const sentence of split.sentences) queueSpeech(sentence);
    // Before anything has started playing, a long unterminated first sentence
    // would delay all audio until the model finishes generating it. Cut one
    // early clause so speech starts while the rest of the sentence arrives.
    if (!speaking && speechQueue.length === 0 && speechBuffer.length > 96) {
      const early = cutSpeechClause(speechBuffer, 64);
      if (early) {
        queueSpeech(early.head);
        speechBuffer = early.tail;
      }
    }
    if (speechBuffer.length > 180) {
      queueSpeech(speechBuffer);
      speechBuffer = '';
    }
  }

  function flushSpeech() {
    if (speechBuffer.trim()) queueSpeech(speechBuffer);
    speechBuffer = '';
  }

  /** Fold one follow-stream frame into the current reply. */
  function handleFrame(frame) {
    if (!frame || !active) return;
    if (frame.type === 'assistant-stream') {
      const live = frame.frame;
      if (!live) return;
      if (live.type === 'start') {
        rawReply = '';
        speakableSoFar = '';
        return;
      }
      if (live.type === 'chunk') {
        const chunk = live.chunk;
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          rawReply += chunk.text;
          feedSpeech();
        }
        return;
      }
      if (live.type === 'end') {
        flushSpeech();
        return;
      }
      return;
    }
    if (frame.type !== 'event') return;
    const event = frame.event;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'assistant/message') {
      const text = messageText(event.data);
      if (!rawReply && text) {
        rawReply = text;
        feedSpeech();
      }
      flushSpeech();
      rawReply = '';
      speakableSoFar = '';
      settlePhase();
      return;
    }
    if (event.type === 'turn/end') {
      flushSpeech();
      rawReply = '';
      speakableSoFar = '';
      settlePhase();
    }
  }

  /** Follow this Session's assistant stream, reconnecting while the mode is on. */
  async function pumpFollow(run) {
    const props = getProps();
    if (!props || !props.sessionId || !remote || !remote.session) return;
    const controller = new AbortController();
    followAbort = controller;
    let attempt = 0;
    diag({ follow: 'opening' });
    while (active && !disposed && run === generation) {
      try {
        const stream = remote.session.follow(
          {
            address: { kind: 'session', sessionId: props.sessionId },
            assistantStream: true,
          },
          controller.signal,
        );
        attempt = 0;
        followFrames = 0;
        diag({ follow: 'open', followSessionId: props.sessionId, frames: 0 });
        for await (const frame of stream) {
          if (!active || disposed || run !== generation) return;
          followFrames += 1;
          diag({ frames: followFrames });
          handleFrame(frame);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          diag({ follow: 'closed' });
          return;
        }
        diag({ follow: 'error', followError: String((error && error.message) || error) });
        if (!active || disposed || run !== generation) return;
      }
      if (!active || disposed || run !== generation) return;
      attempt += 1;
      await sleep(Math.min(4000, 300 * 2 ** Math.min(attempt, 4)));
    }
  }

  /** Send one utterance as the next prompt, cancelling a running turn first. */
  async function submit(text) {
    const props = getProps();
    if (!props || !props.sessionId || !remote || !remote.session) {
      fail(t('composer'));
      return;
    }
    const continuation = Date.now() - lastSubmitAt < CONTINUATION_WINDOW_MS;
    const mode = continuation ? 'steer' : 'queue';
    lastSubmitAt = Date.now();
    diag({ prompt: 'writing', lastPrompt: text.slice(0, 160), promptMode: mode });
    // A continuation joins the open turn; only a genuinely new request cancels it.
    if (props.running && !continuation) {
      try {
        await remote.session.cancel({ sessionId: props.sessionId });
      } catch (error) {
        /* the turn may already have finished */
      }
    }
    try {
      const result = await remote.session.prompt({
        requestId: voiceRequestId(),
        sessionId: props.sessionId,
        mode,
        content: [{ type: 'text', text }],
        clientTimeZone: voiceTimeZone(),
      });
      if (!result || result.ok !== true) {
        const error = result && result.error;
        diag({ prompt: 'failed', promptError: String((error && (error.message || error.code)) || 'rejected') });
        post({ note: String((error && (error.message || error.code)) || t('promptFailed')) });
      } else {
        diag({ prompt: 'accepted' });
      }
    } catch (error) {
      diag({ prompt: 'failed', promptError: String((error && error.message) || error) });
      post({ note: t('promptFailed') });
    }
  }

  /** Transcribe one captured utterance on the host and send it as a prompt. */
  async function transcribeAndSend(samples) {
    phase('thinking');
    diag({ transcribe: 'running' });
    try {
      const resampled = captureRate === STT_RATE ? samples : resampleLinear(samples, captureRate, STT_RATE);
      const wav = encodeWav16(resampled, STT_RATE);
      diag({ transcribeBytes: wav.byteLength });
      const url = `${TRANSCRIBE_URL}?lang=${encodeURIComponent(voiceLanguage())}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!active) return;
      const text = String((data && data.text) || '').trim();
      diag({ transcribe: 'ok', lastHeard: text.slice(0, 160) });
      if (!text) {
        settlePhase();
        return;
      }
      // Verification hook: a headless probe can exercise capture -> transcribe
      // without letting fake-device audio become a real message in the Session.
      const marker = typeof window !== 'undefined' ? window.__DSH_VOICE_MODE__ : undefined;
      if (marker && marker.suppressPrompts) {
        diag({ prompt: 'suppressed' });
        settlePhase();
        return;
      }
      await submit(text);
    } catch (error) {
      diag({ transcribe: 'error', transcribeError: String((error && error.message) || error) });
      if (active) {
        post({ note: t('sttFailed') });
        settlePhase();
      }
    }
  }

  /** One VAD step from a captured frame. */
  function onAudioFrame(frame) {
    if (!active || !vad) return;
    const state = vad.push(frame);
    if (state === 'speech') {
      diag({ vad: 'speech' });
      if (isPlaying()) bargeIn();
      else phase('hearing');
      return;
    }
    if (state === 'ended') {
      diag({ vad: 'ended' });
      const speechMs = Number(vad.speechMs) || 0;
      let utterance = null;
      try {
        utterance = vad.takeUtterance();
      } catch (error) {
        utterance = null;
      }
      if (!utterance || utterance.length === 0 || speechMs < 200) {
        diag({ vad: 'idle', lastSpeechMs: speechMs, transcribe: 'skipped' });
        settlePhase();
        return;
      }
      diag({ vad: 'idle', lastSpeechMs: speechMs });
      void transcribeAndSend(utterance);
      return;
    }
  }

  function onAudioProcess(event) {
    if (!active || !vad) return;
    const input = event.inputBuffer.getChannelData(0);
    // The buffer is reused by the audio thread; the VAD keeps the frames.
    const frame = new Float32Array(input.length);
    frame.set(input);
    onAudioFrame(frame);
  }

  /** Open the microphone and start the local VAD. */
  async function startCapture() {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.getUserMedia !== 'function') {
      fail(t('microphone'));
      return false;
    }
    let stream;
    try {
      stream = await media.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (error) {
      if (!active) return false;
      fail(t('microphone'));
      return false;
    }
    if (!active) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    mediaStream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (active) fail(t('microphone'));
      });
    }
    const AudioCtor =
      (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || undefined;
    if (!AudioCtor) {
      fail(t('microphone'));
      return false;
    }
    try {
      inputContext = new AudioCtor();
      if (typeof inputContext.resume === 'function') await inputContext.resume();
      captureRate = inputContext.sampleRate || 48000;
      vad = createVad({
        sampleRate: captureRate,
        endSilenceMs: END_SILENCE_MS,
        startMs: 150,
        minSpeechMs: 250,
        preRollMs: 300,
      });
      sourceNode = inputContext.createMediaStreamSource(stream);
      processorNode = inputContext.createScriptProcessor(CAPTURE_FRAME, 1, 1);
      processorNode.onaudioprocess = onAudioProcess;
      sinkNode = inputContext.createGain();
      sinkNode.gain.value = 0;
      sourceNode.connect(processorNode);
      processorNode.connect(sinkNode);
      sinkNode.connect(inputContext.destination);
    } catch (error) {
      fail(t('microphone'));
      return false;
    }
    return true;
  }

  async function start() {
    if (disposed || active) return;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      fail(t('insecure'));
      return;
    }
    const AudioCtor =
      (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || undefined;
    if (!AudioCtor) {
      fail(t('microphone'));
      return;
    }

    active = true;
    generation += 1;
    const run = generation;
    finalFieldsReset();
    diag({
      mode: 'on',
      capture: 'starting',
      vad: 'idle',
      endSilenceMs: END_SILENCE_MS,
      continuationWindowMs: CONTINUATION_WINDOW_MS,
      follow: 'idle',
      transcribe: 'idle',
      speak: 'idle',
      prompt: 'idle',
      bargeIn: false,
    });
    post({ phase: 'listening', caption: '', note: '' });

    try {
      const response = await fetch(STATUS_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      engineTts = (status && status.tts && status.tts.engine) || 'none';
      diag({ engine: engineTts, ttsReady: Boolean(status && status.tts && status.tts.ready) });
      if (!status || status.ok !== true) throw new Error('engine not ok');
    } catch (error) {
      diag({ status: 'error', statusError: String((error && error.message) || error) });
      fail(t('engine'));
      return;
    }

    try {
      outputContext = new AudioCtor();
      if (typeof outputContext.resume === 'function') await outputContext.resume();
    } catch (error) {
      fail(t('engine'));
      return;
    }

    void pumpFollow(run);
    const captured = await startCapture();
    if (!captured) return;
    if (!active) return;
    diag({ capture: 'running' });
  }

  function finalFieldsReset() {
    rawReply = '';
    speakableSoFar = '';
    speechBuffer = '';
  }

  function dispose() {
    disposed = true;
    generation += 1;
    teardown();
  }

  return { start, stop, dispose };
}

/**
 * Read the running flag through the Session standard prop without assuming the
 * prop exists: a missing hook must degrade to a static flag, never throw, because
 * a throw inside the client bundle takes the whole Web boot down.
 *
 * @param {Function|undefined} useSession - selector hook supplied by the slot.
 * @returns {boolean} latest running state.
 */
function useRunningSafe(useSession) {
  const available = typeof useSession === 'function';
  const selected = available ? useSession((snapshot) => Boolean(snapshot && snapshot.running)) : false;
  return Boolean(selected);
}

/**
 * Bind the controller to one Session identity and render the composer control.
 *
 * @param {object} ctx - client context owning slots, locale and remote.
 * @returns {Function} React component for the composer dock slot.
 */
function createVoiceControl(ctx) {
  function VoiceControl(props) {
    const { sessionId, useSession } = props;
    const t = typeof props.t === 'function' ? props.t : (key) => key;
    const running = useRunningSafe(useSession);
    const [ui, setUi] = useState({ phase: 'off', caption: '', note: '' });
    const controller = useRef(null);
    const latest = useRef({ sessionId, running, t });
    latest.current = { sessionId, running, t };

    useEffect(() => {
      let closed = false;
      const instance = createVoiceController({
        ctx,
        getProps: () => latest.current,
        getT: () => latest.current.t,
        publish: (patch) => {
          if (!closed) setUi((previous) => ({ ...previous, ...patch }));
        },
      });
      controller.current = instance;
      return () => {
        closed = true;
        controller.current = null;
        instance.dispose();
      };
    }, [sessionId]);

    const phaseValue = ui.phase;
    const on = phaseValue !== 'off';
    const toggle = () => {
      const instance = controller.current;
      if (!instance) return;
      if (phaseValue === 'off' || phaseValue === 'error') instance.start();
      else instance.stop();
    };

    const accent =
      phaseValue === 'speaking'
        ? '#3b82f6'
        : phaseValue === 'thinking'
          ? '#f59e0b'
          : phaseValue === 'error'
            ? '#ef4444'
            : phaseValue === 'off'
              ? 'currentColor'
              : '#22c55e';
    const label =
      phaseValue === 'off'
        ? t('start')
        : phaseValue === 'error'
          ? ui.note || t('engine')
          : t('stop');
    const status =
      phaseValue === 'hearing'
        ? ui.caption || t('hearing')
        : phaseValue === 'listening'
          ? t('listening')
          : phaseValue === 'thinking'
            ? t('thinking')
            : phaseValue === 'speaking'
              ? t('speaking')
              : phaseValue === 'error'
                ? ui.note
                : '';

    const button = h(
      'button',
      {
        type: 'button',
        onClick: toggle,
        title: label,
        'aria-label': label,
        'aria-pressed': on,
        'data-dsh-voice-mode': 'button',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          padding: '0',
          borderRadius: '999px',
          border: '1px solid currentColor',
          background: on ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent',
          color: accent,
          cursor: 'pointer',
          opacity: phaseValue === 'off' ? 0.65 : 1,
          transition: 'opacity .15s ease, color .15s ease',
          flex: '0 0 auto',
        },
      },
      h(
        'svg',
        {
          width: '16',
          height: '16',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        [
          h('rect', { key: 'capsule', x: '9', y: '2', width: '6', height: '12', rx: '3' }),
          h('path', { key: 'arc', d: 'M5 10a7 7 0 0 0 14 0' }),
          h('path', { key: 'stem', d: 'M12 17v4' }),
          h('path', { key: 'base', d: 'M8 21h8' }),
        ],
      ),
    );

    return h(
      'div',
      {
        'data-dsh-voice-mode': 'control',
        'data-state': phaseValue,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
          maxWidth: '100%',
          font: 'inherit',
          color: 'inherit',
        },
      },
      [
        button,
        status
          ? h(
              'span',
              {
                key: 'status',
                'data-dsh-voice-mode': 'status',
                title: status,
                style: {
                  minWidth: 0,
                  maxWidth: '34ch',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '12px',
                  lineHeight: '1.2',
                  opacity: phaseValue === 'error' ? 0.9 : 0.7,
                  color: phaseValue === 'error' ? '#ef4444' : 'inherit',
                },
              },
              status,
            )
          : null,
      ],
    );
  }

  return VoiceControl;
}

/** Register dictionaries, the test marker and the composer slot occupant. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, DICTS));
  ctx.effect(() => {
    if (typeof window === 'undefined') return () => {};
    window.__DSH_VOICE_MODE__ = { plugin: PKG, version: VERSION, startedAt: Date.now() };
    return () => {
      if (window.__DSH_VOICE_MODE__ && window.__DSH_VOICE_MODE__.plugin === PKG) delete window.__DSH_VOICE_MODE__;
    };
  });

  const VoiceControl = createVoiceControl(ctx);
  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      {
        name: SLOT,
        id: 'voice-mode',
        order: 5,
        locale: NS,
      },
      VoiceControl,
    ),
  );
}

return { inject: ['slots', 'locale', 'remote', 'remote.session'], apply };
