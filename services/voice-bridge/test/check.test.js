import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatCheckResults, isPortFree, runCheck } from '../src/check.js';

const VALID_TOKEN =
  ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'fGhIjKlMnOpQrStUvWxYz0123456789abcd'].join('.');

async function writeTempConfig(token = VALID_TOKEN) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-voice-check-'));
  const tokenFile = path.join(dir, 'discord-token');
  const configPath = path.join(dir, 'voice-bridge.json');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({
      tokenFile,
      guildId: '123456789012345678',
      voiceChannelId: '223456789012345678',
      operatorUserId: '323456789012345678',
      controlPort: 3090,
    }),
    { mode: 0o600 },
  );
  return configPath;
}

function fakeRun(streamsOk = true) {
  return async (command, args) => {
    if (!streamsOk) throw new Error(`${command} missing`);
    if (command === 'say') return { stdout: Buffer.from('Yuna (Korean (South Korea))\n') };
    return { stdout: Buffer.from('ffmpeg version 9') };
  };
}

const fakeFetch = async () => ({ ok: true, status: 200 });

test('--check passes with a valid config, token, ffmpeg and local services', async () => {
  const configPath = await writeTempConfig();
  const { ok, results } = await runCheck({
    configPath,
    run: fakeRun(),
    fetchImpl: fakeFetch,
    checkPort: false,
  });
  assert.equal(ok, true);
  const byName = Object.fromEntries(results.map((entry) => [entry.name, entry]));
  assert.equal(byName['config file'].ok, true);
  assert.equal(byName['bot token file'].ok, true);
  assert.equal(byName['bot token file'].detail.includes(VALID_TOKEN), false, 'never print the token');
  assert.equal(byName['config: STT language'].detail, 'en (explicit, never auto)');
  assert.equal(byName.ffmpeg.ok, true);
  assert.equal(byName['whisper server'].ok, true);
  assert.equal(byName['Kokoro server'].ok, true);
});

test('--check fails hard on a broken token file', async () => {
  const configPath = await writeTempConfig('a'.repeat(32)); // the current broken token
  const { ok, results } = await runCheck({
    configPath,
    run: fakeRun(),
    fetchImpl: fakeFetch,
    checkPort: false,
  });
  assert.equal(ok, false);
  const tokenCheck = results.find((entry) => entry.name === 'bot token file');
  assert.equal(tokenCheck.ok, false);
  assert.match(tokenCheck.detail, /dot-separated/);
});

test('--check reports missing config and dead services', async () => {
  const { ok, results } = await runCheck({
    configPath: '/tmp/definitely-not-here.json',
    run: fakeRun(),
    fetchImpl: fakeFetch,
    checkPort: false,
  });
  assert.equal(ok, false);
  assert.equal(results.length, 1);

  const configPath = await writeTempConfig();
  const failing = await runCheck({
    configPath,
    run: fakeRun(false),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    checkPort: false,
  });
  // ffmpeg is a hard failure; the local services are warnings.
  assert.equal(failing.ok, false);
  const whisper = failing.results.find((entry) => entry.name === 'whisper server');
  assert.equal(whisper.ok, false);
  assert.equal(whisper.hard, false);
});

test('formatCheckResults prints ok/FAIL/warn lines and a summary', async () => {
  const okText = formatCheckResults([
    { name: 'config file', ok: true, detail: 'x', hard: true },
  ]);
  assert.match(okText, /\[ok  \] config file/);
  assert.match(okText, /config check passed/);

  const failText = formatCheckResults([
    { name: 'token', ok: false, detail: 'bad', hard: true },
    { name: 'Kokoro', ok: false, detail: 'down', hard: false },
  ]);
  assert.match(failText, /\[FAIL\] token/);
  assert.match(failText, /\[warn\] Kokoro/);
  assert.match(failText, /1 check\(s\) failed/);
});

test('isPortFree detects a free ephemeral port', async () => {
  // Port 0 always asks the kernel for a free port; closing it keeps the check
  // hermetic and only touches the loopback interface.
  assert.equal(await isPortFree(0), true);
});
