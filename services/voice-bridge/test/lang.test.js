import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeLanguage, hasHangul, pickTtsEngine } from '../src/lang.js';

test('hasHangul detects Korean syllables, jamo and compatibility jamo', () => {
  assert.equal(hasHangul('안녕하세요'), true);
  assert.equal(hasHangul('whisper 브리지'), true);
  assert.equal(hasHangul('\u1100\u1161'), true, 'jamo');
  assert.equal(hasHangul('\u3131'), true, 'compatibility jamo');
  assert.equal(hasHangul('Hello from the voice bridge'), false);
  assert.equal(hasHangul('12345?!'), false);
  assert.equal(hasHangul(''), false);
  assert.equal(hasHangul(undefined), false);
});

test('pickTtsEngine defaults everything to Kokoro (English-only MVP)', () => {
  const english = pickTtsEngine('Hello there', { engine: 'kokoro', kokoroVoice: 'af_heart' });
  assert.deepEqual(english, { engine: 'kokoro', voice: 'af_heart', language: 'en' });

  const koreanWithDefaultEngine = pickTtsEngine('안녕하세요', { engine: 'kokoro', kokoroVoice: 'af_heart' });
  assert.equal(koreanWithDefaultEngine.engine, 'kokoro', 'Korean must not reach Kokoro in auto mode only');

  const defaults = pickTtsEngine('Hello');
  assert.deepEqual(defaults, { engine: 'kokoro', voice: 'af_heart', language: 'en' });
});

test('pickTtsEngine routes Hangul to the macOS say fallback only when configured', () => {
  const korean = pickTtsEngine('안녕하세요', { engine: 'auto', sayVoice: 'Yuna', kokoroVoice: 'af_heart' });
  assert.deepEqual(korean, { engine: 'say', voice: 'Yuna', language: 'ko' });

  const english = pickTtsEngine('Hello', { engine: 'auto', sayVoice: 'Yuna', kokoroVoice: 'af_heart' });
  assert.deepEqual(english, { engine: 'kokoro', voice: 'af_heart', language: 'en' });

  const mixed = pickTtsEngine('상태: OK', { engine: 'auto', sayVoice: 'Yuna' });
  assert.equal(mixed.engine, 'say', 'mixed utterances go to the Korean voice');
});

test('describeLanguage is log-friendly', () => {
  assert.equal(describeLanguage('en'), 'English');
  assert.equal(describeLanguage('ko'), 'Korean');
  assert.equal(describeLanguage('fr'), 'fr');
});
