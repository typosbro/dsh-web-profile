#!/usr/bin/env node
/**
 * dsh-voice-bridge daemon entry point.
 *
 * One process = one Discord bot identity. Start a second instance with a
 * second config/token to add another agent to the same voice channel.
 *
 *   node src/main.js [--config <path>] [--check]
 *
 * Scope: join / receive / transcribe / speak. Agent and /discuss integration
 * is a later phase and is deliberately absent here.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { isSpeechFrame } from './audio.js';
import { PttCapture } from './capture.js';
import { formatCheckResults, runCheck } from './check.js';
import {
  DEFAULT_CONFIG_PATH,
  ConfigError,
  loadBotToken,
  loadConfig,
  publicConfigSummary,
} from './config.js';
import { createControlServer } from './control.js';
import { createLogger } from './logger.js';
import { transcribePcm } from './stt.js';
import { createTransport } from './transport.js';
import { synthesize } from './tts.js';
import { EnergyVad } from './vad.js';
import { pcmDurationMs } from './wav.js';

const MIN_UTTERANCE_MS = 150;

/** Local DSH route that prompts a dedicated voice session and returns its answer. */
const AGENT_URL = process.env.VOICE_BRIDGE_AGENT_URL ?? 'http://127.0.0.1:3080/voice-mode/turn';
/** One agent turn may involve tools; bound the wait. */
const AGENT_TIMEOUT_MS = 200_000;
/** Longest spoken answer; voice replies should stay short. */
const REPLY_MAX_CHARS = 900;

export function parseArgs(argv) {
  const args = { configPath: DEFAULT_CONFIG_PATH, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1];
      if (!value) throw new ConfigError('--config needs a file path');
      args.configPath = value;
      index += 1;
    } else if (arg.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length);
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new ConfigError(`unknown argument: ${arg} (try --help)`);
    }
  }
  return args;
}

const USAGE = `dsh-voice-bridge — Discord voice sidecar (English only MVP)

Usage:
  node src/main.js [--config <path>]   run the bridge
  node src/main.js --check             validate config, token file, ffmpeg, local services
  node src/main.js --help              show this text

Default config: ~/.config/dsh-superagent/voice-bridge.json (mode 600)
Control API (loopback):  GET /state, POST /join /leave /listen/start /listen/stop /say
`;

/**
 * Wire the whole bridge and return the handles. Exported so a future
 * supervisor (or an integration test) can start the bridge without signal
 * handlers.
 */
export async function startBridge({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  const config = await loadConfig({ filePath: configPath });
  // The token is read once, handed to discord.js, and added to the logger's
  // redaction list. It is never logged, stored in state, or returned.
  const token = await loadBotToken({ config });
  const logger = createLogger({ name: config.instanceName, secrets: [token], level: process.env.VOICE_BRIDGE_LOG_LEVEL ?? 'info' });

  logger.info(`starting ${config.instanceName} (config: ${config.configPath})`);
  logger.info(
    `mode: capture=${config.capture.mode}, stt=${config.stt.language}, tts=${config.tts.engine}`,
  );

  const startedAt = new Date().toISOString();
  const state = {
    startedAt,
    armed: config.capture.autoStart,
    processing: false,
    dropping: 0,
    lastTranscript: null,
    lastReply: null,
    lastTts: null,
    stt: { calls: 0, failures: 0, lastMs: null },
    tts: { calls: 0, failures: 0, lastMs: null },
  };

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  client.on('error', (error) => logger.error(`discord client error: ${error.message}`));

  const transport = createTransport({ client, config, logger });
  const ptt = new PttCapture({
    maxSeconds: Math.max(5, Math.ceil(config.capture.vad.maxUtteranceMs / 1000)),
  });
  const vad = new EnergyVad(config.capture.vad, {
    onUtterance: (utterance) => {
      void processUtterance(utterance, 'vad');
    },
  });

  function captureInput(pcm) {
    if (config.capture.mode === 'vad') vad.push(pcm);
    else ptt.push(pcm);
  }

  transport.onOperatorPcm((pcm) => {
    if (!state.armed) return;
    // Barge-in: operator speech stops whatever we are saying.
    if (transport.getState().playing && isSpeechFrame(pcm, config.capture.vad.thresholdDbfs)) {
      transport.stopPlaying();
      logger.info('barge-in: operator speech interrupted TTS');
    }
    captureInput(pcm);
  });

  async function processUtterance(utterance, source) {
    if (!utterance || !Buffer.isBuffer(utterance.pcm) || utterance.pcm.length === 0) return null;
    const durationMs = pcmDurationMs(utterance.pcm.length);
    if (durationMs < MIN_UTTERANCE_MS) {
      logger.debug(`dropping ${source} utterance (${durationMs.toFixed(0)} ms is too short)`);
      return null;
    }
    if (state.processing) {
      state.dropping += 1;
      logger.warn(`dropping ${source} utterance: still transcribing the previous one`);
      return null;
    }
    state.processing = true;
    const queuedAt = Date.now();
    try {
      logger.info(`utterance (${source}): ${durationMs.toFixed(0)} ms`);
      const { text } = await transcribePcm({ pcm: utterance.pcm, config });
      const elapsed = Date.now() - queuedAt;
      state.stt.calls += 1;
      state.stt.lastMs = elapsed;
      state.lastTranscript = {
        text,
        language: config.stt.language,
        at: new Date().toISOString(),
        ms: elapsed,
        source,
      };
      logger.info(`transcript (${config.stt.language}, ${elapsed} ms): "${text}"`);
      if (typeof text === 'string' && text.trim() !== '') {
        void respond(text);
      }
      return text;
    } catch (error) {
      state.stt.failures += 1;
      logger.error(`transcription failed: ${error.message}`);
      return null;
    } finally {
      state.processing = false;
    }
  }

  /** Ask the local DSH agent for one answer to a spoken transcript. */
  async function askAgent(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
    try {
      const response = await fetch(AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`agent HTTP ${response.status}`);
      const payload = await response.json();
      return typeof payload.text === 'string' ? payload.text.trim() : '';
    } finally {
      clearTimeout(timer);
    }
  }

  /** Split an answer into speakable chunks bounded by length. */
  function splitReply(text) {
    const clipped = text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS)}…` : text;
    const sentences = clipped.match(/[^.!?\n]+[.!?]*\s*/g) ?? [clipped];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      if (current.length + sentence.length > 260 && current !== '') {
        chunks.push(current.trim());
        current = '';
      }
      current += sentence;
    }
    if (current.trim() !== '') chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [clipped];
  }

  /** Synthesize and play one line, updating counters and state. */
  async function speakNow(text) {
    if (!transport.getState().connected) {
      throw new Error('not connected to a voice channel; call POST /join first');
    }
    const queuedAt = Date.now();
    const result = await synthesize(text, { config });
    const elapsed = Date.now() - queuedAt;
    transport.play(result.pcm);
    state.tts.calls += 1;
    state.tts.lastMs = elapsed;
    state.lastTts = {
      text,
      engine: result.engine,
      language: result.language,
      at: new Date().toISOString(),
      ms: elapsed,
    };
    logger.info(
      `TTS (${result.engine}/${result.language}, ${elapsed} ms, ` +
        `${pcmDurationMs(result.pcm.length).toFixed(0)} ms audio): "${text.slice(0, 200)}"`,
    );
    return {
      engine: result.engine,
      language: result.language,
      synthMs: elapsed,
      audioMs: Math.round(pcmDurationMs(result.pcm.length)),
    };
  }

  /** Reply to one operator transcript: ask the local agent, then speak it. */
  async function respond(transcript) {
    try {
      const queuedAt = Date.now();
      const reply = await askAgent(transcript);
      if (reply === '') {
        logger.warn('agent returned an empty reply');
        return;
      }
      state.lastReply = { text: reply, at: new Date().toISOString(), ms: Date.now() - queuedAt };
      logger.info(`agent reply (${reply.length} chars, ${Date.now() - queuedAt} ms): "${reply.slice(0, 160)}"`);
      // Synthesize every part first, then play one buffer: playing part by part
      // would cut the previous part (play() stops whatever is playing).
      const parts = splitReply(reply);
      const buffers = [];
      for (const part of parts) {
        const synthesized = await synthesize(part, { config });
        buffers.push(synthesized.pcm);
      }
      const pcm = Buffer.concat(buffers);
      transport.play(pcm);
      state.tts.calls += parts.length;
      state.lastTts = { text: reply, engine: 'kokoro', language: config.tts.language ?? 'en', at: new Date().toISOString(), ms: Date.now() - queuedAt };
      logger.info(`spoke reply: ${parts.length} part(s), ${pcmDurationMs(pcm.length).toFixed(0)} ms audio`);
    } catch (error) {
      logger.error(`agent reply failed: ${error.message}`);
    }
  }

  const actions = {
    state: () => ({
      instanceName: config.instanceName,
      startedAt: state.startedAt,
      transport: transport.getState(),
      capture: {
        mode: config.capture.mode,
        armed: state.armed,
        autoStart: config.capture.autoStart,
        vad: config.capture.vad,
      },
      processing: state.processing,
      dropping: state.dropping,
      lastTranscript: state.lastTranscript,
      lastReply: state.lastReply,
      lastTts: state.lastTts,
      stt: `POST ${config.stt.url} language=${config.stt.language}`,
      tts: {
        engine: config.tts.engine,
        kokoroVoice: config.tts.kokoroVoice,
        kokoroUrl: config.tts.kokoroUrl,
      },
      counters: { stt: state.stt, tts: state.tts },
      config: publicConfigSummary(config),
    }),

    join: async () => {
      const result = await transport.join();
      return { transport: result };
    },

    leave: async () => {
      state.armed = false;
      vad.reset();
      ptt.reset();
      const result = await transport.leave();
      return { transport: result };
    },

    listenStart: () => {
      if (config.capture.mode === 'ptt') ptt.start();
      else vad.reset();
      state.armed = true;
      logger.info(`capture armed (${config.capture.mode})`);
      return { armed: true, mode: config.capture.mode };
    },

    listenStop: async () => {
      state.armed = false;
      if (config.capture.mode === 'ptt') {
        const utterance = ptt.stop();
        logger.info('capture disarmed (ptt)');
        const text = utterance ? await processUtterance(utterance, 'ptt') : null;
        return { armed: false, mode: 'ptt', capturedMs: utterance?.durationMs ?? 0, transcript: text };
      }
      vad.flush();
      logger.info('capture disarmed (vad)');
      return { armed: false, mode: 'vad' };
    },

    say: (text) => speakNow(text),
  };

  const control = createControlServer({
    port: config.controlPort,
    host: config.controlHost,
    actions,
    logger,
  });

  let shuttingDown = false;
  async function shutdown(reason = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${reason}: leaving voice channel and stopping`);
    try {
      state.armed = false;
      await control.stop();
      await transport.leave();
    } catch (error) {
      logger.warn(`shutdown cleanup failed: ${error.message}`);
    } finally {
      client.destroy();
      logger.info('stopped');
    }
  }

  // discord.js resolves login() once the gateway READY packet is handled, so
  // guild/channel caches and the voice adapter are usable afterwards.
  logger.info(`logging in (token read from ${config.tokenFile}; value never logged)`);
  try {
    await client.login(token);
    logger.info(`logged in as ${client.user?.tag ?? 'unknown user'}`);

    await control.start();
    const boundPort = control.address?.port ?? config.controlPort;
    logger.info(`control API: http://${config.controlHost}:${boundPort} (instance ${config.instanceName})`);
  } catch (error) {
    // Never leave a logged-in zombie process behind when startup fails
    // (e.g. control port already in use).
    try {
      await control.stop();
    } catch {
      /* ignore */
    }
    client.destroy();
    throw error;
  }

  try {
    await transport.join();
  } catch (error) {
    logger.error(`initial voice join failed: ${error.message} (fix config/channel; retry with POST /join)`);
  }

  return { config, client, transport, control, state, logger, shutdown, processUtterance };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.check) {
    const { ok, results } = await runCheck({ configPath: args.configPath });
    console.log(formatCheckResults(results));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  let bridge;
  try {
    bridge = await startBridge({ configPath: args.configPath });
  } catch (error) {
    // ConfigError messages never contain the token value.
    console.error(error instanceof ConfigError ? `config error: ${error.message}` : `fatal: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const onSignal = (signal) => {
    void bridge.shutdown(`received ${signal}`).then(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    bridge.logger.error(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    bridge.logger.error(`uncaught exception: ${error.message}`);
    void bridge.shutdown('uncaught exception').then(() => process.exit(1));
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
