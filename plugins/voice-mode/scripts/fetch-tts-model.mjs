#!/usr/bin/env node
/**
 * Idempotent fetch of the Kokoro int8 multi-lang voice model.
 *
 * Downloads
 *   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2
 * into `~/.dsh/voice-mode/tts/` and extracts it to
 * `~/.dsh/voice-mode/tts/kokoro-int8-multi-lang-v1_0/`.
 *
 * The archive is ~130 MB and this machine already has it extracted, so the
 * normal run is a quick filesystem check that exits 0 without touching the
 * network. `curl` and `tar` (bsdtar, which reads bzip2) are used so no Python or
 * npm dependency is involved.
 *
 * Overrides:
 *   VOICE_MODE_TTS_ROOT      directory holding the archive and extracted model
 *   VOICE_MODE_KOKORO_DIR    explicit model directory (skips the run entirely)
 *
 *   node scripts/fetch-tts-model.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODEL_NAME = 'kokoro-int8-multi-lang-v1_0';
export const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2';

/** Files and directories that make the extracted model usable by sherpa-onnx. */
const REQUIRED_FILES = ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt'];
const REQUIRED_DIRS = ['espeak-ng-data'];

/** A plausible archive is at least this many bytes; smaller means a failed download. */
const MIN_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Resolve the root directory that owns the archive and the extracted model.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute directory.
 */
export function ttsRoot(env = process.env) {
  const override = typeof env.VOICE_MODE_TTS_ROOT === 'string' ? env.VOICE_MODE_TTS_ROOT.trim() : '';
  return override !== '' ? override : join(homedir(), '.dsh', 'voice-mode', 'tts');
}

/**
 * Resolve the extracted Kokoro model directory.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute directory.
 */
export function kokoroModelDir(env = process.env) {
  const override = typeof env.VOICE_MODE_KOKORO_DIR === 'string' ? env.VOICE_MODE_KOKORO_DIR.trim() : '';
  return override !== '' ? override : join(ttsRoot(env), MODEL_NAME);
}

/**
 * Check whether the extracted model is complete enough to load.
 * @param {string} directory - candidate model directory.
 * @returns {{complete: boolean, missing: string[], modelBytes: number, directory: string}} inspection result.
 */
export function inspectModel(directory) {
  const missing = [];
  for (const name of REQUIRED_FILES) {
    try {
      if (!statSync(join(directory, name)).isFile()) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  for (const name of REQUIRED_DIRS) {
    try {
      if (!statSync(join(directory, name)).isDirectory()) missing.push(`${name}/`);
    } catch {
      missing.push(`${name}/`);
    }
  }
  let modelBytes = 0;
  try {
    modelBytes = statSync(join(directory, 'model.int8.onnx')).size;
  } catch {
    modelBytes = 0;
  }
  return { complete: missing.length === 0, missing, modelBytes, directory };
}

/**
 * Run one external command, streaming its output, and fail on a non-zero exit.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {string} cwd - working directory.
 * @returns {void}
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

/**
 * Ensure the model is extracted; download and extract only when it is not.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {{ok: boolean, action: 'skipped' | 'downloaded' | 'failed', directory: string, archive: string, modelBytes: number, missing?: string[]}} result.
 */
export function ensureModel(env = process.env) {
  const directory = kokoroModelDir(env);
  const root = ttsRoot(env);
  const archive = join(root, `${MODEL_NAME}.tar.bz2`);

  const before = inspectModel(directory);
  if (before.complete) {
    return { ok: true, action: 'skipped', directory, archive, modelBytes: before.modelBytes };
  }

  try {
    mkdirSync(root, { recursive: true });
    const usableArchive = () => {
      try {
        return statSync(archive).size >= MIN_ARCHIVE_BYTES;
      } catch {
        return false;
      }
    };
    if (!usableArchive()) {
      if (existsSync(archive)) rmSync(archive, { force: true });
      run('curl', ['-L', '--fail', '--retry', '3', '--output', archive, MODEL_URL], root);
    }
    run('tar', ['-xjf', archive, '-C', root], root);
    const after = inspectModel(directory);
    if (!after.complete) {
      return {
        ok: false,
        action: 'failed',
        directory,
        archive,
        modelBytes: after.modelBytes,
        missing: after.missing,
      };
    }
    return { ok: true, action: 'downloaded', directory, archive, modelBytes: after.modelBytes };
  } catch (error) {
    return {
      ok: false,
      action: 'failed',
      directory,
      archive,
      modelBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Script entry point: print one JSON result and set the exit code.
 * @returns {void}
 */
function main() {
  const result = ensureModel();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
