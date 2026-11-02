/**
 * voice-mode — local text-to-speech engines for the Host half.
 *
 * Two engines, both on this Mac and neither one a network call:
 *
 *   1. Kokoro int8 multi-lang via `sherpa-onnx-node` (the natural-voice path).
 *      Loaded lazily, single-flight, one instance per language because the
 *      Kokoro `lang` field selects espeak's text-normalisation language.
 *   2. macOS `say` rendered to a temp WAV and parsed back into float samples.
 *      Used for Hangul (Kokoro has no Korean voice) and as the fallback when
 *      Kokoro cannot load or fails to synthesise the text.
 *
 * The engine never throws for a missing voice: callers get samples or a
 * {@link VoiceEngineError} carrying a machine-readable `code` and a hint.
 *
 * Resolution note: `sherpa-onnx-node` is the plugin's declared dependency, but
 * this module also probes the pnpm global store so `node tools/tts-check.mjs`
 * works from a checkout where the profile install has not run yet. The extra
 * paths only run after normal resolution fails.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SID_MAX, SID_MIN, detectScript } from './validate.js';
import { parseWav } from './wav.js';

const execFile = promisify(execFileCallback);

/** Directory name of the extracted Kokoro v1.0 int8 multi-lang model. */
export const KOKORO_MODEL_DIR_NAME = 'kokoro-int8-multi-lang-v1_0';

/** Kokoro v1.0 sample rate in Hz (from the ONNX metadata: 24000). */
export const KOKORO_SAMPLE_RATE = 24000;

/** Kokoro v1.0 voice-table size (from the ONNX metadata: 54). */
export const KOKORO_SPEAKER_COUNT = 54;

/** Default English speaker: `af_heart` (sid 3) is the most natural voice. */
export const KOKORO_DEFAULT_SID = 3;

/** Sample rate requested from macOS `say` so both engines agree. */
export const SAY_SAMPLE_RATE = 24000;

/**
 * Kokoro v1.0 speaker table, indexed by speaker id (`id2speaker` from the ONNX
 * metadata). Voices are grouped by language: af/am American English, bf/bm
 * British English, ef/em Spanish, ff French, hf/hm Hindi, if/im Italian,
 * jf/jm Japanese, pf/pm Portuguese, zf/zm Chinese.
 */
export const KOKORO_SIDS = Object.freeze([
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_heart',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
  'ef_dora',
  'em_alex',
  'ff_siwis',
  'hf_alpha',
  'hf_beta',
  'hm_omega',
  'hm_psi',
  'if_sara',
  'im_nicola',
  'jf_alpha',
  'jf_gongitsune',
  'jf_nezumi',
  'jf_tebukuro',
  'jm_kumo',
  'pf_dora',
  'pm_alex',
  'pm_santa',
  'zf_xiaobei',
  'zf_xiaoni',
  'zf_xiaoxiao',
  'zf_xiaoyi',
  'zm_yunjian',
  'zm_yunxi',
  'zm_yunxia',
  'zm_yunyang',
  'em_santa',
]);

/** Kokoro `lang` config value per detected script; Hangul has no Kokoro voice. */
export const KOKORO_LANG_BY_SCRIPT = Object.freeze({ latin: 'en-us', cjk: 'zh', kana: 'ja' });

/** Default speaker per detected script (English keeps the shared default). */
export const DEFAULT_SID_BY_SCRIPT = Object.freeze({ latin: KOKORO_DEFAULT_SID, cjk: 47, kana: 37 });

/** Detected script per explicit `lang` override accepted by the speak route. */
const SCRIPT_BY_LANG = new Map([
  ['en', 'latin'],
  ['en-us', 'latin'],
  ['en-gb', 'latin'],
  ['zh', 'cjk'],
  ['ja', 'kana'],
  ['ko', 'hangul'],
]);

/** Locale family used to pick a macOS `say` voice per script. */
const SAY_LOCALE_BY_SCRIPT = new Map([
  ['latin', 'en_US'],
  ['cjk', 'zh_CN'],
  ['kana', 'ja_JP'],
  ['hangul', 'ko_KR'],
]);

/** Natural voices tried first per script before any installed voice is used. */
const SAY_VOICE_PREFERENCES = new Map([
  ['latin', ['Samantha', 'Allison', 'Ava', 'Susan', 'Alex', 'Tom', 'Fred', 'Daniel', 'Karen']],
  ['cjk', ['Tingting', 'Ting-Ting', 'Mei-Jia', 'Sin-Ji']],
  ['kana', ['Kyoko', 'Otoya']],
  ['hangul', ['Yuna', 'Sora']],
]);

/** macOS `say` speaking rate, words per minute, at speed 1.0. */
const SAY_BASE_RATE = 175;

/**
 * A local TTS failure with a stable code for the HTTP layer to map.
 */
export class VoiceEngineError extends Error {
  /**
   * @param {string} code - stable machine-readable reason.
   * @param {string} message - human-readable detail.
   * @param {{ hint?: string, cause?: unknown }} [options] - caller hint and cause.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VoiceEngineError';
    this.code = code;
    this.hint = options.hint;
  }
}

/**
 * Resolve the Kokoro model directory: env override, else the DSH home layout.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute model directory.
 */
export function resolveKokoroModelDir(env = process.env) {
  const override = typeof env.VOICE_MODE_KOKORO_DIR === 'string' ? env.VOICE_MODE_KOKORO_DIR.trim() : '';
  if (override !== '') return override;
  return join(homedir(), '.dsh', 'voice-mode', 'tts', KOKORO_MODEL_DIR_NAME);
}

/**
 * Locate the files the Kokoro loader needs, or report that they are missing.
 * @param {string} [modelDir] - candidate model directory.
 * @returns {{modelDir: string, model: string, voices: string, tokens: string, dataDir: string, lexicon: string, lexicons: string[], modelBytes: number} | null} existing model paths.
 */
export function findKokoroModel(modelDir = resolveKokoroModelDir()) {
  const paths = {
    modelDir,
    model: join(modelDir, 'model.int8.onnx'),
    voices: join(modelDir, 'voices.bin'),
    tokens: join(modelDir, 'tokens.txt'),
    dataDir: join(modelDir, 'espeak-ng-data'),
  };
  let modelBytes;
  try {
    for (const key of ['model', 'voices', 'tokens']) {
      const info = statSync(paths[key]);
      if (!info.isFile() || info.size === 0) return null;
      if (key === 'model') modelBytes = info.size;
    }
    if (!statSync(paths.dataDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const lexicons = ['lexicon-us-en.txt', 'lexicon-zh.txt']
    .map((name) => join(modelDir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  return { ...paths, lexicon: lexicons.join(','), lexicons, modelBytes };
}

/**
 * Load `sherpa-onnx-node`: normal dependency resolution first, then an explicit
 * env override, then the pnpm global store (dev checkout convenience).
 * @param {{ env?: NodeJS.ProcessEnv, require?: NodeRequire }} [options] - injection points for tests.
 * @returns {typeof import('sherpa-onnx-node')} the native addon wrapper.
 * @throws {VoiceEngineError} when no candidate loads.
 */
export function loadSherpaModule(options = {}) {
  const env = options.env ?? process.env;
  const requireFrom = options.require ?? createRequire(import.meta.url);
  /** @type {string[]} */
  const failures = [];
  const attempt = (specifier, label) => {
    try {
      return requireFrom(specifier);
    } catch (error) {
      failures.push(`${label}: ${error?.code ?? error?.message ?? String(error)}`);
      return undefined;
    }
  };

  const resolved = attempt('sherpa-onnx-node', 'dependency');
  if (resolved !== undefined) return resolved;

  const override = typeof env.VOICE_MODE_SHERPA_NODE === 'string' ? env.VOICE_MODE_SHERPA_NODE.trim() : '';
  if (override !== '') {
    const loaded = attempt(override, 'VOICE_MODE_SHERPA_NODE');
    if (loaded !== undefined) return loaded;
  }

  const store = typeof env.VOICE_MODE_PNPM_STORE === 'string' && env.VOICE_MODE_PNPM_STORE.trim() !== ''
    ? env.VOICE_MODE_PNPM_STORE.trim()
    : join(homedir(), 'Library', 'pnpm', 'global', '5', '.pnpm');
  try {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('sherpa-onnx-node@')) continue;
      const loaded = attempt(join(store, entry, 'node_modules', 'sherpa-onnx-node'), entry);
      if (loaded !== undefined) return loaded;
    }
  } catch (error) {
    failures.push(`pnpm store ${store}: ${error?.code ?? error?.message ?? String(error)}`);
  }

  throw new VoiceEngineError(
    'engine-unavailable',
    `sherpa-onnx-node is not loadable (${failures.join('; ')})`,
    { hint: 'Add sherpa-onnx-node to the plugin dependencies and run the profile install' },
  );
}

/**
 * List voices installed for the macOS `say` command.
 * @param {typeof execFile} execFileFn - promisified execFile.
 * @param {string} sayCommand - `say` executable.
 * @param {number} timeoutMs - probe timeout.
 * @returns {Promise<Array<{name: string, locale: string, natural: boolean}>>} installed voices.
 */
async function probeSayVoices(execFileFn, sayCommand, timeoutMs) {
  const { stdout } = await execFileFn(sayCommand, ['-v', '?'], { timeout: timeoutMs, maxBuffer: 1 << 20 });
  const voices = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // `Name  locale  # sample`. Newer multilingual voices carry a parenthetical
    // locale descriptor and only one space before the locale code:
    // "Eddy (Korean (South Korea)) ko_KR    # ..."; the passable name is "Eddy".
    const match = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u.exec(trimmed);
    if (!match) continue;
    const rawName = match[1].trim();
    const name = rawName.split(' (')[0].trim() || rawName;
    if (name !== '') voices.push({ name, locale: match[2], natural: name === rawName });
  }
  return voices;
}

/**
 * Pick the best installed macOS voice for a script family.
 * @param {Array<{name: string, locale: string, natural: boolean}>} voices - installed voices.
 * @param {string} script - detected script family.
 * @param {Map<string, string>} overrides - script -> voice-name override.
 * @returns {{name: string, locale: string} | undefined} chosen voice.
 */
export function pickSayVoice(voices, script, overrides = new Map()) {
  const locale = SAY_LOCALE_BY_SCRIPT.get(script) ?? 'en_US';
  const local = voices.filter((voice) => voice.locale === locale);
  const override = overrides.get(script);
  if (typeof override === 'string' && override.trim() !== '') {
    const named = local.find((voice) => voice.name === override.trim());
    if (named !== undefined) return named;
  }
  for (const preferred of SAY_VOICE_PREFERENCES.get(script) ?? []) {
    const named = local.find((voice) => voice.name === preferred);
    if (named !== undefined) return named;
  }
  return local.find((voice) => voice.natural) ?? local[0];
}

/**
 * Build the script -> say-voice overrides from `VOICE_MODE_SAY_*` env vars.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @returns {Map<string, string>} overrides keyed by script family.
 */
function sayVoiceOverrides(env) {
  const overrides = new Map();
  const keys = new Map([
    ['latin', 'VOICE_MODE_SAY_EN'],
    ['cjk', 'VOICE_MODE_SAY_ZH'],
    ['kana', 'VOICE_MODE_SAY_JA'],
    ['hangul', 'VOICE_MODE_SAY_KO'],
  ]);
  for (const [script, key] of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') overrides.set(script, value.trim());
  }
  return overrides;
}

/**
 * Race a promise against a timeout without leaving the timer referenced.
 * @template T
 * @param {Promise<T>} promise - work to bound.
 * @param {number} timeoutMs - maximum wait.
 * @param {string} message - error message on expiry.
 * @returns {Promise<T>} the work result.
 */
function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new VoiceEngineError('timeout', message)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Normalise native samples to a plain `Float32Array`.
 * @param {unknown} samples - native generated samples.
 * @returns {Float32Array} mono float samples.
 */
function toFloat32Samples(samples) {
  if (samples instanceof Float32Array) return samples;
  if (ArrayBuffer.isView(samples)) return Float32Array.from(samples);
  if (Array.isArray(samples)) return Float32Array.from(samples);
  return new Float32Array(0);
}

/**
 * Build the local TTS engine singleton.
 *
 * `status()` is cheap (filesystem + module resolution + a cached `say` probe);
 * `synthesize()` serialises engine work so native generation never overlaps.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   modelDir?: string,
 *   defaultSid?: number,
 *   maxCachedLangs?: number,
 *   numThreads?: number,
 *   initTimeoutMs?: number,
 *   generateTimeoutMs?: number,
 *   sayTimeoutMs?: number,
 *   sayProbeTimeoutMs?: number,
 *   sayVoicesTtlMs?: number,
 *   sayCommand?: string,
 *   afconvertCommand?: string,
 *   execFile?: typeof execFile,
 *   loadSherpa?: (options?: object) => unknown,
 *   logger?: { warn?: (message: string) => void },
 * }} [options] - optional paths, limits, and test injection points.
 * @returns {{
 *   modelDir: string,
 *   status: () => Promise<object>,
 *   synthesize: (input: {text: string, sid?: number, speed?: number, lang?: string}) => Promise<object>,
 *   dispose: () => void,
 * }} the engine.
 */
export function createTtsEngine(options = {}) {
  const env = options.env ?? process.env;
  const modelDir = options.modelDir ?? resolveKokoroModelDir(env);
  const defaultSid = options.defaultSid ?? KOKORO_DEFAULT_SID;
  const maxCachedLangs = Number.isInteger(options.maxCachedLangs) && options.maxCachedLangs > 0 ? options.maxCachedLangs : 2;
  const numThreads = Number.isInteger(options.numThreads) && options.numThreads > 0 ? options.numThreads : 2;
  const initTimeoutMs = options.initTimeoutMs ?? 120_000;
  const generateTimeoutMs = options.generateTimeoutMs ?? 60_000;
  const sayTimeoutMs = options.sayTimeoutMs ?? 45_000;
  const sayProbeTimeoutMs = options.sayProbeTimeoutMs ?? 5_000;
  const sayVoicesTtlMs = options.sayVoicesTtlMs ?? 300_000;
  const sayCommand = options.sayCommand ?? (existsSync('/usr/bin/say') ? '/usr/bin/say' : 'say');
  const afconvertCommand = options.afconvertCommand ?? (existsSync('/usr/bin/afconvert') ? '/usr/bin/afconvert' : 'afconvert');
  const execFileFn = options.execFile ?? execFile;
  const loadSherpa = options.loadSherpa ?? loadSherpaModule;
  const logger = options.logger;
  const voiceOverrides = sayVoiceOverrides(env);

  /** Model path set, or null when the extracted model directory is incomplete. */
  let modelPaths;
  try {
    modelPaths = findKokoroModel(modelDir);
  } catch {
    modelPaths = null;
  }

  /** @type {Promise<unknown> | undefined} */
  let sherpaPromise;
  /** @type {unknown} */
  let sherpaModule;
  /** @type {string | undefined} */
  let sherpaFailure;

  /** @type {Map<string, unknown>} */
  const instances = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const pendingInstances = new Map();
  /** @type {string[]} */
  const instanceOrder = [];

  /** @type {Promise<Array<{name: string, locale: string, natural: boolean}>> | undefined} */
  let sayVoicesPromise;
  /** @type {Array<{name: string, locale: string, natural: boolean}> | undefined} */
  let sayVoicesCache;
  let sayVoicesAt = 0;
  /** @type {string | undefined} */
  let sayFailure;

  /** Serialised engine tail: one native generation or `say` process at a time. */
  let tail = Promise.resolve();
  let disposed = false;

  const warn = (message) => {
    try {
      logger?.warn?.(`voice-mode tts: ${message}`);
    } catch {
      /* logging must never fail a request */
    }
  };

  /** Keep status/error payloads free of absolute home paths. */
  const redact = (message) => {
    const text = message instanceof Error ? message.message : String(message ?? 'unknown error');
    const home = homedir();
    return home === '' ? text : text.split(home).join('~');
  };

  const enqueue = (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Load the native module at most once and remember why it failed. */
  const ensureSherpa = () => {
    if (sherpaModule !== undefined) return Promise.resolve(sherpaModule);
    if (sherpaPromise === undefined) {
      sherpaPromise = Promise.resolve()
        .then(() => loadSherpa())
        .then((loaded) => {
          sherpaModule = loaded;
          return loaded;
        })
        .catch((error) => {
          sherpaFailure = error?.message ?? String(error);
          sherpaPromise = undefined;
          throw error;
        });
    }
    return sherpaPromise;
  };

  const sayVoices = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (!refresh && sayVoicesCache !== undefined && now - sayVoicesAt < sayVoicesTtlMs) {
      return Promise.resolve(sayVoicesCache);
    }
    if (!refresh && sayVoicesPromise !== undefined) return sayVoicesPromise;
    sayVoicesPromise = probeSayVoices(execFileFn, sayCommand, sayProbeTimeoutMs)
      .then((voices) => {
        sayVoicesCache = voices;
        sayVoicesAt = Date.now();
        sayFailure = undefined;
        return voices;
      })
      .catch((error) => {
        sayFailure = error?.message ?? String(error);
        throw new VoiceEngineError('say-unavailable', `macOS say is not available: ${sayFailure}`, { cause: error });
      })
      .finally(() => {
        sayVoicesPromise = undefined;
      });
    return sayVoicesPromise;
  };

  /** Drop the least-recently-used Kokoro instance beyond the cache budget. */
  const evictInstances = () => {
    while (instanceOrder.length > maxCachedLangs) {
      const lang = instanceOrder.shift();
      if (lang === undefined) break;
      instances.delete(lang);
    }
  };

  /** Resolve one Kokoro instance for a language, loading it single-flight. */
  const instanceFor = (lang) => {
    const cached = instances.get(lang);
    if (cached !== undefined) {
      const index = instanceOrder.indexOf(lang);
      if (index >= 0) instanceOrder.splice(index, 1);
      instanceOrder.push(lang);
      return Promise.resolve(cached);
    }
    const pending = pendingInstances.get(lang);
    if (pending !== undefined) return pending;

    const loading = (async () => {
      if (modelPaths === null) {
        throw new VoiceEngineError(
          'model-missing',
          `Kokoro model is missing or incomplete: ${modelDir}`,
          { hint: 'Run node scripts/fetch-tts-model.mjs to download and extract it' },
        );
      }
      const sherpa = await ensureSherpa();
      const config = {
        model: {
          kokoro: {
            model: modelPaths.model,
            voices: modelPaths.voices,
            tokens: modelPaths.tokens,
            dataDir: modelPaths.dataDir,
            lexicon: modelPaths.lexicon,
            lang,
          },
          numThreads,
          provider: 'cpu',
          debug: 0,
        },
        maxNumSentences: 1,
      };
      const tts = await withTimeout(
        Promise.resolve().then(() => sherpa.OfflineTts.createAsync(config)),
        initTimeoutMs,
        `Kokoro model load exceeded ${initTimeoutMs} ms (lang=${lang})`,
      );
      if (tts === undefined || tts === null || typeof tts.generateAsync !== 'function') {
        throw new VoiceEngineError('engine-unavailable', 'sherpa-onnx OfflineTts is missing generateAsync');
      }
      instances.set(lang, tts);
      instanceOrder.push(lang);
      evictInstances();
      return tts;
    })();

    pendingInstances.set(lang, loading);
    return loading.finally(() => {
      pendingInstances.delete(lang);
    });
  };

  /** Kokoro path: one language instance, bounded asynchronous generation. */
  const synthesizeKokoro = async ({ text, sid, speed, script }) => {
    const lang = KOKORO_LANG_BY_SCRIPT[script] ?? KOKORO_LANG_BY_SCRIPT.latin;
    const tts = await instanceFor(lang);
    const audio = await withTimeout(
      Promise.resolve().then(() => tts.generateAsync({ text, sid, speed })),
      generateTimeoutMs,
      `Kokoro generation exceeded ${generateTimeoutMs} ms`,
    );
    const samples = toFloat32Samples(audio?.samples);
    if (samples.length === 0) throw new Error('Kokoro produced no audio for this text');
    const sampleRate = Number.isInteger(audio?.sampleRate) && audio.sampleRate > 0 ? audio.sampleRate : KOKORO_SAMPLE_RATE;
    return {
      samples,
      sampleRate,
      engine: 'kokoro',
      sid,
      voice: KOKORO_SIDS[sid] ?? null,
      lang,
    };
  };

  /** macOS `say` path: temp WAV (or AIFF + afconvert), parsed back to samples. */
  const synthesizeSay = async ({ text, speed, script }) => {
    const voices = await sayVoices();
    const voice = pickSayVoice(voices, script, voiceOverrides);
    if (voice === undefined) {
      throw new VoiceEngineError(
        'say-voice-missing',
        `macOS say has no ${SAY_LOCALE_BY_SCRIPT.get(script) ?? 'en_US'} voice installed`,
      );
    }
    const rate = String(Math.max(80, Math.min(500, Math.round(SAY_BASE_RATE * speed))));
    const workdir = await mkdtemp(join(tmpdir(), 'voice-mode-say-'));
    const wavPath = join(workdir, 'say.wav');
    try {
      let rendered = false;
      try {
        await execFileFn(
          sayCommand,
          ['-v', voice.name, '-r', rate, `--data-format=LEI16@${SAY_SAMPLE_RATE}`, '-o', wavPath, text],
          { timeout: sayTimeoutMs, maxBuffer: 1 << 20 },
        );
        rendered = true;
      } catch (error) {
        // Older voices can refuse the explicit data format: render AIFF and convert.
        warn(`say direct WAV render failed for ${voice.name}: ${error?.message ?? String(error)}`);
      }
      if (!rendered) {
        const aiffPath = join(workdir, 'say.aiff');
        await execFileFn(sayCommand, ['-v', voice.name, '-r', rate, '-o', aiffPath, text], {
          timeout: sayTimeoutMs,
          maxBuffer: 1 << 20,
        });
        await execFileFn(
          afconvertCommand,
          ['-f', 'WAVE', '-d', `LEI16@${SAY_SAMPLE_RATE}`, aiffPath, wavPath],
          { timeout: sayTimeoutMs, maxBuffer: 1 << 20 },
        );
      }
      const parsed = parseWav(await readFile(wavPath));
      if (parsed.samples.length === 0) throw new Error('say produced no audio for this text');
      return {
        samples: parsed.samples,
        sampleRate: parsed.sampleRate,
        engine: 'say',
        sid: null,
        voice: voice.name,
        lang: voice.locale,
      };
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /** Resolve the script family for an explicit language override or the text. */
  const resolveScript = (text, lang) => {
    if (typeof lang === 'string') {
      const script = SCRIPT_BY_LANG.get(lang);
      if (script !== undefined) return script;
    }
    return detectScript(text);
  };

  const synthesizeSerialized = async ({ text, sid, speed = 1, lang }) => {
    if (disposed) throw new VoiceEngineError('engine-unavailable', 'TTS engine is disposed');
    if (typeof text !== 'string' || text.trim() === '') {
      throw new VoiceEngineError('empty-text', 'text must be a non-empty string');
    }
    const script = resolveScript(text, lang);
    const resolvedSid = sid ?? DEFAULT_SID_BY_SCRIPT[script] ?? defaultSid;
    if (!Number.isInteger(resolvedSid) || resolvedSid < SID_MIN || resolvedSid > SID_MAX) {
      throw new VoiceEngineError('invalid-sid', `sid must be an integer between ${SID_MIN} and ${SID_MAX}`);
    }

    let kokoroError;
    if (script !== 'hangul') {
      try {
        return await synthesizeKokoro({ text, sid: resolvedSid, speed, script });
      } catch (error) {
        kokoroError = error;
        warn(`Kokoro unavailable for ${script} text, falling back to say: ${error?.message ?? String(error)}`);
      }
    }

    try {
      const result = await synthesizeSay({ text, speed, script });
      return kokoroError === undefined ? result : { ...result, fallbackReason: kokoroError.message };
    } catch (sayError) {
      const parts = [];
      if (kokoroError !== undefined) parts.push(`Kokoro: ${kokoroError.message}`);
      parts.push(`macOS say: ${sayError.message}`);
      throw new VoiceEngineError('tts-unavailable', `No local speech engine produced audio (${parts.join('; ')})`, {
        hint: 'Check the Kokoro model under ~/.dsh/voice-mode/tts and the macOS say voices',
        cause: sayError,
      });
    }
  };

  /** Cheap readiness report for `GET /voice-mode/status`. */
  const status = async () => {
    let native = null;
    let kokoroError;
    if (modelPaths !== null) {
      try {
        const sherpa = await ensureSherpa();
        native = {
          version: typeof sherpa?.version === 'string' ? sherpa.version : null,
          onnxruntimeVersion: typeof sherpa?.onnxruntimeVersion === 'string' ? sherpa.onnxruntimeVersion : null,
        };
      } catch (error) {
        kokoroError = redact(sherpaFailure ?? error?.message ?? String(error));
      }
    }

    let say = { available: false, count: 0, voices: {} };
    try {
      const voices = await sayVoices();
      say = {
        available: true,
        count: voices.length,
        voices: Object.fromEntries(
          ['latin', 'cjk', 'kana', 'hangul'].map((script) => [script, pickSayVoice(voices, script, voiceOverrides)?.name ?? null]),
        ),
      };
    } catch (error) {
      say = { available: false, count: 0, voices: {}, error: redact(error?.message ?? String(error)) };
    }

    const kokoroUsable = modelPaths !== null && native !== null;
    const engine = kokoroUsable ? 'kokoro' : say.available ? 'say' : 'none';
    return {
      ready: engine !== 'none',
      engine,
      sampleRate: engine === 'kokoro' ? KOKORO_SAMPLE_RATE : engine === 'say' ? SAY_SAMPLE_RATE : 0,
      modelDir,
      speakerCount: modelPaths === null ? 0 : KOKORO_SPEAKER_COUNT,
      defaultSid,
      sids: modelPaths === null ? [] : KOKORO_SIDS.map((name, sid) => ({ sid, name })),
      langs: ['en', 'zh', 'ja', 'ko'],
      kokoro: {
        available: kokoroUsable,
        modelPresent: modelPaths !== null,
        modelBytes: modelPaths?.modelBytes ?? 0,
        loadedLangs: [...instances.keys()],
        ...(native === null ? {} : { native }),
        ...(kokoroError === undefined ? {} : { error: kokoroError }),
      },
      say,
    };
  };

  const engine = {
    modelDir,
    status,
    synthesize: (input) => enqueue(() => synthesizeSerialized(input ?? {})),
    dispose: () => {
      disposed = true;
      instances.clear();
      instanceOrder.length = 0;
      pendingInstances.clear();
      sayVoicesCache = undefined;
    },
  };
  return engine;
}
