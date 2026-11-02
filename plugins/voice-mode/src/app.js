/**
 * voice-mode — client half (Web GUI).
 *
 * Continuous voice conversation with the current Session:
 *  - a microphone control in the composer turns the mode on and off;
 *  - speech recognition stays open, so the user just talks;
 *  - silence ends an utterance, which is sent as the next prompt;
 *  - the assistant reply is turned into speech sentence by sentence as its
 *    process-local stream arrives;
 *  - speaking while the assistant talks stops the speech, cancels the running
 *    turn and captures the interruption as the next prompt.
 *
 * Everything here runs inside the ModuleLoader factory: React is already in
 * scope and the engine helpers (stripMarkdown, splitSentences, looksLikeEcho,
 * pickVoice, createSpeaker) were concatenated ahead of this file by
 * scripts/build.mjs.
 */

const SLOT = 'conversation.composer.dock';
const NS = 'voice-mode';
const PKG = '@local/voice-mode';
const VERSION = '0.1.0';
/** Quiet time after the last recognized word before an utterance is committed. */
const COMMIT_SILENCE_MS = 650;
/** Chrome ends a recognition session on its own; reopen it quickly and quietly. */
const RECOGNITION_RESTART_MS = 280;
const CAPTION_MAX = 220;

const DICTS = {
  en: {
    start: 'Start voice conversation',
    stop: 'Stop voice conversation',
    listening: 'Listening',
    hearing: 'Hearing you',
    thinking: 'Thinking',
    speaking: 'Speaking — talk to interrupt',
    insecure: 'Voice mode needs HTTPS or localhost',
    unavailable: 'This browser has no speech recognition (use Chrome or Edge)',
    permission: 'Microphone permission denied',
    network: 'Speech recognition needs a network connection',
    composer: 'The message composer is not ready',
    promptFailed: 'Could not send the message',
  },
  // The locale service requires every built-in dictionary; Chinese users see the
  // English strings until a proper translation lands.
  zh: {
    start: '开始语音对话',
    stop: '结束语音对话',
    listening: '正在聆听',
    hearing: '正在听你说',
    thinking: '思考中',
    speaking: '朗读中 — 说话即可打断',
    insecure: '语音模式需要 HTTPS 或 localhost',
    unavailable: '此浏览器不支持语音识别（请使用 Chrome 或 Edge）',
    permission: '麦克风权限被拒绝',
    network: '语音识别需要网络连接',
    composer: '消息输入框尚未就绪',
    promptFailed: '消息发送失败',
  },
};

/** Current tab language, falling back to English. */
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
 * Build the per-Session voice controller. It owns the recognition, the speaker
 * and the assistant-stream follower; the React component only renders its state
 * and forwards clicks.
 *
 * @param {object} options - owning client context, prop reader, translator, state publisher.
 * @returns {object} controller with start/stop/dispose.
 */
function createVoiceController(options) {
  const { ctx, getProps, getT, publish } = options;
  const remote = ctx.remote;

  let active = false;
  let disposed = false;
  let recognition = null;
  let speaker = null;
  let followAbort = null;
  let commitTimer = 0;
  let restartTimer = 0;
  let finalText = '';
  let interimText = '';
  let rawReply = '';
  let speakableSoFar = '';
  let spokenTail = '';
  let generation = 0;
  let followFrames = 0;

  const post = (patch) => publish(patch);
  const t = (key) => String(getT()(key));

  /**
   * Publish machine-readable runtime state next to the boot marker so a
   * headless probe can prove the voice loop reached its transport, without
   * reading the conversation or sending a prompt itself.
   *
   * @param {object} patch - fields merged into `window.__DSH_VOICE_MODE__`.
   */
  function diag(patch) {
    if (typeof window === 'undefined') return;
    const marker = window.__DSH_VOICE_MODE__;
    if (!marker || marker.plugin !== PKG) return;
    Object.assign(marker, patch);
  }

  /** Release audio and transport resources without touching rendered state. */
  function teardown() {
    active = false;
    diag({ mode: 'off', recognition: 'stopped', follow: 'closed' });
    clearTimeout(commitTimer);
    clearTimeout(restartTimer);
    commitTimer = 0;
    restartTimer = 0;

    const recognizer = recognition;
    recognition = null;
    if (recognizer) {
      recognizer.onresult = null;
      recognizer.onerror = null;
      recognizer.onend = null;
      try {
        recognizer.abort();
      } catch (error) {
        /* already stopped */
      }
    }

    const speech = speaker;
    speaker = null;
    if (speech) {
      try {
        speech.stop();
      } catch (error) {
        /* speaker already idle */
      }
      try {
        speech.dispose();
      } catch (error) {
        /* already disposed */
      }
    }

    const stream = followAbort;
    followAbort = null;
    if (stream) {
      try {
        stream.abort();
      } catch (error) {
        /* stream already closed */
      }
    }

    finalText = '';
    interimText = '';
    rawReply = '';
    speakableSoFar = '';
    spokenTail = '';
  }

  function stop() {
    teardown();
    post({ phase: 'off', caption: '', note: '' });
  }

  /** Fatal setup or permission failure: release everything and show one note. */
  function fail(message) {
    teardown();
    post({ phase: 'error', caption: '', note: String(message) });
  }

  function phase(value) {
    post({ phase: value });
  }

  function caption(value) {
    post({ caption: value });
  }

  function isSpeaking() {
    return Boolean(speaker && speaker.speaking);
  }

  function settlePhase() {
    if (!active) return;
    if (isSpeaking()) return;
    if (getProps().running) {
      phase('thinking');
      return;
    }
    phase('listening');
  }

  /** Speak the newly arrived part of the assistant reply. */
  function feedSpeech() {
    if (!speaker || !rawReply) return;
    const speakable = stripMarkdown(rawReply);
    if (speakable === speakableSoFar) return;
    // Markdown rewriting can shorten earlier output (a fence closing, a table
    // collapsing); on such a rewrite advance nothing and stay aligned.
    if (speakable.length < speakableSoFar.length || !speakable.startsWith(speakableSoFar)) {
      speakableSoFar = speakable;
      return;
    }
    const delta = speakable.slice(speakableSoFar.length);
    speakableSoFar = speakable;
    if (delta.trim() === '') return;
    spokenTail = `${spokenTail} ${delta}`.slice(-600);
    speaker.push(delta);
  }

  function flushSpeech() {
    if (!speaker) return;
    speaker.flush();
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
        // A deliberate teardown aborts the stream; that is not a failure.
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
  async function send(text) {
    const props = getProps();
    if (!props || !props.sessionId) {
      fail(t('composer'));
      return;
    }
    if (!remote || !remote.session || typeof remote.session.prompt !== 'function') {
      fail(t('composer'));
      return;
    }
    phase('thinking');
    diag({ prompt: 'writing', lastPrompt: text.slice(0, 160) });
    if (props.running) {
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
        mode: 'queue',
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

  /** Close the current utterance after a quiet period and send it. */
  function commit() {
    clearTimeout(commitTimer);
    commitTimer = 0;
    if (!active) return;
    const text = `${finalText} ${interimText}`.replace(/\s+/g, ' ').trim();
    finalText = '';
    interimText = '';
    caption('');
    if (!text) return;
    void send(text);
  }

  /** True when `probe` is the user talking over the assistant rather than echo. */
  function shouldInterrupt(probe) {
    if (!isSpeaking()) return false;
    const spoken = `${speaker.currentText || ''} ${spokenTail}`.trim();
    return !looksLikeEcho(probe, spoken);
  }

  /** Stop the reply, cancel the running turn, and take over the conversation. */
  function bargeIn() {
    if (!active) return;
    if (speaker) {
      try {
        speaker.stop();
      } catch (error) {
        /* already idle */
      }
    }
    const props = getProps();
    if (props && props.running && remote && remote.session) {
      Promise.resolve(remote.session.cancel({ sessionId: props.sessionId })).catch(() => {});
    }
    phase('hearing');
  }

  function onResult(event) {
    if (!active) return;
    let finalPart = '';
    let interimPart = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result && result[0];
      const text = alternative && alternative.transcript ? alternative.transcript : '';
      if (!text) continue;
      if (result.isFinal) finalPart += text;
      else interimPart += text;
    }
    const probe = (finalPart || interimPart).trim();
    if (probe && shouldInterrupt(probe)) bargeIn();
    if (finalPart) finalText = `${finalText} ${finalPart}`.trim();
    interimText = interimPart;
    const shown = `${finalText} ${interimText}`.replace(/\s+/g, ' ').trim();
    caption(shown.slice(-CAPTION_MAX));
    if (shown && !isSpeaking()) phase('hearing');

    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_SILENCE_MS);
  }

  function startRecognition(Ctor) {
    try {
      recognition = new Ctor();
    } catch (error) {
      fail(t('unavailable'));
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = voiceLanguage();
    recognition.onresult = onResult;
    recognition.onerror = (event) => {
      const code = event && event.error;
      diag({ recognition: 'error', recognitionError: String(code || 'unknown') });
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        fail(t('permission'));
        return;
      }
      if (code === 'network') {
        post({ note: t('network') });
      }
      // `no-speech` and `aborted` are the normal end of a quiet phrase.
    };
    recognition.onend = () => {
      if (!active) return;
      diag({ recognition: 'restarting' });
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!active || !recognition) return;
        try {
          recognition.start();
        } catch (error) {
          /* a start is already pending */
        }
      }, RECOGNITION_RESTART_MS);
    };
    try {
      recognition.start();
      diag({ recognition: 'started' });
    } catch (error) {
      diag({ recognition: 'failed', recognitionError: String((error && error.message) || error) });
      fail(t('unavailable'));
    }
  }

  function start() {
    if (disposed || active) return;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      fail(t('insecure'));
      return;
    }
    const Ctor =
      typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!Ctor) {
      fail(t('unavailable'));
      return;
    }
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) {
      fail(t('unavailable'));
      return;
    }

    active = true;
    generation += 1;
    const run = generation;
    finalText = '';
    interimText = '';
    rawReply = '';
    speakableSoFar = '';
    spokenTail = '';
    diag({ mode: 'on', recognition: 'starting', follow: 'idle', prompt: 'idle' });
    post({ phase: 'listening', caption: '', note: '' });

    speaker = createSpeaker({
      lang: voiceLanguage(),
      rate: 1,
      synth,
      // The engine reports per-utterance callbacks; onState is accepted too when
      // the engine version exposes the aggregate transition callback.
      onstart: () => {
        if (active) phase('speaking');
      },
      onend: () => {
        if (active) settlePhase();
      },
      onerror: () => {
        if (active) settlePhase();
      },
      onState: (state) => {
        if (!active) return;
        const speaking = state && typeof state === 'object' ? state.speaking : Boolean(state);
        if (speaking) phase('speaking');
        else settlePhase();
      },
    });

    startRecognition(Ctor);
    void pumpFollow(run);
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
          ? ui.note || t('unavailable')
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

// `remote.session` is its own injectable namespace: without the dotted key the
// Cordis getter throws on first access ("cannot get property remote.session
// without inject"), which killed the follow loop before it opened.
return { inject: ['slots', 'locale', 'remote', 'remote.session'], apply };
