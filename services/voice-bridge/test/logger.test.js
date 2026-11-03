import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, redactSecrets } from '../src/logger.js';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'fGhIjKlMnOpQrStUvWxYz0123456789abcd'].join('.');

function fakeSink() {
  const lines = { log: [], error: [] };
  return {
    lines,
    log: (line) => lines.log.push(line),
    error: (line) => lines.error.push(line),
  };
}

test('redactSecrets removes exact secrets anywhere in a string', () => {
  const text = `logged in with ${TOKEN} (oops)`;
  const redacted = redactSecrets(text, [TOKEN]);
  assert.ok(!redacted.includes(TOKEN));
  assert.match(redacted, /\[REDACTED\]/);
});

test('redactSecrets removes Discord-token-shaped substrings even when unknown', () => {
  const redacted = redactSecrets(`token=${TOKEN}`);
  assert.ok(!redacted.includes(TOKEN));
  assert.equal(redacted, 'token=[REDACTED]');
  assert.equal(redactSecrets('ordinary message', [TOKEN]), 'ordinary message');
});

test('redactSecrets ignores short or non-string secrets', () => {
  assert.equal(redactSecrets('abc', ['a', null, 42, '']), 'abc');
});

test('logger output never contains the token', () => {
  const sink = fakeSink();
  const logger = createLogger({ name: 'test', secrets: [TOKEN], sink, now: () => 'T' });
  logger.info(`login failed for ${TOKEN}`);
  logger.warn('warning', { token: TOKEN });
  logger.error(new Error(`bad token: ${TOKEN}`));

  const everything = [...sink.lines.log, ...sink.lines.error].join('\n');
  assert.ok(!everything.includes(TOKEN), 'token leaked into logs');
  assert.match(everything, /T INFO \[test\]/);
  assert.match(everything, /\[REDACTED\]/);
});

test('logger writes warn/error to stderr and filters by level', () => {
  const sink = fakeSink();
  const logger = createLogger({ name: 'test', sink, level: 'warn', now: () => 'T' });
  logger.debug('debug line');
  logger.info('info line');
  logger.warn('warn line');
  assert.deepEqual(sink.lines.log, []);
  assert.equal(sink.lines.error.length, 1);
  assert.match(sink.lines.error[0], /WARN/);
});

test('logger serialises extras and errors', () => {
  const sink = fakeSink();
  const logger = createLogger({ name: 'test', sink, now: () => 'T' });
  logger.info('with extra', { voice: 'af_heart' });
  assert.match(sink.lines.log[0], /\{"voice":"af_heart"\}/);

  logger.error('with error', new Error('boom'));
  assert.match(sink.lines.error[0], /\{"error":"boom"\}/);

  const circular = {};
  circular.self = circular;
  logger.info('circular', circular);
  assert.match(sink.lines.log[1], /unserializable/);
});
