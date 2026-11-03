/**
 * Config loading and validation.
 *
 * The live config lives at ~/.config/dsh-superagent/voice-bridge.json with
 * mode 600. The bot token is NOT part of the config: `tokenFile` points at a
 * separate file (mode 600) whose content is the token. Nothing here ever
 * records or logs the token value.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(
  homedir(),
  '.config',
  'dsh-superagent',
  'voice-bridge.json',
);

export const DEFAULT_CONTROL_PORT = 3090;

const SNOWFLAKE = /^\d{15,25}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandHome(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath;
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return path.join(homedir(), filePath.slice(2));
  return filePath;
}

/**
 * Load, parse and validate the config file. Returns a fully defaulted config
 * object. `readFile` is injectable for tests.
 */
export async function loadConfig({
  filePath = DEFAULT_CONFIG_PATH,
  readFileImpl = readFile,
} = {}) {
  const resolvedPath = expandHome(filePath);
  let raw;
  try {
    raw = await readFileImpl(resolvedPath, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `cannot read config file ${resolvedPath} (${error.code ?? error.message}). ` +
        'Copy config/voice-bridge.example.json there and chmod 600 it.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`config file ${resolvedPath} is not valid JSON: ${error.message}`);
  }

  return normalizeConfig(parsed, { filePath: resolvedPath });
}

/** Validate and fill defaults for an already-parsed config object. */
export function normalizeConfig(input, { filePath = DEFAULT_CONFIG_PATH } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`config file ${filePath} must contain a JSON object`);
  }
  const where = (key) => `config: ${key}`;

  const requireString = (value, key, { pattern = null, description = null } = {}) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ConfigError(`${where(key)} must be a non-empty string${description ? ` (${description})` : ''}`);
    }
    const trimmed = value.trim();
    if (pattern && !pattern.test(trimmed)) {
      throw new ConfigError(`${where(key)} has an unexpected format: ${JSON.stringify(trimmed)}`);
    }
    return trimmed;
  };

  const optionalString = (value, key, fallback, options = {}) => {
    if (value === undefined || value === null) return fallback;
    return requireString(value, key, options);
  };

  const optionalSnowflake = (value, key, fallback = null) => {
    if (value === undefined || value === null) return fallback;
    return requireString(value, key, { pattern: SNOWFLAKE, description: 'Discord snowflake id' });
  };

  const optionalUrl = (value, key, fallback) => {
    if (value === undefined || value === null) {
      if (fallback === undefined) throw new ConfigError(`${where(key)} is required`);
      return fallback;
    }
    const url = requireString(value, key);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('must be http(s)');
      }
    } catch (error) {
      throw new ConfigError(`${where(key)} must be an http(s) URL: ${error.message}`);
    }
    return url;
  };

  const snowflakeArray = (value, key) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ConfigError(`${where(key)} must be an array of user ids`);
    return value.map((entry, index) => {
      if (typeof entry !== 'string' || !SNOWFLAKE.test(entry.trim())) {
        throw new ConfigError(`${where(key)}[${index}] must be a Discord user id (digits)`);
      }
      return entry.trim();
    });
  };

  const intInRange = (value, key, fallback, { min, max }) => {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`${where(key)} must be an integer between ${min} and ${max}`);
    }
    return value;
  };

  const bool = (value, key, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new ConfigError(`${where(key)} must be a boolean`);
    return value;
  };

  const tokenFile = expandHome(
    requireString(input.tokenFile, 'tokenFile', { description: 'path to a file holding the bot token' }),
  );

  const sttInput = input.stt ?? {};
  if (typeof sttInput !== 'object' || Array.isArray(sttInput)) {
    throw new ConfigError(`${where('stt')} must be an object`);
  }
  const language = optionalString(sttInput.language, 'stt.language', 'en', {
    pattern: LANGUAGE,
    description: 'ISO 639 language code, e.g. en',
  });

  const ttsInput = input.tts ?? {};
  if (typeof ttsInput !== 'object' || Array.isArray(ttsInput)) {
    throw new ConfigError(`${where('tts')} must be an object`);
  }
  const ttsEngine = optionalString(ttsInput.engine, 'tts.engine', 'kokoro');
  if (ttsEngine !== 'kokoro' && ttsEngine !== 'auto') {
    throw new ConfigError(`${where('tts.engine')} must be "kokoro" or "auto" ("auto" allows Korean via say)`);
  }

  const captureInput = input.capture ?? {};
  if (typeof captureInput !== 'object' || Array.isArray(captureInput)) {
    throw new ConfigError(`${where('capture')} must be an object`);
  }
  const captureMode = optionalString(captureInput.mode, 'capture.mode', 'vad');
  if (captureMode !== 'vad' && captureMode !== 'ptt') {
    throw new ConfigError(`${where('capture.mode')} must be "vad" (default) or "ptt" (debug)`);
  }
  const vadInput = captureInput.vad ?? {};
  if (typeof vadInput !== 'object' || Array.isArray(vadInput)) {
    throw new ConfigError(`${where('capture.vad')} must be an object`);
  }

  const operatorUserId = requireString(input.operatorUserId, 'operatorUserId', {
    pattern: SNOWFLAKE,
    description: 'Discord user id of the operator',
  });
  const ignoreUserIds = snowflakeArray(input.ignoreUserIds, 'ignoreUserIds');
  const ignoreBotIds = snowflakeArray(input.ignoreBotIds, 'ignoreBotIds');
  if (ignoreUserIds.includes(operatorUserId) || ignoreBotIds.includes(operatorUserId)) {
    throw new ConfigError('config: operatorUserId must not be listed in ignoreUserIds/ignoreBotIds');
  }

  const ffmpegPath = optionalString(input.ffmpegPath, 'ffmpegPath', 'ffmpeg');

  const config = {
    configPath: filePath,
    instanceName: optionalString(input.instanceName, 'instanceName', 'voice-bridge'),
    tokenFile,
    guildId: requireString(input.guildId, 'guildId', {
      pattern: SNOWFLAKE,
      description: 'Discord guild id',
    }),
    voiceChannelId: requireString(input.voiceChannelId, 'voiceChannelId', {
      pattern: SNOWFLAKE,
      description: 'Discord voice channel id',
    }),
    operatorUserId,
    ignoreUserIds,
    ignoreBotIds,
    replyTextChannelId: optionalSnowflake(input.replyTextChannelId, 'replyTextChannelId', null),
    controlPort: intInRange(input.controlPort, 'controlPort', DEFAULT_CONTROL_PORT, {
      min: 1024,
      max: 65535,
    }),
    controlHost: '127.0.0.1',
    selfMute: bool(input.selfMute, 'selfMute', false),
    ffmpegPath,
    stt: {
      url: optionalUrl(sttInput.url, 'stt.url', 'http://127.0.0.1:2022/v1/audio/transcriptions'),
      // Explicit language is mandatory: whisper auto-detect mis-transcribes
      // Korean as English and adds a decoder pass. English-only MVP.
      language,
      model: optionalString(sttInput.model, 'stt.model', 'whisper-1'),
      timeoutMs: intInRange(sttInput.timeoutMs, 'stt.timeoutMs', 30000, { min: 1000, max: 300000 }),
    },
    tts: {
      engine: ttsEngine,
      kokoroUrl: optionalUrl(ttsInput.kokoroUrl, 'tts.kokoroUrl', 'http://127.0.0.1:8880/v1/audio/speech'),
      kokoroVoice: optionalString(ttsInput.kokoroVoice, 'tts.kokoroVoice', 'af_heart'),
      kokoroModel: optionalString(ttsInput.kokoroModel, 'tts.kokoroModel', 'kokoro'),
      // Optional Korean fallback behind tts.engine = "auto". Not used by the
      // English-only MVP, kept because it costs nothing.
      sayVoice: optionalString(ttsInput.sayVoice, 'tts.sayVoice', 'Yuna'),
      sayCommand: optionalString(ttsInput.sayCommand, 'tts.sayCommand', 'say'),
      timeoutMs: intInRange(ttsInput.timeoutMs, 'tts.timeoutMs', 60000, { min: 1000, max: 300000 }),
    },
    capture: {
      mode: captureMode,
      autoStart: bool(captureInput.autoStart, 'capture.autoStart', true),
      vad: {
        thresholdDbfs: numberInRange(vadInput.thresholdDbfs, 'capture.vad.thresholdDbfs', -35, -90, 0),
        minSpeechMs: intInRange(vadInput.minSpeechMs, 'capture.vad.minSpeechMs', 200, { min: 20, max: 5000 }),
        silenceMs: intInRange(vadInput.silenceMs, 'capture.vad.silenceMs', 600, { min: 100, max: 10000 }),
        preRollMs: intInRange(vadInput.preRollMs, 'capture.vad.preRollMs', 300, { min: 0, max: 2000 }),
        minUtteranceMs: intInRange(vadInput.minUtteranceMs, 'capture.vad.minUtteranceMs', 300, {
          min: 20,
          max: 60000,
        }),
        maxUtteranceMs: intInRange(vadInput.maxUtteranceMs, 'capture.vad.maxUtteranceMs', 15000, {
          min: 1000,
          max: 120000,
        }),
      },
    },
  };

  if (config.capture.vad.minSpeechMs > config.capture.vad.maxUtteranceMs) {
    throw new ConfigError('config: capture.vad.minSpeechMs must not exceed maxUtteranceMs');
  }
  if (config.capture.vad.minUtteranceMs > config.capture.vad.maxUtteranceMs) {
    throw new ConfigError('config: capture.vad.minUtteranceMs must not exceed maxUtteranceMs');
  }

  return config;
}

function numberInRange(value, key, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    throw new ConfigError(`config: ${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Read the bot token from `tokenFile`. The token is returned to the caller
 * only; it is never logged or included in /state output.
 */
export async function loadBotToken({ config, readFileImpl = readFile } = {}) {
  if (!config?.tokenFile) throw new ConfigError('config: tokenFile is not set');
  let raw;
  try {
    raw = await readFileImpl(config.tokenFile, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `cannot read bot token file ${config.tokenFile} (${error.code ?? error.message})`,
    );
  }
  const token = raw.trim();
  const validation = validateTokenShape(token);
  if (!validation.ok) {
    throw new ConfigError(`bot token file ${config.tokenFile}: ${validation.reason}`);
  }
  return token;
}

/**
 * Shape check only (never prints the value). Discord bot tokens are three
 * dot-separated base64url parts, ~70-75 characters in total.
 */
export function validateTokenShape(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'token file is empty' };
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: 'token contains whitespace (write it on a single line)' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: `token has ${parts.length} dot-separated part(s); a bot token has 3, and this one is ${token.length} chars`,
    };
  }
  if (token.length < 50) {
    return {
      ok: false,
      reason: `token is only ${token.length} chars; a bot token is ~70-75 chars (was it truncated?)`,
    };
  }
  return { ok: true, reason: null };
}

/** Config subset safe to expose through GET /state (never includes the token). */
export function publicConfigSummary(config) {
  return {
    instanceName: config.instanceName,
    guildId: config.guildId,
    voiceChannelId: config.voiceChannelId,
    operatorUserId: config.operatorUserId,
    ignoreUserIds: [...config.ignoreUserIds],
    ignoreBotIds: [...config.ignoreBotIds],
    replyTextChannelId: config.replyTextChannelId,
    controlPort: config.controlPort,
    captureMode: config.capture.mode,
    sttLanguage: config.stt.language,
    ttsEngine: config.tts.engine,
    tokenFile: config.tokenFile,
  };
}
