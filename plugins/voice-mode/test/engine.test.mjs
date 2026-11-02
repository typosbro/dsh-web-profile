import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as engineModule from '../src/engine.mjs';

const { stripMarkdown, splitSentences, looksLikeEcho, pickVoice, createSpeaker } = engineModule;

/* ------------------------------------------------------------------------- *
 * Test doubles: no browser globals are required by the engine.
 * ------------------------------------------------------------------------- */

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.uri = 'urn:fake:' + text;
    this.lang = '';
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function createFakeSynth() {
  const synth = {
    spoken: [],
    cancelCalls: 0,
    speak(utterance) {
      synth.spoken.push(utterance);
    },
    cancel() {
      synth.cancelCalls += 1;
    },
  };
  return synth;
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------------- *
 * stripMarkdown
 * ------------------------------------------------------------------------- */

test('stripMarkdown replaces fenced code blocks with an audible marker', () => {
  assert.equal(
    stripMarkdown('Before\n```js\nconst x = 1;\n```\nAfter'),
    'Before (code omitted) After'
  );
  assert.equal(
    stripMarkdown('Use this:\n```\nnpm test\n```\nDone.'),
    'Use this: (code omitted) Done.'
  );
  // A streaming reply can push an unterminated fence; it must not leak code.
  assert.equal(stripMarkdown('Text ```js\nlet a = 1'), 'Text (code omitted)');
  assert.equal(stripMarkdown('~~~~\nraw\n~~~~\nAfter'), '(code omitted) After');
});

test('stripMarkdown unwraps inline code, links, and images', () => {
  assert.equal(stripMarkdown('Use `npm test` now.'), 'Use npm test now.');
  assert.equal(
    stripMarkdown('See [the docs](https://example.com) now'),
    'See the docs now'
  );
  assert.equal(
    stripMarkdown('![diagram](https://example.com/a.png) shows flow'),
    'diagram shows flow'
  );
  assert.equal(stripMarkdown('![](https://example.com/a.png) alone'), 'alone');
});

test('stripMarkdown strips heading, list, quote, and hr markers', () => {
  assert.equal(stripMarkdown('# Title\nBody'), 'Title Body');
  assert.equal(stripMarkdown('## Title ##'), 'Title');
  assert.equal(stripMarkdown('> quoted text'), 'quoted text');
  assert.equal(stripMarkdown('- one\n- two'), 'one two');
  assert.equal(stripMarkdown('1. first\n2. second'), 'first second');
  assert.equal(stripMarkdown('- [x] done\n- [ ] todo'), 'done todo');
  assert.equal(stripMarkdown('above\n---\nbelow'), 'above below');
});

test('stripMarkdown removes emphasis markers but keeps punctuation', () => {
  assert.equal(stripMarkdown('**Bold** and *italic* and ~~gone~~'), 'Bold and italic and gone');
  assert.equal(stripMarkdown('__bold__ and _italic_'), 'bold and italic');
  assert.equal(stripMarkdown('**Hello, world!** How are you?'), 'Hello, world! How are you?');
  assert.equal(stripMarkdown('snake_case_name stays'), 'snake_case_name stays');
});

test('stripMarkdown flattens tables and html', () => {
  assert.equal(
    stripMarkdown('| Name | Value |\n| --- | --- |\n| a | b |'),
    'Name Value a b'
  );
  assert.equal(stripMarkdown('Hello <b>world</b>'), 'Hello world');
  assert.equal(stripMarkdown('Text <!-- hidden --> here'), 'Text here');
});

test('stripMarkdown collapses whitespace and tolerates empty input', () => {
  assert.equal(stripMarkdown('  a \n\n  b  '), 'a b');
  assert.equal(stripMarkdown(''), '');
  assert.equal(stripMarkdown(null), '');
  assert.equal(stripMarkdown(undefined), '');
  assert.equal(stripMarkdown(42), '');
});

test('stripMarkdown handles a realistic mixed reply', () => {
  const reply =
    '# Heading\n\nSome **bold** text with `code`.\n\n' +
    '```py\nprint(1)\n```\n\n> quote\n\n- item';
  assert.equal(
    stripMarkdown(reply),
    'Heading Some bold text with code. (code omitted) quote item'
  );
});

/* ------------------------------------------------------------------------- *
 * splitSentences
 * ------------------------------------------------------------------------- */

test('splitSentences returns complete leading sentences and the remainder', () => {
  assert.deepEqual(splitSentences('Hello world. How are you? Fine!'), {
    sentences: ['Hello world.', 'How are you?', 'Fine!'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Hello world. Next sentence'), {
    sentences: ['Hello world.'],
    rest: 'Next sentence',
  });
  const noBoundary = splitSentences('Streaming text with no ending');
  assert.deepEqual(noBoundary.sentences, []);
  assert.equal(noBoundary.rest, 'Streaming text with no ending');
});

test('splitSentences returns the documented result shape for empty input', () => {
  const empty = splitSentences('');
  assert.deepEqual(Object.keys(empty), ['sentences', 'rest']);
  assert.deepEqual(empty.sentences, []);
  assert.equal(empty.rest, '');
  assert.deepEqual(splitSentences(undefined), { sentences: [], rest: '' });
  assert.deepEqual(splitSentences('   '), { sentences: [], rest: '' });
});

test('splitSentences keeps decimals and abbreviations intact', () => {
  assert.deepEqual(splitSentences('Pi is 3.14 exactly.'), {
    sentences: ['Pi is 3.14 exactly.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Version 2.0. Then done.'), {
    sentences: ['Version 2.0.', 'Then done.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Mr. Smith went home. Then he slept.'), {
    sentences: ['Mr. Smith went home.', 'Then he slept.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Use e.g. this or that. Done.'), {
    sentences: ['Use e.g. this or that.', 'Done.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('The U.S. Army moved. Next.'), {
    sentences: ['The U.S. Army moved.', 'Next.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('J. K. Rowling wrote it. Then she rested.'), {
    sentences: ['J. K. Rowling wrote it.', 'Then she rested.'],
    rest: '',
  });
});

test('splitSentences does not split a domain-like dotted token', () => {
  assert.deepEqual(splitSentences('Visit example.com for the docs'), {
    sentences: [],
    rest: 'Visit example.com for the docs',
  });
});

test('splitSentences splits on newlines', () => {
  assert.deepEqual(splitSentences('Line one\nLine two'), {
    sentences: ['Line one'],
    rest: 'Line two',
  });
  assert.deepEqual(splitSentences('Line one.\nLine two.'), {
    sentences: ['Line one.', 'Line two.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('One.\r\nTwo.'), {
    sentences: ['One.', 'Two.'],
    rest: '',
  });
});

test('splitSentences handles closing quotes and punctuation runs', () => {
  assert.deepEqual(splitSentences('He said "Hello." Then left.'), {
    sentences: ['He said "Hello."', 'Then left.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Really?! Yes.'), {
    sentences: ['Really?!', 'Yes.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Wait... What now?'), {
    sentences: ['Wait...', 'What now?'],
    rest: '',
  });
  assert.deepEqual(splitSentences('Just this.'), {
    sentences: ['Just this.'],
    rest: '',
  });
});

test('splitSentences splits CJK sentences that have no trailing spaces', () => {
  assert.deepEqual(splitSentences('\u4f60\u597d\u3002\u4e16\u754c\u3002'), {
    sentences: ['\u4f60\u597d\u3002', '\u4e16\u754c\u3002'],
    rest: '',
  });
  assert.deepEqual(splitSentences('\u4f60\u597d\uff01\u4e16\u754c\uff1f'), {
    sentences: ['\u4f60\u597d\uff01', '\u4e16\u754c\uff1f'],
    rest: '',
  });
});

test('splitSentences ignores letterless fragments', () => {
  assert.deepEqual(splitSentences('---\nHello.'), {
    sentences: ['Hello.'],
    rest: '',
  });
  assert.deepEqual(splitSentences('*\n*\n'), { sentences: [], rest: '' });
});

test('splitSentences force-splits an over-long unterminated run', () => {
  const longText = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
    .repeat(5)
    .trim();
  assert.ok(longText.length > 220);
  const result = splitSentences(longText);
  assert.ok(result.sentences.length >= 1);
  assert.ok(result.sentences.every((sentence) => sentence.length <= 220));
  assert.ok(result.rest.length <= 220);
  assert.equal(collapse([...result.sentences, result.rest].join(' ')), collapse(longText));
});

test('splitSentences force-splits an over-long terminated sentence', () => {
  const terminated = 'word '.repeat(60).trim() + '.';
  const result = splitSentences(terminated);
  assert.ok(result.sentences.length >= 2);
  assert.equal(result.rest, '');
  assert.ok(result.sentences.every((sentence) => sentence.length <= 220));
  assert.ok(result.sentences[result.sentences.length - 1].endsWith('.'));
  assert.equal(collapse(result.sentences.join(' ')), collapse(terminated));
});

test('splitSentences hard-cuts over-long spacerless text', () => {
  const result = splitSentences('\u554a'.repeat(250));
  assert.equal(result.sentences.length, 1);
  assert.equal(result.sentences[0].length, 220);
  assert.equal(result.rest.length, 30);
});

/* ------------------------------------------------------------------------- *
 * looksLikeEcho
 * ------------------------------------------------------------------------- */

test('looksLikeEcho detects echoed assistant speech', () => {
  const spoken = 'Here is the weather tomorrow for Seoul: sunny and warm.';
  assert.equal(looksLikeEcho('the weather tomorrow', spoken), true);
  assert.equal(looksLikeEcho('HERE IS THE WEATHER TOMORROW.', spoken), true);
  assert.equal(
    looksLikeEcho('here is the weather tomorrow for seoul sunny and warm', spoken),
    true
  );
  assert.equal(looksLikeEcho('sunny', spoken), true);
});

test('looksLikeEcho does not mistake a real request for an echo', () => {
  assert.equal(looksLikeEcho('open the settings panel', 'Here is the weather tomorrow.'), false);
  assert.equal(looksLikeEcho('what is the capital of japan', 'The capital of France is Paris.'), false);
  assert.equal(looksLikeEcho('remind me at six', 'Here is the weather tomorrow.'), false);
});

test('looksLikeEcho never treats a barge-in stop phrase as echo', () => {
  const spoken =
    'you may stop right now, wait for the signal, no rush, hold on a moment, ' +
    'pause here, cancel that, shut up already';
  const phrases = [
    'stop',
    'wait',
    'no',
    'hold on',
    'shut up',
    'pause',
    'cancel',
  ];
  for (const phrase of phrases) {
    assert.equal(looksLikeEcho(phrase, spoken), false, 'stop phrase: ' + phrase);
  }
  assert.equal(looksLikeEcho('Stop!', spoken), false);
  assert.equal(looksLikeEcho('  HOLD   ON  ', spoken), false);
});

test('looksLikeEcho applies its empty / missing input rules', () => {
  assert.equal(looksLikeEcho('', 'hello there'), false);
  assert.equal(looksLikeEcho('   ', 'hello there'), false);
  assert.equal(looksLikeEcho('!!!', 'hello there'), false);
  assert.equal(looksLikeEcho(null, 'hello there'), false);
  assert.equal(looksLikeEcho(undefined, 'hello there'), false);
  assert.equal(looksLikeEcho('hello there', ''), false);
  assert.equal(looksLikeEcho('hello there', '   '), false);
  assert.equal(looksLikeEcho('hello there', undefined), false);
});

test('looksLikeEcho uses word overlap with a minimum length gate', () => {
  // 5 of 5 words present but out of order: no contiguous substring, overlap 1.0.
  assert.equal(
    looksLikeEcho('weather in seoul today', 'the weather in seoul is sunny today'),
    true
  );
  // Exactly 3 of 5 words = 0.6 overlap, long enough to count.
  assert.equal(
    looksLikeEcho('alpha bravo charlie zulu yankee', 'alpha bravo charlie delta echo foxtrot golf'),
    true
  );
  // 2 of 5 words = 0.4 overlap.
  assert.equal(
    looksLikeEcho('alpha bravo zulu yankee xray', 'alpha bravo charlie delta echo foxtrot golf'),
    false
  );
  // High overlap but under the 8-character minimum cannot match by overlap.
  assert.equal(looksLikeEcho('is in', 'the weather in seoul is sunny today'), false);
});

test('looksLikeEcho normalises accents and CJK text', () => {
  assert.equal(looksLikeEcho('caf\u00e9', 'Le caf\u00e9 est ouvert'), true);
  assert.equal(
    looksLikeEcho('\u5929\u6c14', '\u660e\u5929\u5929\u6c14\u5f88\u597d'),
    true
  );
  assert.equal(
    looksLikeEcho('\u8bf7\u6253\u5f00\u8bbe\u7f6e', '\u660e\u5929\u5929\u6c14\u5f88\u597d'),
    false
  );
});

/* ------------------------------------------------------------------------- *
 * pickVoice
 * ------------------------------------------------------------------------- */

test('pickVoice prefers an exact language match, then local voices', () => {
  const voices = [
    { name: 'Remote EN-US', lang: 'en-US', localService: false },
    { name: 'Local EN-US', lang: 'en-US', localService: true },
    { name: 'Local EN-GB', lang: 'en-GB', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en-US').name, 'Local EN-US');
});

test('pickVoice exact language beats a local prefix fallback', () => {
  const voices = [
    { name: 'Local EN-GB', lang: 'en-GB', localService: true },
    { name: 'Remote EN-US', lang: 'en-US', localService: false },
  ];
  assert.equal(pickVoice(voices, 'en-US').name, 'Remote EN-US');
});

test('pickVoice falls back to the language prefix', () => {
  const voices = [
    { name: 'GB', lang: 'en-GB', localService: false },
    { name: 'AU', lang: 'en-AU', localService: true },
    { name: 'DE', lang: 'de-DE', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en-US').name, 'AU');
  assert.equal(pickVoice(voices, 'en').name, 'AU');
});

test('pickVoice normalises language tags', () => {
  const voice = { name: 'X', lang: 'en-US', localService: true };
  assert.equal(pickVoice([voice], 'EN_us'), voice);
  assert.equal(pickVoice([voice], 'en-us'), voice);
  assert.equal(pickVoice([voice], 'EN-US'), voice);
});

test('pickVoice returns undefined only for an empty voice list', () => {
  assert.equal(pickVoice([], 'en-US'), undefined);
  assert.equal(pickVoice(null, 'en-US'), undefined);
  assert.equal(pickVoice(undefined, 'en-US'), undefined);
  assert.equal(pickVoice([null, undefined], 'en-US'), undefined);
  // No matching language at all still yields a voice.
  const fallback = pickVoice(
    [
      { name: 'EN', lang: 'en-US', localService: true },
      { name: 'GB', lang: 'en-GB', localService: false },
    ],
    'fr-FR'
  );
  assert.equal(fallback.name, 'EN');
});

test('pickVoice without a language prefers a local voice', () => {
  const voices = [
    { name: 'remote', lang: 'en-US', localService: false },
    { name: 'local', lang: 'de-DE', localService: true },
  ];
  assert.equal(pickVoice(voices).name, 'local');
  assert.equal(pickVoice(voices, '').name, 'local');
});

test('pickVoice prefers a default voice, but local service wins', () => {
  assert.equal(
    pickVoice(
      [
        { name: 'plain', lang: 'en-US' },
        { name: 'default', lang: 'en-US', default: true },
      ],
      'en-US'
    ).name,
    'default'
  );
  assert.equal(
    pickVoice(
      [
        { name: 'remoteDefault', lang: 'en-US', default: true, localService: false },
        { name: 'local', lang: 'en-US', localService: true },
      ],
      'en-US'
    ).name,
    'local'
  );
});

test('pickVoice returns the original voice object without mutating the list', () => {
  const voice = { name: 'zh', lang: 'zh-CN', localService: true };
  const voices = [{ name: 'en', lang: 'en-US', localService: true }, voice];
  assert.equal(pickVoice(voices, 'zh-CN'), voice);
  assert.deepEqual(voices, [{ name: 'en', lang: 'en-US', localService: true }, voice]);
});

/* ------------------------------------------------------------------------- *
 * createSpeaker
 * ------------------------------------------------------------------------- */

test('createSpeaker exposes exactly the documented surface', () => {
  const speaker = createSpeaker({ synth: createFakeSynth(), Utterance: FakeUtterance });
  assert.deepEqual(Object.keys(speaker).sort(), [
    'currentText',
    'dispose',
    'flush',
    'push',
    'speaking',
    'stop',
  ]);
  assert.equal(typeof speaker.push, 'function');
  assert.equal(typeof speaker.flush, 'function');
  assert.equal(typeof speaker.stop, 'function');
  assert.equal(typeof speaker.dispose, 'function');
  assert.equal(speaker.speaking, false);
  assert.equal(speaker.currentText, '');
});

test('createSpeaker buffers text and speaks complete sentences one at a time', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('Hello there. How are you?');
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.spoken[0].text, 'Hello there.');
  assert.equal(synth.spoken[0].lang, 'en-US');
  assert.equal(synth.spoken[0].rate, 1);
  assert.equal(speaker.speaking, true);
  assert.equal(speaker.currentText, 'Hello there.');
  synth.spoken[0].onend();
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[1].text, 'How are you?');
  assert.equal(speaker.currentText, 'How are you?');
  synth.spoken[1].onend();
  assert.equal(speaker.speaking, false);
  assert.equal(speaker.currentText, '');
  assert.equal(synth.spoken.length, 2);
});

test('createSpeaker queues streaming fragments until a sentence completes', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('Hel');
  speaker.push('lo. Wor');
  speaker.push('ld.');
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.spoken[0].text, 'Hello.');
  synth.spoken[0].onend();
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[1].text, 'World.');
});

test('createSpeaker flush speaks the remaining partial buffer', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('Streamed without');
  assert.equal(synth.spoken.length, 0);
  assert.equal(speaker.speaking, false);
  speaker.push(' punctuation yet');
  speaker.flush();
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.spoken[0].text, 'Streamed without punctuation yet');
});

test('createSpeaker flush queues behind the utterance already speaking', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('First.');
  speaker.push('Second without end');
  speaker.flush();
  assert.equal(synth.spoken.length, 1);
  synth.spoken[0].onend();
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[1].text, 'Second without end');
});

test('createSpeaker applies lang, rate, pitch, volume, and an explicit voice', () => {
  const voice = { name: 'Test EN', lang: 'en-US', localService: true };
  const synth = createFakeSynth();
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    lang: 'en-GB',
    rate: 1.25,
    pitch: 0.9,
    volume: 0.5,
    voice,
  });
  speaker.push('Hi there.');
  const utterance = synth.spoken[0];
  assert.equal(utterance.lang, 'en-GB');
  assert.equal(utterance.rate, 1.25);
  assert.equal(utterance.pitch, 0.9);
  assert.equal(utterance.volume, 0.5);
  assert.equal(utterance.voice, voice);
});

test('createSpeaker resolves voices lazily, per utterance', () => {
  let available = [];
  const synth = createFakeSynth();
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    lang: 'fr-FR',
    voices: () => available,
  });
  speaker.push('Bonjour.');
  assert.equal(synth.spoken[0].voice, null);
  synth.spoken[0].onend();
  available = [{ name: 'French', lang: 'fr-FR', localService: true }];
  speaker.push('Salut.');
  assert.equal(synth.spoken[1].voice, available[0]);
});

test('createSpeaker accepts a static voices array', () => {
  const voice = { name: 'Array EN', lang: 'en-US', localService: true };
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance, voices: [voice] });
  speaker.push('Hello.');
  assert.equal(synth.spoken[0].voice, voice);
});

test('createSpeaker reports starts, ends, errors, and advances on each', () => {
  const events = [];
  const synth = createFakeSynth();
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    onstart: (text) => events.push('start:' + text),
    onend: (text) => events.push('end:' + text),
    onerror: (error) => events.push('error:' + (error && error.message)),
  });
  speaker.push('One. Two.');
  assert.deepEqual(events, []);
  synth.spoken[0].onstart();
  assert.deepEqual(events, ['start:One.']);
  synth.spoken[0].onend();
  assert.deepEqual(events, ['start:One.', 'end:One.']);
  assert.equal(speaker.currentText, 'Two.');
  synth.spoken[1].onerror(new Error('boom'));
  assert.deepEqual(events, ['start:One.', 'end:One.', 'error:boom']);
  assert.equal(speaker.speaking, false);
  // A late onend from the same utterance must not advance twice.
  synth.spoken[1].onend();
  assert.equal(events.length, 3);
});

test('createSpeaker survives throwing event listeners', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    onend: () => {
      throw new Error('listener failure');
    },
    onstart: () => {
      throw new Error('listener failure');
    },
  });
  speaker.push('One. Two.');
  assert.doesNotThrow(() => synth.spoken[0].onstart());
  assert.doesNotThrow(() => synth.spoken[0].onend());
  assert.equal(synth.spoken.length, 2);
  assert.equal(speaker.currentText, 'Two.');
});

test('createSpeaker publishes aggregate speaking state through onState', () => {
  const states = [];
  const synth = createFakeSynth();
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    onState: (state) => states.push({ speaking: state.speaking, text: state.currentText }),
  });
  speaker.push('One. Two.');
  assert.deepEqual(states[0], { speaking: true, text: 'One.' });
  synth.spoken[0].onend();
  // End of One, start of Two: never observed as "not speaking" between them.
  assert.deepEqual(states.slice(-1)[0], { speaking: true, text: 'Two.' });
  synth.spoken[1].onend();
  assert.deepEqual(states.slice(-1)[0], { speaking: false, text: '' });
  speaker.push('Three.');
  assert.deepEqual(states.slice(-1)[0], { speaking: true, text: 'Three.' });
  speaker.stop();
  assert.deepEqual(states.slice(-1)[0], { speaking: false, text: '' });
  // A throwing state listener cannot break the queue.
  const resilient = createSpeaker({
    synth: createFakeSynth(),
    Utterance: FakeUtterance,
    onState: () => {
      throw new Error('state listener failure');
    },
  });
  assert.doesNotThrow(() => resilient.push('Fine.'));
  assert.equal(resilient.speaking, true);
});

test('createSpeaker stop cancels everything and clears the queue', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('One. Two. Three.');
  assert.equal(synth.spoken.length, 1);
  const first = synth.spoken[0];
  speaker.stop();
  assert.equal(synth.cancelCalls, 1);
  assert.equal(speaker.speaking, false);
  assert.equal(speaker.currentText, '');
  // Handlers are detached, so a late browser callback cannot advance the queue.
  if (first.onend) first.onend();
  assert.equal(synth.spoken.length, 1);
  // The speaker remains usable after a barge-in stop.
  speaker.push('Again.');
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[1].text, 'Again.');
});

test('createSpeaker stop is safe when cancel synchronously fires onend', () => {
  let endCalls = 0;
  const synth = {
    spoken: [],
    speak(utterance) {
      synth.spoken.push(utterance);
    },
    cancel() {
      for (const utterance of synth.spoken) {
        if (utterance.onend) {
          endCalls += 1;
          utterance.onend();
        }
      }
    },
  };
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('One. Two.');
  speaker.stop();
  assert.equal(synth.spoken.length, 1);
  assert.equal(endCalls, 0);
  assert.equal(speaker.speaking, false);
});

test('createSpeaker dispose is final and idempotent', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('One.');
  speaker.dispose();
  assert.equal(synth.cancelCalls, 1);
  const spokenBefore = synth.spoken.length;
  speaker.push('Ignored.');
  speaker.flush();
  assert.equal(synth.spoken.length, spokenBefore);
  speaker.dispose();
  assert.equal(synth.cancelCalls, 1);
});

test('createSpeaker skips empty and letterless chunks', () => {
  const synth = createFakeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  speaker.push('');
  speaker.push('   ');
  speaker.push('***');
  speaker.push('---');
  assert.equal(synth.spoken.length, 0);
  speaker.flush();
  assert.equal(synth.spoken.length, 0);
  speaker.push('Ok.');
  assert.equal(synth.spoken.length, 1);
});

test('createSpeaker is safe headlessly without browser globals', () => {
  const speaker = createSpeaker({});
  assert.equal(speaker.speaking, false);
  assert.equal(speaker.currentText, '');
  assert.doesNotThrow(() => {
    speaker.push('Hello. World');
    speaker.flush();
    speaker.stop();
    speaker.dispose();
  });
  assert.equal(speaker.speaking, false);
});

test('createSpeaker recovers when synth.speak throws', () => {
  const errors = [];
  let calls = 0;
  const synth = {
    speak() {
      calls += 1;
      throw new Error('speech unavailable');
    },
    cancel() {},
  };
  const speaker = createSpeaker({
    synth,
    Utterance: FakeUtterance,
    onerror: (error) => errors.push(error.message),
  });
  assert.doesNotThrow(() => speaker.push('One. Two.'));
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['speech unavailable', 'speech unavailable']);
  assert.equal(speaker.speaking, false);
});

/* ------------------------------------------------------------------------- *
 * Build contract
 * ------------------------------------------------------------------------- */

test('engine module exports exactly the five public helpers', () => {
  assert.deepEqual(Object.keys(engineModule).sort(), [
    'createSpeaker',
    'looksLikeEcho',
    'pickVoice',
    'splitSentences',
    'stripMarkdown',
  ]);
});

test('engine source keeps the build-script contract', () => {
  const source = readFileSync(new URL('../src/engine.mjs', import.meta.url), 'utf8');
  const lines = source.split('\n');

  const exportedLines = lines.filter((line) => line.startsWith('export '));
  assert.equal(exportedLines.length, 5, 'exactly five exported declarations');
  for (const line of exportedLines) {
    assert.match(line, /^export function [A-Za-z]+\(/);
  }
  assert.ok(!/^export\s+default\b/m.test(source), 'no export default');
  assert.ok(!/^export\s*\{/m.test(source), 'no export { }');
  assert.ok(!/^import\b/m.test(source), 'no static imports');
  assert.ok(
    lines.every((line) => !/^export(?![ ])/.test(line)),
    'every export line uses a single trailing space'
  );

  // Simulate scripts/build.mjs: strip the leading "export " and execute the
  // result as a classic browser script.
  const classic = source.replace(/^export /gm, '');
  assert.ok(classic.split('\n').every((line) => !line.startsWith('export ')));
  assert.doesNotThrow(() => {
    const runClassic = new Function(classic);
    runClassic();
  });
});
