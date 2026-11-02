#!/usr/bin/env node
/**
 * Offline acceptance check for the local TTS engine.
 *
 * Imports `lib/tts.js` directly (no harness, no routes) and synthesises one
 * English and one Hangul sentence through the real engines, writing
 * `/tmp/voice-mode-tts-en.wav` and `/tmp/voice-mode-tts-ko.wav`.
 *
 * It also proves the host event loop survives synthesis: a 20 ms interval runs
 * during the English request and its tick count is reported. `generateAsync`
 * must let the timer fire (a synchronous `generate()` freezes it), which is the
 * property that keeps the live Harness responsive while a reply is spoken.
 *
 *   node tools/tts-check.mjs
 *
 * Exits 0 when both WAVs are real audio (bytes > 10000 and a sane duration);
 * prints one JSON report either way.
 */

import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import { createTtsEngine } from '../lib/tts.js';
import { encodeWav16 } from '../lib/wav.js';

/** Sentences the check must speak. */
const CASES = [
  {
    name: 'en',
    file: '/tmp/voice-mode-tts-en.wav',
    text: 'Hello, this is a completely local voice test.',
    expectEngine: 'kokoro',
  },
  {
    name: 'ko',
    file: '/tmp/voice-mode-tts-ko.wav',
    text: '안녕하세요. 이것은 완전히 로컬 음성 테스트입니다.',
    expectEngine: 'say',
  },
];

/** Sample counts below this are not speech (the WAV byte floor is 10000). */
const MIN_WAV_BYTES = 10_000;
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 60;

/**
 * Read the true on-disk duration with afinfo, falling back to ffprobe.
 * @param {string} file - WAV path.
 * @returns {{seconds: number, source: string} | undefined} measured duration.
 */
function probeDuration(file) {
  const afinfo = spawnSync('/usr/bin/afinfo', [file], { encoding: 'utf8' });
  if (afinfo.status === 0 && typeof afinfo.stdout === 'string') {
    const match = /estimated duration:\s*([\d.]+)\s*sec/u.exec(afinfo.stdout);
    if (match !== null) return { seconds: Number(match[1]), source: 'afinfo' };
  }
  const ffprobe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  if (ffprobe.status === 0 && typeof ffprobe.stdout === 'string') {
    const seconds = Number(ffprobe.stdout.trim());
    if (Number.isFinite(seconds)) return { seconds, source: 'ffprobe' };
  }
  return undefined;
}

/**
 * Main check: synthesise, write, measure, and judge both cases.
 * @returns {Promise<void>} resolves after printing the JSON report.
 */
async function main() {
  const engine = createTtsEngine();
  const status = await engine.status();
  const results = [];
  const failures = [];
  /** @type {{ticks: number, expectedTicks: number, maxLagMs: number, elapsedMs: number} | undefined} */
  let eventLoopProof;

  for (const test of CASES) {
    try {
      // Event-loop probe: a 20 ms interval must keep firing while Kokoro works.
      let ticks = 0;
      let maxLagMs = 0;
      let lastTickAt = Date.now();
      const interval = setInterval(() => {
        const now = Date.now();
        maxLagMs = Math.max(maxLagMs, now - lastTickAt - 20);
        lastTickAt = now;
        ticks += 1;
      }, 20);
      const startedAt = Date.now();
      let audio;
      try {
        audio = await engine.synthesize({ text: test.text });
      } finally {
        clearInterval(interval);
      }
      const elapsedMs = Date.now() - startedAt;
      if (test.name === 'en' && (audio.engine === 'kokoro' || audio.engine === 'kokoro-http')) {
        // A 20 ms interval fires at most elapsedMs/20 times; Node timers under
        // load lose a couple, so require half of that plus a small afterglow.
        // A synchronous generate() would leave <= 1 tick and a ~2 s lag.
        eventLoopProof = {
          ticks,
          expectedTicks: Math.max(5, Math.floor(elapsedMs / 40)),
          maxLagMs,
          elapsedMs,
        };
      }

      const bytes = encodeWav16(audio.samples, audio.sampleRate);
      await writeFile(test.file, bytes);
      const measured = probeDuration(test.file);
      const durationSeconds = Number(((measured?.seconds ?? audio.samples.length / audio.sampleRate)).toFixed(3));
      const result = {
        case: test.name,
        file: test.file,
        engine: audio.engine,
        sampleRate: audio.sampleRate,
        sid: audio.sid,
        voice: audio.voice,
        bytes: bytes.byteLength,
        durationSeconds,
        durationSource: measured?.source ?? 'samples',
        elapsedMs,
        ...(audio.fallbackReason === undefined ? {} : { fallbackReason: audio.fallbackReason }),
      };
      results.push(result);
      if (bytes.byteLength <= MIN_WAV_BYTES) {
        failures.push({ case: test.name, reason: `WAV is ${bytes.byteLength} bytes (must exceed ${MIN_WAV_BYTES})` });
      }
      if (!(durationSeconds >= MIN_DURATION_SECONDS && durationSeconds <= MAX_DURATION_SECONDS)) {
        failures.push({ case: test.name, reason: `duration ${durationSeconds}s is outside ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s` });
      }
      const engineMatches =
        test.expectEngine === undefined ||
        audio.engine === test.expectEngine ||
        (test.expectEngine === 'kokoro' && audio.engine === 'kokoro-http');
      if (!engineMatches) {
        failures.push({
          case: test.name,
          reason: `engine ${audio.engine} (expected ${test.expectEngine})${audio.fallbackReason === undefined ? '' : `: ${audio.fallbackReason}`}`,
        });
      }
    } catch (error) {
      results.push({ case: test.name, file: null, error: error?.message ?? String(error), code: error?.code ?? null });
      failures.push({ case: test.name, reason: error?.message ?? String(error) });
    }
  }

  // Non-blocking proof is a hard acceptance item for the host half.
  if (status.engine === 'kokoro' || status.engine === 'kokoro-http') {
    if (eventLoopProof === undefined) {
      failures.push({ case: 'event-loop', reason: 'Kokoro was reported available but no Kokoro synthesis ran' });
    } else if (eventLoopProof.ticks < eventLoopProof.expectedTicks) {
      failures.push({
        case: 'event-loop',
        reason: `only ${eventLoopProof.ticks} timer ticks during ${eventLoopProof.elapsedMs} ms of synthesis (expected >= ${eventLoopProof.expectedTicks}): synthesis blocks the host`,
      });
    } else if (eventLoopProof.maxLagMs > 150) {
      failures.push({
        case: 'event-loop',
        reason: `timer lag reached ${eventLoopProof.maxLagMs} ms during synthesis: the host event loop stalled`,
      });
    }
  }

  const report = {
    ok: failures.length === 0,
    status,
    eventLoopProof,
    results,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  engine.dispose();
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, failures: [{ case: 'fatal', reason: error?.message ?? String(error) }] }, null, 2));
  process.exitCode = 1;
});
