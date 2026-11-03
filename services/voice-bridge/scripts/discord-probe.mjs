#!/usr/bin/env node
/**
 * Read-only Discord inspector: fills in the ids a voice-bridge config needs.
 *
 *   node scripts/discord-probe.mjs --token-file ~/.config/dsh-superagent/discord-token [--guild-id <id>]
 *
 * Prints, without ever printing the token:
 *   - which bot the token belongs to;
 *   - the guilds the bot is in (id + name);
 *   - text channels and voice/stage channels per guild (id + name);
 *   - who is currently in voice (user id + channel id) and whether the bot
 *     itself already has a voice connection.
 *
 * It connects to the gateway (read-only: no voice join, no messages) and exits.
 * Use this to pick guildId, voiceChannelId and (while the operator is in the
 * voice channel) operatorUserId.
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { Client, GatewayIntentBits } from 'discord.js';

function parseArgs(argv) {
  const args = { tokenFile: null, guildId: null, withMembers: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--token-file') args.tokenFile = argv[++index];
    else if (arg.startsWith('--token-file=')) args.tokenFile = arg.slice('--token-file='.length);
    else if (arg === '--guild-id') args.guildId = argv[++index];
    else if (arg === '--with-members') args.withMembers = true;
    else if (arg.startsWith('--guild-id=')) args.guildId = arg.slice('--guild-id='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const CHANNEL_TYPES = {
  0: 'text',
  2: 'voice',
  4: 'category',
  5: 'announcement',
  13: 'stage',
  15: 'forum',
  16: 'media',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tokenFile) {
    console.log('Usage: node scripts/discord-probe.mjs --token-file <path> [--guild-id <id>]');
    process.exit(args.help ? 0 : 2);
  }

  const token = (await readFile(args.tokenFile, 'utf8')).trim();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  try {
    await client.login(token);
    console.log(`bot: ${client.user.tag} (${client.user.id})`);

    const guilds = args.guildId
      ? [await client.guilds.fetch(args.guildId)]
      : [...(await client.guilds.fetch()).values()];

    for (const partial of guilds) {
      const guild = await client.guilds.fetch(partial.id);
      console.log(`\nguild: ${guild.id} "${guild.name}"`);

      const channels = await guild.channels.fetch();
      for (const channel of [...channels.values()].sort((a, b) => a.position - b.position)) {
        const type = CHANNEL_TYPES[channel.type] ?? `type-${channel.type}`;
        if (type === 'voice' || type === 'stage') {
          console.log(`  ${type.padEnd(6)} ${channel.id}  "${channel.name}"`);
        } else if (type === 'text') {
          console.log(`  ${type.padEnd(6)} ${channel.id}  "${channel.name}"`);
        } else {
          console.log(`  ${type.padEnd(6)} ${channel.id}  "${channel.name}"`);
        }
      }

      const voiceStates = [...guild.voiceStates.cache.values()];
      console.log(`  voice states (${voiceStates.length}):`);
      for (const state of voiceStates) {
        const member = guild.members.cache.get(state.id);
        const name = member?.user?.tag ?? `user-${state.id}`;
        console.log(
          `    channel ${state.channelId}  ${name} (${state.id})` +
            `${state.selfMute ? ' selfMute' : ''}${state.selfDeaf ? ' selfDeaf' : ''}` +
            `${state.id === client.user.id ? '  <-- this bot' : ''}`,
        );
      }

      if (args.withMembers) {
        // Requires the privileged GUILD_MEMBERS intent; without it the fetch
        // never resolves, so it is opt-in and time-boxed.
        try {
          const members = await Promise.race([
            guild.members.fetch(),
            new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (members === null) throw new Error('timed out (GUILD_MEMBERS intent enabled?)');
          console.log(`  members (${members.size}):`);
          for (const member of members.values()) {
            console.log(
              `    ${member.user.tag} (${member.user.id})${member.user.bot ? ' [bot]' : ''}`,
            );
          }
        } catch (error) {
          console.log(`  members: unavailable (${error.message.split('\n')[0]})`);
        }
      } else {
        console.log('  members: skipped (pass --with-members and enable the GUILD_MEMBERS intent)');
      }
    }
  } finally {
    client.destroy();
  }
}

await main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});
