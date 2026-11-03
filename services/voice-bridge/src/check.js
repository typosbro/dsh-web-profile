/**
 * `node src/main.js --check`: validates everything that can be validated
 * without a working bot token / Discord login.
 *
 * Static checks fail the command; local-service probes are reported as
 * warnings because someone may run the bridge while whisper or Kokoro is
 * starting up.
 */
import net from 'node:net';
import { loadBotToken, loadConfig, validateTokenShape } from './config.js';
import { runCommand } from './exec.js';

export async function runCheck({ configPath, fetchImpl = fetch, run = runCommand, checkPort = true } = {}) {
  const results = [];
  const add = (name, ok, detail, { hard = true } = {}) => {
    results.push({ name, ok, detail, hard });
  };

  let config;
  try {
    config = await loadConfig({ filePath: configPath });
    add('config file', true, `${config.configPath} (instance "${config.instanceName}")`);
  } catch (error) {
    add('config file', false, error.message);
    return { ok: false, results };
  }

  add('config: guild/channel/operator', true,
    `guild ${config.guildId}, channel ${config.voiceChannelId}, operator ${config.operatorUserId}`);
  add('config: STT language', true, `${config.stt.language} (explicit, never auto)`);
  add('config: TTS engine', true,
    `${config.tts.engine}${config.tts.engine === 'kokoro' ? ' (English only)' : ' (en -> kokoro, ko -> say)'}`);
  add('config: capture mode', true, `${config.capture.mode}${config.capture.mode === 'vad' ? ' (hands-free)' : ' (debug push-to-talk)'}`);

  try {
    const token = await loadBotToken({ config });
    const shape = validateTokenShape(token);
    add('bot token file', shape.ok, `${config.tokenFile} (${token.length} chars, not printed)`);
  } catch (error) {
    add('bot token file', false, error.message);
  }

  try {
    await run(config.ffmpegPath, ['-version'], { timeoutMs: 10000 });
    add('ffmpeg', true, config.ffmpegPath);
  } catch (error) {
    add('ffmpeg', false, `not runnable: ${error.message}`);
  }

  if (config.tts.engine === 'auto') {
    try {
      const { stdout } = await run(config.tts.sayCommand, ['-v', '?'], { timeoutMs: 10000 });
      const found = stdout.toString('utf8').includes(`${config.tts.sayVoice} (`);
      add('macOS say voice', found, `${config.tts.sayVoice}${found ? '' : ' not installed'}`);
    } catch (error) {
      add('macOS say voice', false, `say not runnable: ${error.message}`);
    }
  }

  const sttBase = config.stt.url.replace(/\/v1\/audio\/transcriptions\/?$/, '');
  const serviceChecks = [
    {
      name: 'whisper server',
      url: sttBase,
      detail: config.stt.url,
    },
    {
      name: 'Kokoro server',
      url: config.tts.kokoroUrl.replace(/\/audio\/speech\/?$/, '/audio/voices'),
      detail: config.tts.kokoroUrl,
    },
  ];
  for (const check of serviceChecks) {
    try {
      const response = await fetchImpl(check.url, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      add(check.name, true, `${check.detail} (HTTP ${response.status})`, { hard: false });
    } catch (error) {
      add(check.name, false, `${check.detail} unreachable: ${error.message}`, { hard: false });
    }
  }

  if (checkPort) {
    const portFree = await isPortFree(config.controlPort);
    add('control port', portFree, `${config.controlHost}:${config.controlPort}${portFree ? '' : ' already in use'}`);
  }

  return { ok: results.every((entry) => entry.ok || !entry.hard), results };
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export function formatCheckResults(results) {
  const lines = results.map((entry) => {
    const mark = entry.ok ? 'ok  ' : entry.hard ? 'FAIL' : 'warn';
    return `[${mark}] ${entry.name}: ${entry.detail}`;
  });
  const failed = results.filter((entry) => !entry.ok && entry.hard).length;
  const warnings = results.filter((entry) => !entry.ok && !entry.hard).length;
  lines.push('');
  lines.push(
    failed === 0
      ? `config check passed${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`
      : `${failed} check(s) failed`,
  );
  return lines.join('\n');
}
