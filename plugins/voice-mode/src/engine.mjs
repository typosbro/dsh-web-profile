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

export function stripMarkdown(text) {
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

export function splitSentences(text) {
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

export function looksLikeEcho(transcript, spokenText) {
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

export function pickVoice(voices, lang) {
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

export function createSpeaker(options) {
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
