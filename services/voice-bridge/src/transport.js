/**
 * Discord voice transport.
 *
 * One transport instance = one bot identity in one voice channel. A second
 * agent is a second process with its own config/token, so several agents
 * (whalechan, Hermes, ...) and the operator can share one channel.
 *
 * Responsibilities:
 *  - join/leave the configured voice channel (selfDeaf MUST be false: Discord
 *    withholds voice packets from deafened clients);
 *  - subscribe to the OPERATOR's audio only and decode Opus -> 48 kHz stereo PCM;
 *  - play raw 48 kHz stereo PCM into the channel (barge-in = player.stop());
 *  - survive voice disconnects (resume, else rejoin).
 *
 * The `voice` and `prism` libraries are injected so unit tests can fake them
 * and never open a socket.
 */
import { Readable } from 'node:stream';
import * as defaultVoice from '@discordjs/voice';
import defaultPrism from 'prism-media';

export const JOIN_READY_TIMEOUT_MS = 15000;
export const RESUME_TIMEOUT_MS = 5000;

export function buildJoinOptions({ config, guild }) {
  return {
    channelId: config.voiceChannelId,
    guildId: config.guildId,
    adapterCreator: guild.voiceAdapterCreator,
    // Receiving requires NOT being self-deafened; Discord sends no packets to
    // deafened clients. selfMute is cosmetic (config.selfMute, default false).
    selfDeaf: false,
    selfMute: Boolean(config.selfMute),
  };
}

/**
 * Decide what to do with a speaker in the channel.
 *
 * Returns "capture" only for the operator: never a bot (self, whalechan,
 * Hermes, ...), never an explicitly ignored user.
 */
export function classifySpeaker(userId, config, { isBot = false } = {}) {
  if (!userId) return 'ignore';
  if (config.ignoreUserIds?.includes(userId)) return 'ignore';
  if (config.ignoreBotIds?.includes(userId)) return 'ignore';
  if (isBot) return 'ignore-bot';
  if (userId === config.operatorUserId) return 'capture';
  return 'ignore';
}

export function createTransport({
  client,
  config,
  logger,
  voice = defaultVoice,
  prism = defaultPrism,
} = {}) {
  let connection = null;
  let player = null;
  let playerSubscription = null;
  let opusStream = null;
  let decoder = null;
  let leaving = false;
  let joining = null;
  let lastJoinOptions = null;
  const pcmListeners = new Set();
  const speakingListeners = new Set();

  const state = {
    connected: false,
    playing: false,
    channelId: null,
    status: 'idle',
  };

  function onOperatorPcm(listener) {
    pcmListeners.add(listener);
    return () => pcmListeners.delete(listener);
  }

  function onSpeaking(listener) {
    speakingListeners.add(listener);
    return () => speakingListeners.delete(listener);
  }

  function emitPcm(pcm) {
    for (const listener of pcmListeners) {
      try {
        listener(pcm);
      } catch (error) {
        logger?.error?.('operator PCM listener failed', error);
      }
    }
  }

  function isBotUser(userId) {
    try {
      const user = client?.users?.cache?.get?.(userId);
      if (user && typeof user.bot === 'boolean') return user.bot;
      const member = client?.guilds?.cache?.get?.(config.guildId)?.members?.cache?.get?.(userId);
      if (member?.user && typeof member.user.bot === 'boolean') return member.user.bot;
    } catch {
      /* cache misses are fine */
    }
    return false;
  }

  function describeUser(userId) {
    const user = client?.users?.cache?.get?.(userId);
    if (!user) return userId;
    return user.tag ?? user.username ?? userId;
  }

  async function fetchGuildAndChannel() {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.voiceChannelId);
    if (!channel) {
      throw new Error(
        `voice channel ${config.voiceChannelId} not found in guild ${config.guildId} ` +
          '(check ids and that the bot can see the channel)',
      );
    }
    if (typeof channel.isVoiceBased === 'function' && !channel.isVoiceBased()) {
      logger?.warn?.(`channel ${config.voiceChannelId} is not a voice channel`);
    }
    return { guild, channel };
  }

  function attachConnectionHandlers(activeConnection) {
    activeConnection.on?.('stateChange', (oldState, newState) => {
      if (connection !== activeConnection) return;
      state.status = newState.status;
      state.connected = newState.status === voice.VoiceConnectionStatus.Ready;
      logger?.info?.(`voice state: ${oldState.status} -> ${newState.status}`);

      if (newState.status === voice.VoiceConnectionStatus.Disconnected) {
        void recoverDisconnected(activeConnection);
      }
      if (newState.status === voice.VoiceConnectionStatus.Destroyed) {
        state.connected = false;
        state.playing = false;
      }
    });
    activeConnection.on?.('error', (error) => {
      if (connection !== activeConnection) return;
      logger?.error?.(`voice connection error: ${error.message}`);
    });
    // DAVE decryption, UDP and WebSocket diagnostics only surface on 'debug'.
    activeConnection.on?.('debug', (message) => {
      if (connection !== activeConnection) return;
      logger?.debug?.(`voice debug: ${message}`);
    });
  }

  async function recoverDisconnected(activeConnection) {
    if (leaving) return;
    if (!activeConnection.rejoin) activeConnection.rejoin = { inFlight: false };
    if (activeConnection.rejoin.inFlight) return;
    activeConnection.rejoin.inFlight = true;
    try {
      // A websocket close is often transient: resume signalling first.
      await Promise.race([
        voice.entersState(activeConnection, voice.VoiceConnectionStatus.Signalling, RESUME_TIMEOUT_MS),
        voice.entersState(activeConnection, voice.VoiceConnectionStatus.Connecting, RESUME_TIMEOUT_MS),
      ]);
      logger?.info?.('voice connection resumed');
    } catch {
      if (leaving) return;
      logger?.warn?.('voice resume failed; rejoining channel');
      try {
        activeConnection.destroy?.();
      } catch {
        /* already destroyed */
      }
      if (connection === activeConnection) connection = null;
      try {
        await join();
      } catch (error) {
        logger?.error?.(`voice rejoin failed: ${error.message}`);
      }
    } finally {
      activeConnection.rejoin.inFlight = false;
    }
  }

  function attachReceiver() {
    if (!connection) return;
    try {
      opusStream = connection.receiver.subscribe(config.operatorUserId, {
        end: { behavior: voice.EndBehaviorType.Manual },
      });
    } catch (error) {
      logger?.error?.(`failed to subscribe to operator audio: ${error.message}`);
      return;
    }
    decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.on?.('error', (error) => logger?.warn?.(`opus receive stream error: ${error.message}`));
    decoder.on?.('error', (error) => logger?.warn?.(`opus decode error: ${error.message}`));
    opusStream.pipe(decoder);
    let pcmFrames = 0;
    let pcmBytes = 0;
    let statsAt = Date.now();
    decoder.on('data', (pcm) => {
      pcmFrames += 1;
      pcmBytes += pcm.length;
      const now = Date.now();
      if (now - statsAt >= 2000) {
        logger?.info?.(`pcm receive: ${pcmFrames} frames / ${pcmBytes} bytes in ${now - statsAt} ms`);
        pcmFrames = 0;
        pcmBytes = 0;
        statsAt = now;
      }
      emitPcm(pcm);
    });

    const speaking = connection.receiver.speaking;
    speaking?.on?.('start', (userId) => {
      const disposition = classifySpeaker(userId, config, { isBot: isBotUser(userId) });
      if (disposition === 'capture') {
        logger?.info?.(`speaker: ${describeUser(userId)} (operator, capturing)`);
      } else {
        logger?.debug?.(
          `speaker: ${describeUser(userId)} (ignored: ${disposition === 'ignore-bot' ? 'bot' : 'not operator'})`,
        );
      }
      for (const listener of speakingListeners) {
        try {
          listener({ userId, disposition });
        } catch (error) {
          logger?.error?.('speaking listener failed', error);
        }
      }
    });
  }

  function detachReceiver() {
    try {
      opusStream?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      decoder?.destroy?.();
    } catch {
      /* ignore */
    }
    opusStream = null;
    decoder = null;
  }

  function ensurePlayer() {
    if (player) return player;
    player = voice.createAudioPlayer({
      behaviors: { noSubscriber: voice.NoSubscriberBehavior?.Pause ?? 'pause' },
    });
    player.on('stateChange', (oldState, newState) => {
      state.playing = newState.status === voice.AudioPlayerStatus.Playing;
      logger?.debug?.(`player state: ${oldState.status} -> ${newState.status}`);
    });
    if (connection) playerSubscription = connection.subscribe(player) ?? null;
    return player;
  }

  function detachPlayer() {
    try {
      player?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      playerSubscription?.unsubscribe?.();
    } catch {
      /* ignore */
    }
    try {
      player?.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    player = null;
    playerSubscription = null;
    state.playing = false;
  }

  async function join() {
    if (joining) return joining;
    joining = (async () => {
      leaving = false;
      const { guild } = await fetchGuildAndChannel();
      lastJoinOptions = buildJoinOptions({ config, guild });
      logger?.info?.(
        `joining voice channel ${config.voiceChannelId} in guild ${config.guildId}`,
      );
      connection = voice.joinVoiceChannel(lastJoinOptions);
      attachConnectionHandlers(connection);
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, JOIN_READY_TIMEOUT_MS);
      state.connected = true;
      state.status = voice.VoiceConnectionStatus.Ready;
      state.channelId = config.voiceChannelId;
      ensurePlayer();
      attachReceiver();
      logger?.info?.('voice connection ready');
      return { ...state };
    })().finally(() => {
      joining = null;
    });
    return joining;
  }

  async function leave() {
    leaving = true;
    detachReceiver();
    detachPlayer();
    if (connection) {
      try {
        connection.destroy?.();
      } catch (error) {
        logger?.warn?.(`voice connection destroy failed: ${error.message}`);
      }
    }
    connection = null;
    state.connected = false;
    state.playing = false;
    state.status = 'idle';
    state.channelId = null;
    logger?.info?.('left the voice channel');
    return { ...state };
  }

  /** Play 48 kHz stereo s16le PCM. Stops whatever is playing (barge-in). */
  function play(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      throw new Error('play() needs a non-empty PCM buffer');
    }
    if (!connection || !state.connected) throw new Error('not connected to a voice channel');
    const activePlayer = ensurePlayer();
    if (activePlayer.state.status !== voice.AudioPlayerStatus.Idle) {
      activePlayer.stop();
    }
    const resource = voice.createAudioResource(Readable.from([pcm]), {
      inputType: voice.StreamType.Raw,
    });
    activePlayer.play(resource);
    logger?.debug?.(`playing ${(pcm.length / (48000 * 2 * 2) * 1000).toFixed(0)} ms of PCM`);
    return { started: true };
  }

  function stopPlaying() {
    if (!player) return { stopped: false };
    try {
      player.stop();
    } catch (error) {
      logger?.warn?.(`player stop failed: ${error.message}`);
    }
    state.playing = false;
    return { stopped: true };
  }

  return {
    join,
    leave,
    play,
    stopPlaying,
    onOperatorPcm,
    onSpeaking,
    getState: () => ({ ...state }),
    get connection() {
      return connection;
    },
  };
}
