/**
 * Text-to-speech.
 *
 * Default engine: Kokoro on 127.0.0.1:8880, which is English only. Optional
 * fallback for Korean (tts.engine = "auto"): macOS `say` voice Yuna.
 *
 * Both paths return 48 kHz stereo s16le PCM, which is exactly what the
 * Discord voice player wants, so playback never needs another conversion.
 * ffmpeg (already required by the local stack) does the resampling.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeFileToPcm48Stereo, decodeToPcm48Stereo } from './audio.js';
import { runCommand as defaultRunCommand } from './exec.js';
import { pickTtsEngine } from './lang.js';

export class TtsError extends Error {
  constructor(message, { cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'TtsError';
  }
}

/**
 * Synthesize one utterance to 48 kHz stereo PCM.
 *
 * @param {string} text
 * @param {object} options
 * @param {object} options.config   full config (uses config.tts / ffmpegPath)
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.runCommand]  injected child-process runner
 * @param {Function} [options.makeTempDir] injected temp-dir factory
 */
export async function synthesize(
  text,
  {
    config,
    fetchImpl = fetch,
    runCommand = defaultRunCommand,
    makeTempDir = () => mkdtemp(path.join(tmpdir(), 'dsh-voice-')),
  } = {},
) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (clean.length === 0) throw new TtsError('cannot synthesize empty text');

  const route = pickTtsEngine(clean, config.tts);
  if (route.engine === 'say') {
    const pcm = await synthesizeWithSay(clean, {
      config,
      route,
      runCommand,
      makeTempDir,
    });
    return { ...route, pcm, sampleRate: 48000, channels: 2 };
  }

  const pcm = await synthesizeWithKokoro(clean, {
    config,
    route,
    fetchImpl,
    runCommand,
  });
  return { ...route, pcm, sampleRate: 48000, channels: 2 };
}

async function synthesizeWithKokoro(text, { config, route, fetchImpl, runCommand }) {
  const { tts, ffmpegPath } = config;
  let response;
  try {
    response = await fetchImpl(tts.kokoroUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: tts.kokoroModel,
        input: text,
        voice: route.voice,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(tts.timeoutMs ?? 60000),
    });
  } catch (error) {
    throw new TtsError(`Kokoro request failed: ${error.message}`, { cause: error });
  }

  if (!response.ok) {
    let snippet = '';
    try {
      snippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new TtsError(
      `Kokoro HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
    );
  }

  const wav = Buffer.from(await response.arrayBuffer());
  if (wav.length < 4 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new TtsError('Kokoro did not return a WAV payload');
  }
  return decodeToPcm48Stereo(wav, { ffmpegPath, runCommand });
}

async function synthesizeWithSay(text, { config, route, runCommand, makeTempDir }) {
  const { tts, ffmpegPath } = config;
  const tempDir = await makeTempDir();
  const aiffPath = path.join(tempDir, 'tts.aiff');
  try {
    await runCommand(
      tts.sayCommand,
      ['-v', route.voice, '-o', aiffPath, text],
      { timeoutMs: tts.timeoutMs ?? 60000 },
    );
    return await decodeFileToPcm48Stereo(aiffPath, { ffmpegPath, runCommand });
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError(`macOS say fallback failed: ${error.message}`, { cause: error });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
