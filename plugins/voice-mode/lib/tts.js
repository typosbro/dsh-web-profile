/**
 * voice-mode — local text-to-speech, one version only.
 *
 * There is exactly one Kokoro engine: the loopback `kokoro-fastapi` service the
 * VoiceMode MCP setup installs (fp32 Kokoro v1.0 on Apple MPS at
 * `127.0.0.1:8880`, default voice `af_sky`). The plugin no longer ships or loads
 * its own quantised model — no second copy on disk, no second engine in memory.
 *
 * The only fallback is macOS `say`, which is part of the operating system and
 * is used for Hangul text (Kokoro has no Korean voice) and when the local
 * service is not running.
 *
 * Everything here is local: the Kokoro endpoint is loopback-only
 * (see `kokoro-http.js`), and `say` never leaves the machine.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createKokoroHttpProvider } from './kokoro-http.js';
import { detectScript } from './validate.js';
import { parseWav } from './wav.js';

const execFile = promisify(execFileCallback);

/** Sample rate macOS `say` is rendered at, so both engines agree. */
export const SAY_SAMPLE_RATE = 24_000;

/** macOS `say` speaking rate, words per minute, at speed 1.0. */
const SAY_BASE_RATE = 175;

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

/** A local TTS failure with a stable code for the HTTP layer to map. */
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
 * List voices installed for the macOS `say` command.
 *
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
 *
 * @param {Array<{name: string, locale: string, natural: boolean}>} voices - installed voices.
 * @param {string} script - detected script family.
 * @param {Map<string, string>} [overrides] - script -> voice-name override.
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
 *
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
 *
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
 * Build the local TTS engine singleton.
 *
 * `status()` is cheap (a cached loopback probe plus a cached `say` probe);
 * `synthesize()` is serialised so two sentences never fight over the service.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   kokoroHttp?: object,
 *   sayTimeoutMs?: number,
 *   sayProbeTimeoutMs?: number,
 *   sayVoicesTtlMs?: number,
 *   sayCommand?: string,
 *   afconvertCommand?: string,
 *   execFile?: typeof execFile,
 *   logger?: { warn?: (message: string) => void },
 * }} [options] - optional endpoints, limits, and test injection points.
 * @returns {{
 *   status: () => Promise<object>,
 *   synthesize: (input: {text: string, speed?: number, lang?: string}) => Promise<object>,
 *   dispose: () => void,
 * }} the engine.
 */
export function createTtsEngine(options = {}) {
  const env = options.env ?? process.env;
  const sayTimeoutMs = options.sayTimeoutMs ?? 45_000;
  const sayProbeTimeoutMs = options.sayProbeTimeoutMs ?? 5_000;
  const sayVoicesTtlMs = options.sayVoicesTtlMs ?? 300_000;
  const sayCommand = options.sayCommand ?? '/usr/bin/say';
  const afconvertCommand = options.afconvertCommand ?? '/usr/bin/afconvert';
  const execFileFn = options.execFile ?? execFile;
  const logger = options.logger;
  const voiceOverrides = sayVoiceOverrides(env);

  const httpKokoro = createKokoroHttpProvider({
    env,
    ...(options.kokoroHttp === undefined ? {} : options.kokoroHttp),
  });

  let sayVoicesPromise;
  let sayVoicesCache;
  let sayVoicesAt = 0;
  let disposed = false;
  let tail = Promise.resolve();

  const warn = (message) => {
    try {
      logger?.warn?.(`voice-mode tts: ${message}`);
    } catch {
      /* logging must never fail a request */
    }
  };

  /** Serialise synthesis so the loopback service is never asked twice at once. */
  const enqueue = (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const sayVoices = async () => {
    const now = Date.now();
    if (sayVoicesCache !== undefined && now - sayVoicesAt < sayVoicesTtlMs) return sayVoicesCache;
    if (sayVoicesPromise !== undefined) return sayVoicesPromise;
    sayVoicesPromise = probeSayVoices(execFileFn, sayCommand, sayProbeTimeoutMs)
      .then((voices) => {
        sayVoicesCache = voices;
        sayVoicesAt = Date.now();
        return voices;
      })
      .catch((error) => {
        throw new VoiceEngineError('say-unavailable', `macOS say is not available: ${error?.message ?? String(error)}`, {
          cause: error,
        });
      })
      .finally(() => {
        sayVoicesPromise = undefined;
      });
    return sayVoicesPromise;
  };

  /** macOS `say` path: render to WAV, parse it back into samples. */
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
        warn(`say direct WAV render failed for ${voice.name}: ${error?.message ?? String(error)}`);
      }
      if (!rendered) {
        const aiffPath = join(workdir, 'say.aiff');
        await execFileFn(sayCommand, ['-v', voice.name, '-r', rate, '-o', aiffPath, text], {
          timeout: sayTimeoutMs,
          maxBuffer: 1 << 20,
        });
        await execFileFn(afconvertCommand, ['-f', 'WAVE', '-d', `LEI16@${SAY_SAMPLE_RATE}`, aiffPath, wavPath], {
          timeout: sayTimeoutMs,
          maxBuffer: 1 << 20,
        });
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

  const synthesizeSerialized = async ({ text, speed = 1, lang }) => {
    if (disposed) throw new VoiceEngineError('engine-unavailable', 'TTS engine is disposed');
    if (typeof text !== 'string' || text.trim() === '') {
      throw new VoiceEngineError('empty-text', 'text must be a non-empty string');
    }
    const script = resolveScript(text, lang);
    if (script !== 'hangul') {
      // The single Kokoro engine: the local fp32 service on loopback.
      try {
        return await withTimeout(
          httpKokoro.synthesize({ text, speed, script }),
          sayTimeoutMs,
          'Kokoro service did not answer in time',
        );
      } catch (error) {
        warn(`local Kokoro service unavailable, falling back to say: ${error?.message ?? String(error)}`);
      }
    }
    try {
      return await synthesizeSay({ text, speed, script });
    } catch (sayError) {
      throw new VoiceEngineError('tts-unavailable', `No local speech engine produced audio (${sayError.message})`, {
        hint: 'Start the local Kokoro service (VoiceMode kokoro-fastapi on 127.0.0.1:8880) or check the macOS say voices',
        cause: sayError,
      });
    }
  };

  /** Cheap readiness report for `GET /voice-mode/status`. */
  const status = async () => {
    const http = await httpKokoro.status();
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
      say = { available: false, count: 0, voices: {}, error: String(error?.message ?? error) };
    }
    const engine = http.available === true ? 'kokoro-http' : say.available ? 'say' : 'none';
    return {
      ready: engine !== 'none',
      engine,
      sampleRate: engine === 'none' ? 0 : SAY_SAMPLE_RATE,
      http,
      say,
      policy: {
        singleService: true,
        int8KokoroEnabled: false,
        note: 'One Kokoro version only: the loopback kokoro-fastapi service (fp32). macOS say is the only fallback.',
      },
      langs: ['en', 'zh', 'ja', 'ko'],
    };
  };

  return {
    status,
    synthesize: (input) => enqueue(() => synthesizeSerialized(input ?? {})),
    dispose: () => {
      disposed = true;
      sayVoicesCache = undefined;
    },
  };
}
