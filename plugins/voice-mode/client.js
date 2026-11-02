/**
 * @local/voice-mode 0.2.0 — generated browser artifact, do not edit.
 * Source: src/engine.mjs + src/app.js. Rebuild: `node scripts/build.mjs`.
 *
 * Browser Client halves are classic scripts: this file registers a lazy factory
 * whose id equals the package name. React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: "@local/voice-mode",
  factory(require) {
    const React = require('react');
    const { useState, useRef, useEffect } = React;
    const h = React.createElement;

    /* @local/voice-mode -- pure, dependency-free speech engine helpers.
     *
     * Build contract for scripts/build.mjs: this file is concatenated into a classic
     * browser script by removing the leading "export " token from exported
     * declarations. Keep this file free of imports, "export default", "export { }",
     * and top-level side effects. Every exported declaration starts its own line
     * with "export ".
     *
     * All browser API access is injected through createSpeaker(options) with
     * globalThis guards, so the module can be imported and unit tested headlessly.
     */

    const VOICE_MODE_MAX_SENTENCE_CHARS = 220;

    const VOICE_MODE_TERMINATOR_CHARS = '.!?\u3002\uFF01\uFF1F\u2026';
    const VOICE_MODE_CJK_TERMINATOR_CHARS = '\u3002\uFF01\uFF1F\u2026';
    const VOICE_MODE_CLOSING_QUOTE_CHARS = '"\'\u201d\u2019\u300d\u300f\uFF09)]';

    const VOICE_MODE_STOP_PHRASES = [
      'stop',
      'wait',
      'no',
      'hold on',
      'shut up',
      'pause',
      'cancel',
    ];

    const VOICE_MODE_ABBREVIATIONS = [
      'mr',
      'mrs',
      'ms',
      'dr',
      'prof',
      'sr',
      'jr',
      'st',
      'vs',
      'etc',
      'e.g',
      'i.e',
      'a.m',
      'p.m',
      'u.s',
      'u.k',
      'fig',
      'dept',
      'approx',
      'est',
      'cf',
      'al',
      'eds',
      'ed',
      'pp',
      'vol',
      'mt',
      'ft',
      'km',
      'kg',
    ];

    const VOICE_MODE_HAS_SPEAKABLE_TEXT = /[\p{L}\p{N}]/u;

    /* ------------------------------------------------------------------------- *
     * Markdown -> speech text
     * ------------------------------------------------------------------------- */

    function stripMarkdown(text) {
      if (typeof text !== 'string' || text.length === 0) return '';
      let value = text.replace(/\r\n?/g, '\n');

      // Fence runs of three or more backticks/tildes are equivalent in Markdown;
      // normalise them first so a `~~~~` line cannot leave a stray `~` behind.
      value = value.replace(/^[ \t]*`{3,}[ \t]*$/gm, '```');
      value = value.replace(/^[ \t]*~{3,}[ \t]*$/gm, '~~~');

      // Fenced code blocks (closed, then a still-streaming open fence) are replaced
      // with an audible marker so the listener knows content was skipped.
      value = value.replace(/```[\s\S]*?```/g, ' (code omitted) ');
      value = value.replace(/~~~[\s\S]*?~~~/g, ' (code omitted) ');
      value = value.replace(/```[\s\S]*$/g, ' (code omitted) ');
      value = value.replace(/~~~[\s\S]*$/g, ' (code omitted) ');

      // Images before links: ![alt](url) -> alt
      value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      value = value.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

      // Inline code keeps its contents, drops the backticks.
      value = value.replace(/`([^`]+)`/g, '$1');

      // HTML comments/tags are silent.
      value = value.replace(/<!--[\s\S]*?-->/g, ' ');
      value = value.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

      // Headings: drop the leading hash marker and any closing hash run.
      value = value.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
      value = value.replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, '');
      value = value.replace(/[ \t]+#{1,6}[ \t]*$/gm, '');

      // Horizontal rules (before bullets/emphasis so "***" does not leak through).
      value = value.replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '');

      // Blockquotes.
      value = value.replace(/^[ \t]{0,3}>[ \t]?/gm, '');

      // Markdown table alignment rows are structural noise; drop the whole row.
      value = value.replace(
        /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm,
        ''
      );

      // Bullets, numbered lists, task checkboxes.
      value = value.replace(/^[ \t]*[-*+][ \t]+/gm, '');
      value = value.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
      value = value.replace(/^[ \t]*\[[ xX]\][ \t]+/gm, '');

      // Strikethrough, then bold, then italic.
      value = value.replace(/~~([^~]+)~~/g, '$1');
      value = value.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
      value = value.replace(/\*\*([^*]+)\*\*/g, '$1');
      value = value.replace(/(^|[^\w])__([^_]+)__(?![\w])/g, '$1$2');
      value = value.replace(/\*([^*\n]+)\*/g, '$1');
      value = value.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, '$1$2');

      // Table cell separators become a spoken gap.
      value = value.replace(/[ \t]*\|[ \t]*/g, ' ');

      // Collapse whitespace; punctuation is preserved.
      value = value.replace(/[ \t]+/g, ' ');
      value = value.replace(/ *\n */g, '\n');
      value = value.replace(/\n{2,}/g, ' ');
      value = value.replace(/\n/g, ' ');
      value = value.replace(/ {2,}/g, ' ');
      return value.trim();
    }

    /* ------------------------------------------------------------------------- *
     * Streaming sentence splitter
     * ------------------------------------------------------------------------- */

    function splitSentences(text) {
      const sentences = [];
      const source = typeof text === 'string' ? text : '';
      if (source.length === 0) return { sentences, rest: '' };

      let start = 0;
      let index = 0;
      const length = source.length;

      while (index < length) {
        const char = source[index];

        if (char === '\n' || (char === '\r' && source[index + 1] !== '\n')) {
          const piece = source.slice(start, index).trim();
          if (voiceModeIsSpeakablePiece(piece)) sentences.push(piece);
          start = index + 1;
          index += 1;
          continue;
        }
        if (char === '\r') {
          index += 1;
          continue;
        }
        if (VOICE_MODE_TERMINATOR_CHARS.indexOf(char) === -1) {
          index += 1;
          continue;
        }

        // Consume the punctuation run (e.g. "?!", "...", "……").
        let runEnd = index;
        while (
          runEnd < length &&
          VOICE_MODE_TERMINATOR_CHARS.indexOf(source[runEnd]) !== -1
        ) {
          runEnd += 1;
        }

        // A sentence may close with quotes/brackets that belong to it.
        let boundary = runEnd;
        while (
          boundary < length &&
          VOICE_MODE_CLOSING_QUOTE_CHARS.indexOf(source[boundary]) !== -1
        ) {
          boundary += 1;
        }

        const atEnd = boundary >= length;
        const isCjk = VOICE_MODE_CJK_TERMINATOR_CHARS.indexOf(char) !== -1;
        // CJK prose has no spaces after punctuation, so CJK terminators always end
        // a sentence; ASCII terminators need whitespace / end / a closing quote.
        const endsSentence = isCjk || atEnd || /\s/.test(source[boundary]);

        if (!endsSentence) {
          index = runEnd;
          continue;
        }
        if (char === '.' && voiceModeIsAbbreviation(source, index, boundary)) {
          index = runEnd;
          continue;
        }

        const piece = source.slice(start, boundary).trim();
        if (voiceModeIsSpeakablePiece(piece)) sentences.push(piece);
        start = boundary;
        index = boundary;
      }

      const complete = [];
      for (let i = 0; i < sentences.length; i += 1) {
        const piece = sentences[i];
        if (piece.length <= VOICE_MODE_MAX_SENTENCE_CHARS) {
          complete.push(piece);
          continue;
        }
        const forced = voiceModeForceSplit(piece);
        for (let j = 0; j < forced.pieces.length; j += 1) complete.push(forced.pieces[j]);
        if (forced.rest) complete.push(forced.rest);
      }

      let rest = source.slice(start).trim();
      if (rest.length > VOICE_MODE_MAX_SENTENCE_CHARS) {
        const forced = voiceModeForceSplit(rest);
        for (let j = 0; j < forced.pieces.length; j += 1) complete.push(forced.pieces[j]);
        rest = forced.rest;
      }

      return { sentences: complete, rest };
    }

    function voiceModeIsSpeakablePiece(piece) {
      return typeof piece === 'string' && VOICE_MODE_HAS_SPEAKABLE_TEXT.test(piece);
    }

    function voiceModeIsAbbreviation(text, terminatorIndex, boundary) {
      // Token immediately before the period, allowing internal dots ("e.g", "U.S").
      let tokenStart = terminatorIndex;
      while (tokenStart > 0) {
        const char = text[tokenStart - 1];
        const isLetter =
          (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
        if (isLetter || char === '.') {
          tokenStart -= 1;
          continue;
        }
        break;
      }
      const token = text.slice(tokenStart, terminatorIndex).replace(/\.+$/, '');
      if (!token) return false;

      if (VOICE_MODE_ABBREVIATIONS.indexOf(token.toLowerCase()) !== -1) return true;
      // Initialisms such as U.S., e.g., i.e., Ph.D.
      if (/^[A-Za-z]{1,3}(?:\.[A-Za-z]{1,3})+$/.test(token)) return true;

      // Single-letter initials: "J. K. Rowling", but not a one-letter sentence.
      if (token.length === 1 && /[A-Za-z]/.test(token)) {
        const previous = tokenStart > 0 ? text[tokenStart - 1] : '';
        if (previous && !/\s/.test(previous) && previous !== '(') return false;
        let nextIndex = boundary;
        while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex += 1;
        const nextChar = nextIndex < text.length ? text[nextIndex] : '';
        return /[A-Z]/.test(nextChar);
      }

      return false;
    }

    function voiceModeForceSplit(text) {
      const pieces = [];
      let remaining = text;
      while (remaining.length > VOICE_MODE_MAX_SENTENCE_CHARS) {
        let cut = -1;
        const limit = Math.min(remaining.length - 1, VOICE_MODE_MAX_SENTENCE_CHARS - 1);
        for (let index = limit; index > 0; index -= 1) {
          const char = remaining[index];
          if (char === ' ' || char === '\t') {
            cut = index;
            break;
          }
          if (
            char === ',' ||
            char === ';' ||
            char === '\u3001' ||
            char === '\uFF0C' ||
            char === '\uFF1B'
          ) {
            cut = index + 1;
            break;
          }
        }
        if (cut <= 0) cut = VOICE_MODE_MAX_SENTENCE_CHARS;
        const piece = remaining.slice(0, cut).trim();
        if (voiceModeIsSpeakablePiece(piece)) pieces.push(piece);
        remaining = remaining.slice(cut).trim();
      }
      return { pieces, rest: remaining };
    }

    /* ------------------------------------------------------------------------- *
     * Echo / barge-in detection
     * ------------------------------------------------------------------------- */

    function looksLikeEcho(transcript, spokenText) {
      const heard = voiceModeNormalizeForEcho(transcript);
      const spoken = voiceModeNormalizeForEcho(spokenText);
      if (!heard || !spoken) return false;

      // A terse barge-in command must never be mistaken for our own audio.
      if (VOICE_MODE_STOP_PHRASES.indexOf(heard) !== -1) return false;

      // The cheapest and most reliable case: we picked up a verbatim fragment.
      if (spoken.indexOf(heard) !== -1) return true;

      const heardWords = heard.split(' ');
      if (heardWords.length < 2 || heard.length < 8) return false;
      const spokenWords = spoken.split(' ');
      const spokenSet = Object.create(null);
      for (let i = 0; i < spokenWords.length; i += 1) spokenSet[spokenWords[i]] = true;

      let matches = 0;
      for (let i = 0; i < heardWords.length; i += 1) {
        if (spokenSet[heardWords[i]]) matches += 1;
      }
      const overlap = matches / heardWords.length;

      // Echo from the speakers starts at the head of the transcript, so a real echo
      // begins with a contiguous bigram of what is being spoken. A genuine request
      // that merely reuses common words ("what is the capital of ...") does not.
      const onset = ' ' + heardWords[0] + ' ' + heardWords[1] + ' ';
      const onsetPresent = (' ' + spoken + ' ').indexOf(onset) !== -1;

      return onsetPresent && overlap >= 0.6;
    }

    function voiceModeNormalizeForEcho(value) {
      if (typeof value !== 'string' || value.length === 0) return '';
      let normalized = value.toLowerCase();
      try {
        if (typeof normalized.normalize === 'function') normalized = normalized.normalize('NFKD');
      } catch (error) {
        normalized = value.toLowerCase();
      }
      normalized = normalized.replace(/[\u0300-\u036f]/g, '');
      normalized = normalized.replace(/[^\p{L}\p{N}]+/gu, ' ');
      return normalized.trim();
    }

    /* ------------------------------------------------------------------------- *
     * Voice selection
     * ------------------------------------------------------------------------- */

    function pickVoice(voices, lang) {
      if (!Array.isArray(voices)) return undefined;
      const candidates = [];
      for (let i = 0; i < voices.length; i += 1) {
        const voice = voices[i];
        if (voice && typeof voice === 'object') candidates.push(voice);
      }
      if (candidates.length === 0) return undefined;

      const wanted = voiceModeNormalizeLang(lang);
      if (wanted) {
        const exact = [];
        const prefix = [];
        const wantedPrimary = voiceModePrimaryLang(wanted);
        for (let i = 0; i < candidates.length; i += 1) {
          const candidateLang = voiceModeNormalizeLang(candidates[i].lang);
          if (!candidateLang) continue;
          if (candidateLang === wanted) {
            exact.push(candidates[i]);
          } else if (voiceModePrimaryLang(candidateLang) === wantedPrimary) {
            prefix.push(candidates[i]);
          }
        }
        if (exact.length > 0) return voiceModePickBestVoice(exact);
        if (prefix.length > 0) return voiceModePickBestVoice(prefix);
      }

      // Contract: only an empty voice list yields undefined.
      return voiceModePickBestVoice(candidates);
    }

    function voiceModeNormalizeLang(lang) {
      if (typeof lang !== 'string') return '';
      return lang.trim().toLowerCase().replace(/_/g, '-');
    }

    function voiceModePrimaryLang(lang) {
      const dash = lang.indexOf('-');
      return dash === -1 ? lang : lang.slice(0, dash);
    }

    function voiceModePickBestVoice(candidates) {
      let best = candidates[0];
      let bestLocal = best.localService === true;
      let bestDefault = best.default === true;
      for (let i = 1; i < candidates.length; i += 1) {
        const voice = candidates[i];
        const local = voice.localService === true;
        if (local !== bestLocal) {
          if (local) {
            best = voice;
            bestLocal = true;
            bestDefault = voice.default === true;
          }
          continue;
        }
        const isDefault = voice.default === true;
        if (!bestDefault && isDefault) {
          best = voice;
          bestDefault = true;
        }
      }
      return best;
    }

    /* ------------------------------------------------------------------------- *
     * Speech queue / speaker
     * ------------------------------------------------------------------------- */

    function createSpeaker(options) {
      const config = options && typeof options === 'object' ? options : {};
      const synth =
        config.synth ||
        (typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : undefined) ||
        null;
      const UtteranceCtor =
        config.Utterance ||
        (typeof globalThis !== 'undefined' ? globalThis.SpeechSynthesisUtterance : undefined) ||
        null;
      const lang =
        typeof config.lang === 'string' && config.lang.trim() ? config.lang.trim() : 'en-US';
      const rate =
        typeof config.rate === 'number' && isFinite(config.rate) && config.rate > 0
          ? config.rate
          : 1;
      const pitch =
        typeof config.pitch === 'number' && isFinite(config.pitch) && config.pitch > 0
          ? config.pitch
          : 1;
      const volume =
        typeof config.volume === 'number' &&
        isFinite(config.volume) &&
        config.volume >= 0 &&
        config.volume <= 1
          ? config.volume
          : 1;
      const fixedVoice = config.voice && typeof config.voice === 'object' ? config.voice : null;
      const voicesOption = config.voices;
      const voicesArray = Array.isArray(voicesOption) ? voicesOption : null;
      const getVoices =
        typeof config.getVoices === 'function'
          ? config.getVoices
          : typeof voicesOption === 'function'
            ? voicesOption
            : null;

      let buffer = '';
      let queue = [];
      let speaking = false;
      let currentText = '';
      let currentUtterance = null;
      let disposed = false;
      let pumping = false;

      function invoke(callback, argument) {
        if (typeof callback !== 'function') return;
        try {
          callback(argument);
        } catch (error) {
          // Listener failures must never break the speech queue.
        }
      }

      /** Publish the speaking-state transition to the caller's UI. */
      function emitState() {
        if (typeof config.onState !== 'function') return;
        try {
          config.onState({ speaking: speaking, currentText: currentText });
        } catch (error) {
          // Listener failures must never break the speech queue.
        }
      }

      function resolveVoice() {
        if (fixedVoice) return fixedVoice;
        let list = null;
        try {
          if (getVoices) list = getVoices();
          if (!Array.isArray(list) && voicesArray) list = voicesArray;
          if (!Array.isArray(list) && synth && typeof synth.getVoices === 'function') {
            list = synth.getVoices();
          }
        } catch (error) {
          list = null;
        }
        if (!Array.isArray(list) || list.length === 0) return undefined;
        try {
          return pickVoice(list, lang);
        } catch (error) {
          return undefined;
        }
      }

      function createUtterance(text) {
        if (!UtteranceCtor) return null;
        let utterance;
        try {
          utterance = new UtteranceCtor(text);
        } catch (error) {
          return null;
        }
        if (!utterance || typeof utterance !== 'object') return null;
        try {
          utterance.lang = lang;
        } catch (error) {
          // Some host utterance objects have non-writable defaults; ignore.
        }
        try {
          utterance.rate = rate;
        } catch (error) {
          // ignore
        }
        try {
          utterance.pitch = pitch;
        } catch (error) {
          // ignore
        }
        try {
          utterance.volume = volume;
        } catch (error) {
          // ignore
        }
        // Voices are resolved lazily, per utterance, because browsers load them
        // asynchronously after page boot.
        const voice = resolveVoice();
        if (voice) {
          try {
            utterance.voice = voice;
          } catch (error) {
            // ignore
          }
        }
        return utterance;
      }

      function pump() {
        if (pumping || disposed || speaking) return;
        pumping = true;
        try {
          while (!disposed && !speaking && queue.length > 0) {
            const text = queue.shift();
            if (!voiceModeIsSpeakablePiece(text)) continue;
            if (!synth || typeof synth.speak !== 'function' || !UtteranceCtor) {
              // Nothing can be spoken in this environment; drop pending work.
              queue = [];
              break;
            }

            const utterance = createUtterance(text);
            if (!utterance) continue;

            let settled = false;
            const finish = function (error) {
              if (settled) return;
              settled = true;
              if (currentUtterance === utterance) {
                currentUtterance = null;
                currentText = '';
                speaking = false;
                emitState();
              }
              if (error) invoke(config.onerror, error);
              else invoke(config.onend, text);
              pump();
            };

            utterance.onstart = function () {
              invoke(config.onstart, text);
            };
            utterance.onend = function () {
              finish(null);
            };
            utterance.onerror = function (event) {
              finish(event || new Error('speech synthesis error'));
            };

            currentUtterance = utterance;
            currentText = text;
            speaking = true;
            emitState();
            try {
              synth.speak(utterance);
            } catch (error) {
              finish(error);
            }
          }
        } finally {
          pumping = false;
        }
      }

      function drain() {
        if (!buffer) return;
        const split = splitSentences(buffer);
        buffer = split.rest;
        if (split.sentences.length === 0) return;
        for (let i = 0; i < split.sentences.length; i += 1) {
          const sentence = split.sentences[i];
          if (voiceModeIsSpeakablePiece(sentence)) queue.push(sentence.trim());
        }
        pump();
      }

      function push(text) {
        if (disposed || typeof text !== 'string' || text.length === 0) return;
        buffer += text;
        drain();
      }

      function flush() {
        if (disposed) return;
        drain();
        const remainder = buffer.trim();
        buffer = '';
        if (!voiceModeIsSpeakablePiece(remainder)) return;
        queue.push(remainder);
        pump();
      }

      function stop() {
        queue = [];
        buffer = '';
        const utterance = currentUtterance;
        const wasSpeaking = speaking;
        currentUtterance = null;
        currentText = '';
        speaking = false;
        if (wasSpeaking) emitState();
        if (utterance) {
          try {
            utterance.onstart = null;
          } catch (error) {
            // ignore
          }
          try {
            utterance.onend = null;
          } catch (error) {
            // ignore
          }
          try {
            utterance.onerror = null;
          } catch (error) {
            // ignore
          }
        }
        if (synth && typeof synth.cancel === 'function') {
          try {
            synth.cancel();
          } catch (error) {
            // Browsers can throw if speech is not available; barge-in must not.
          }
        }
      }

      function dispose() {
        if (disposed) return;
        stop();
        disposed = true;
      }

      return {
        push: push,
        flush: flush,
        stop: stop,
        dispose: dispose,
        get speaking() {
          return speaking;
        },
        get currentText() {
          return currentText;
        },
      };
    }

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
    function scriptProcessorSizeMs(sampleRate, bufferSize) {
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
    function resampleLinear(input, fromRate, toRate) {
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
    function float32ToPcm16(samples) {
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
    function encodeWav16(samples, sampleRate) {
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
    function createVad(options) {
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
  },
});
