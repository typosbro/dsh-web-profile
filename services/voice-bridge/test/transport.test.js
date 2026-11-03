import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  buildJoinOptions,
  classifySpeaker,
  createTransport,
} from '../src/transport.js';

const OPERATOR_ID = '100000000000000001';
const OTHER_USER_ID = '100000000000000002';
const OTHER_BOT_ID = '100000000000000003';

function baseConfig(overrides = {}) {
  return {
    guildId: '200000000000000001',
    voiceChannelId: '300000000000000001',
    operatorUserId: OPERATOR_ID,
    ignoreUserIds: [],
    ignoreBotIds: [],
    selfMute: false,
    ...overrides,
  };
}

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'signalling' };
    this.destroyed = false;
    this.subscribedPlayer = null;
    this.receiver = {
      subscribe: (userId, options) => {
        this.subscription = { userId, options };
        this.opusStream = new PassThrough();
        return this.opusStream;
      },
      speaking: new EventEmitter(),
    };
  }

  subscribe(player) {
    this.subscribedPlayer = player;
    return { unsubscribe: () => { this.subscribedPlayer = null; } };
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle' };
    this.playCalls = [];
    this.stopCalls = 0;
  }

  play(resource) {
    this.playCalls.push(resource);
    this.state = { status: 'playing' };
    this.emit('stateChange', { status: 'idle' }, { status: 'playing' });
  }

  stop() {
    this.stopCalls += 1;
    this.state = { status: 'idle' };
    this.emit('stateChange', { status: 'playing' }, { status: 'idle' });
  }
}

function createFakeVoice() {
  const connections = [];
  const players = [];
  const calls = { join: [], enters: [], resources: [] };
  const voice = {
    VoiceConnectionStatus: {
      Ready: 'ready',
      Signalling: 'signalling',
      Connecting: 'connecting',
      Disconnected: 'disconnected',
      Destroyed: 'destroyed',
    },
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
    EndBehaviorType: { Manual: 0 },
    StreamType: { Raw: 'raw' },
    NoSubscriberBehavior: { Pause: 'pause' },
    joinVoiceChannel: (options) => {
      calls.join.push(options);
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    entersState: async (connection, status) => {
      calls.enters.push(status);
      if (status === 'signalling' || status === 'connecting') {
        throw new Error('not resumable');
      }
      return connection;
    },
    createAudioPlayer: () => {
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    createAudioResource: (stream, options) => {
      calls.resources.push({ stream, options });
      return { stream, options };
    },
  };
  return { voice, connections, players, calls };
}

function createFakeClient() {
  const guild = {
    voiceAdapterCreator: { createVoiceAdapter: () => ({}) },
    channels: {
      fetch: async (channelId) => ({ id: channelId, isVoiceBased: () => true }),
    },
  };
  return {
    users: { cache: new Map() },
    guilds: {
      fetch: async () => guild,
      cache: new Map(),
    },
  };
}

function createFakePrism() {
  return {
    opus: {
      Decoder: class FakeDecoder extends PassThrough {},
    },
  };
}

function createFakeLogger() {
  const entries = [];
  return {
    entries,
    debug: (message) => entries.push(['debug', message]),
    info: (message) => entries.push(['info', message]),
    warn: (message) => entries.push(['warn', message]),
    error: (message) => entries.push(['error', message]),
  };
}

function setup(configOverrides = {}) {
  const config = baseConfig(configOverrides);
  const { voice, connections, players, calls } = createFakeVoice();
  const logger = createFakeLogger();
  const transport = createTransport({
    client: createFakeClient(),
    config,
    logger,
    voice,
    prism: createFakePrism(),
  });
  return { config, voice, connections, players, calls, logger, transport };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('buildJoinOptions enables receive (selfDeaf false) and honours selfMute', () => {
  const guild = { voiceAdapterCreator: {} };
  const options = buildJoinOptions({ config: baseConfig(), guild });
  assert.deepEqual(options, {
    channelId: '300000000000000001',
    guildId: '200000000000000001',
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  assert.equal(buildJoinOptions({ config: baseConfig({ selfMute: true }), guild }).selfMute, true);
});

test('classifySpeaker only captures the operator and never bots', () => {
  const config = baseConfig();
  assert.equal(classifySpeaker(OPERATOR_ID, config), 'capture');
  assert.equal(classifySpeaker(OTHER_USER_ID, config), 'ignore');
  assert.equal(classifySpeaker(OTHER_BOT_ID, config, { isBot: true }), 'ignore-bot');
  assert.equal(classifySpeaker(OPERATOR_ID, config, { isBot: true }), 'ignore-bot');
  assert.equal(classifySpeaker(null, config), 'ignore');

  const ignored = baseConfig({ ignoreUserIds: [OTHER_USER_ID] });
  assert.equal(classifySpeaker(OTHER_USER_ID, ignored), 'ignore');

  const ignoredBots = baseConfig({ ignoreBotIds: [OTHER_BOT_ID] });
  assert.equal(classifySpeaker(OTHER_BOT_ID, ignoredBots, { isBot: true }), 'ignore');
});

test('join subscribes to the operator only and decodes audio to PCM', async () => {
  const { transport, calls, connections } = setup();

  let received = null;
  transport.onOperatorPcm((pcm) => {
    received = pcm;
  });

  const state = await transport.join();
  assert.equal(calls.join.length, 1);
  assert.equal(calls.join[0].channelId, '300000000000000001');
  assert.equal(calls.join[0].selfDeaf, false);
  assert.equal(state.connected, true);

  const connection = connections[0];
  assert.equal(connection.subscription.userId, OPERATOR_ID, 'operator-only subscription');
  assert.deepEqual(connection.subscription.options, { end: { behavior: 0 } });
  assert.equal(connection.subscribedPlayer !== null, true, 'player is subscribed to the connection');

  const fakeOpusPacket = Buffer.from([1, 2, 3]);
  connection.opusStream.write(fakeOpusPacket);
  await tick();
  assert.ok(received && received.equals(fakeOpusPacket), 'decoded PCM reaches the listener');
});

test('play sends raw 48 kHz stereo PCM through the audio player', async () => {
  const { transport, calls, players } = setup();
  await transport.join();

  const pcm = Buffer.alloc(3840);
  const result = transport.play(pcm);
  assert.deepEqual(result, { started: true });

  assert.equal(calls.resources.length, 1);
  assert.equal(calls.resources[0].options.inputType, 'raw');
  assert.equal(players[0].playCalls.length, 1);
  assert.equal(transport.getState().playing, true);

  transport.stopPlaying();
  assert.equal(players[0].stopCalls, 1);
  assert.equal(transport.getState().playing, false);
});

test('play before joining throws instead of crashing', () => {
  const { transport } = setup();
  assert.throws(() => transport.play(Buffer.alloc(10)), /not connected/);
});

test('second play interrupts the first (barge-in at the transport layer)', async () => {
  const { transport, players } = setup();
  await transport.join();
  transport.play(Buffer.alloc(3840));
  transport.play(Buffer.alloc(3840));
  assert.equal(players[0].stopCalls, 1);
  assert.equal(players[0].playCalls.length, 2);
});

test('leave destroys the connection and resets state', async () => {
  const { transport, connections } = setup();
  await transport.join();
  const state = await transport.leave();
  assert.equal(connections[0].destroyed, true);
  assert.deepEqual(state, {
    connected: false,
    playing: false,
    channelId: null,
    status: 'idle',
  });
});

test('a dropped voice connection rejoins the channel', async () => {
  const { transport, connections, calls } = setup();
  await transport.join();
  const connection = connections[0];

  connection.emit('stateChange', { status: 'ready' }, { status: 'disconnected' });
  await tick();
  await tick();
  await tick();

  assert.equal(calls.join.length, 2, 'joinVoiceChannel called again after failed resume');
  assert.equal(connection.destroyed, true, 'dead connection is destroyed before rejoin');
  assert.equal(connections.length, 2);
});

test('speaking events log the operator and ignored speakers without capturing them', async () => {
  const { transport, connections, logger } = setup();
  await transport.join();
  const connection = connections[0];

  connection.receiver.speaking.emit('start', OPERATOR_ID);
  connection.receiver.speaking.emit('start', OTHER_USER_ID);

  assert.ok(
    logger.entries.some(([, message]) => message.includes('operator, capturing')),
    'operator speech is logged',
  );
  assert.ok(
    logger.entries.some(([, message]) => message.includes('ignored: not operator')),
    'other speakers are logged as ignored',
  );
});

test('onSpeaking listeners see the disposition', async () => {
  const { transport, connections } = setup();
  await transport.join();
  const seen = [];
  transport.onSpeaking((event) => seen.push(event));
  connections[0].receiver.speaking.emit('start', OTHER_USER_ID);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, OTHER_USER_ID);
  assert.equal(seen[0].disposition, 'ignore');
});
