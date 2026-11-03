import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CONTROL_PORT,
  ConfigError,
  expandHome,
  loadBotToken,
  loadConfig,
  normalizeConfig,
  publicConfigSummary,
  validateTokenShape,
} from '../src/config.js';

const VALID = {
  tokenFile: '~/.config/dsh-superagent/discord-token',
  guildId: '123456789012345678',
  voiceChannelId: '223456789012345678',
  operatorUserId: '323456789012345678',
};

const VALID_TOKEN =
  ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'fGhIjKlMnOpQrStUvWxYz0123456789abcd'].join('.');

function fakeReadFile(content) {
  return async (filePath) => {
    if (typeof content === 'function') return content(filePath);
    return content;
  };
}

test('normalizeConfig fills English-only defaults', () => {
  const config = normalizeConfig(structuredClone(VALID));
  assert.equal(config.controlPort, DEFAULT_CONTROL_PORT);
  assert.equal(config.controlHost, '127.0.0.1');
  assert.equal(config.selfMute, false);
  assert.equal(config.stt.language, 'en');
  assert.equal(config.stt.url, 'http://127.0.0.1:2022/v1/audio/transcriptions');
  assert.equal(config.tts.engine, 'kokoro');
  assert.equal(config.tts.kokoroVoice, 'af_heart');
  assert.equal(config.capture.mode, 'vad');
  assert.equal(config.capture.autoStart, true);
  assert.equal(config.capture.vad.thresholdDbfs, -35);
  assert.deepEqual(config.ignoreUserIds, []);
  assert.deepEqual(config.ignoreBotIds, []);
  assert.equal(config.replyTextChannelId, null);
  assert.equal(config.ffmpegPath, 'ffmpeg');
  assert.ok(config.tokenFile.endsWith('/.config/dsh-superagent/discord-token'));
  assert.ok(!config.tokenFile.startsWith('~'), 'home directory is expanded');
});

test('normalizeConfig honours explicit values', () => {
  const config = normalizeConfig({
    ...structuredClone(VALID),
    instanceName: 'hermes',
    controlPort: 3091,
    selfMute: true,
    ignoreUserIds: ['423456789012345678'],
    ignoreBotIds: ['523456789012345678'],
    replyTextChannelId: '623456789012345678',
    tts: { engine: 'auto', kokoroVoice: 'bf_emma', sayVoice: 'Yuna' },
    stt: { language: 'ko', model: 'ggml-base' },
    capture: { mode: 'ptt', autoStart: false, vad: { silenceMs: 800 } },
  });
  assert.equal(config.instanceName, 'hermes');
  assert.equal(config.controlPort, 3091);
  assert.equal(config.selfMute, true);
  assert.deepEqual(config.ignoreUserIds, ['423456789012345678']);
  assert.deepEqual(config.ignoreBotIds, ['523456789012345678']);
  assert.equal(config.replyTextChannelId, '623456789012345678');
  assert.equal(config.tts.engine, 'auto');
  assert.equal(config.tts.kokoroVoice, 'bf_emma');
  assert.equal(config.stt.language, 'ko');
  assert.equal(config.stt.model, 'ggml-base');
  assert.equal(config.capture.mode, 'ptt');
  assert.equal(config.capture.autoStart, false);
  assert.equal(config.capture.vad.silenceMs, 800);
});

test('normalizeConfig rejects bad required fields', () => {
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), guildId: undefined }), ConfigError);
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), guildId: 'not-an-id' }), /guildId/);
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), voiceChannelId: '' }), /voiceChannelId/);
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), operatorUserId: 42 }), /operatorUserId/);
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), tokenFile: '' }), /tokenFile/);
});

test('normalizeConfig rejects invalid optional values', () => {
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), controlPort: 80 }), /controlPort/);
  assert.throws(() => normalizeConfig({ ...structuredClone(VALID), controlPort: '3090' }), /controlPort/);
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), tts: { engine: 'piper' } }),
    /tts.engine/,
  );
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), capture: { mode: 'hotkey' } }),
    /capture.mode/,
  );
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), stt: { language: 'english please' } }),
    /stt.language/,
  );
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), stt: { url: 'ftp://example' } }),
    /stt.url/,
  );
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), ignoreUserIds: [VALID.operatorUserId] }),
    /operatorUserId must not be listed/,
  );
  assert.throws(
    () => normalizeConfig({ ...structuredClone(VALID), ignoreBotIds: ['not-an-id'] }),
    /ignoreBotIds/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        ...structuredClone(VALID),
        capture: { vad: { minSpeechMs: 2000, maxUtteranceMs: 1000 } },
      }),
    /minSpeechMs/,
  );
});

test('loadConfig reads and validates a config file', async () => {
  const config = await loadConfig({
    filePath: '/tmp/voice-bridge.json',
    readFileImpl: fakeReadFile(JSON.stringify(VALID)),
  });
  assert.equal(config.configPath, '/tmp/voice-bridge.json');
  assert.equal(config.stt.language, 'en');
});

test('loadConfig reports missing and malformed files without leaking content', async () => {
  await assert.rejects(
    loadConfig({
      filePath: '/tmp/nope.json',
      readFileImpl: fakeReadFile(() => {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }),
    }),
    /cannot read config file/,
  );
  await assert.rejects(
    loadConfig({ filePath: '/tmp/bad.json', readFileImpl: fakeReadFile('{ not json') }),
    /not valid JSON/,
  );
});

test('expandHome expands only a leading ~/', () => {
  assert.ok(expandHome('~/x').startsWith('/'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('relative/path'), 'relative/path');
});

test('validateTokenShape accepts a real-shaped token and explains the broken one', () => {
  assert.deepEqual(validateTokenShape(VALID_TOKEN), { ok: true, reason: null });

  const broken = 'a'.repeat(32); // what ~/.config/dsh-superagent/discord-token held on 2026-11-03
  const result = validateTokenShape(broken);
  assert.equal(result.ok, false);
  assert.match(result.reason, /dot-separated/);
  assert.ok(!result.reason.includes(broken), 'reason never echoes the token');

  assert.equal(validateTokenShape('').ok, false);
  assert.equal(validateTokenShape('has space.in.token').ok, false);
  assert.equal(validateTokenShape('abc.def.ghi').ok, false, 'too short');
});

test('loadBotToken reads the token file and keeps the value out of errors', async () => {
  const token = await loadBotToken({
    config: { tokenFile: '/tmp/token' },
    readFileImpl: fakeReadFile(`${VALID_TOKEN}\n`),
  });
  assert.equal(token, VALID_TOKEN);

  await assert.rejects(
    loadBotToken({
      config: { tokenFile: '/tmp/token' },
      readFileImpl: fakeReadFile('a'.repeat(32)),
    }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /token/);
      assert.ok(!error.message.includes('a'.repeat(32)));
      return true;
    },
  );
});

test('publicConfigSummary never includes the token or a token path content', () => {
  const summary = publicConfigSummary(normalizeConfig(structuredClone(VALID)));
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes('token='));
  assert.ok('tokenFile' in summary, 'path is safe to expose, contents are not');
  assert.equal(summary.captureMode, 'vad');
  assert.equal(summary.sttLanguage, 'en');
});
