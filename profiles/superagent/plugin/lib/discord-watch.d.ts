import { E as ChannelRef, l as OutboundMessage, q as Trigger } from "./intake-COTOxWe5.js";
import { _ as ContextMessage, g as ChannelLinks, h as ChannelLink, t as SourceContext, v as SourceKind, y as ThreadContext } from "./host-DW-ftTeT.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/discord.d.ts
declare const SOURCE = "discord";
/** A failure of the Discord REST API; `status` is its HTTP status, so a caller can tell a gone channel from a retryable one. */
declare class DiscordError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, status?: number | undefined);
}
/** A configuration failure that needs a person, such as a bot token file that is unnamed, missing, unreadable or empty. */
declare class DiscordConfigError extends Error {}
/** Reads the bot token from its file, naming the path but never the token when the file is missing or unreadable. */
declare function readDiscordToken(path: string): Promise<string>;
/** Turns a time in milliseconds into the snowflake for that instant, as Discord's pagination is documented. */
declare function discordSnowflake(time: number): string;
declare const ChannelSchema: z.ZodObject<{
  id: z.ZodString;
  type: z.ZodOptional<z.ZodNumber>;
  guild_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  parent_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  thread_metadata: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    create_timestamp: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    archived: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$loose>>>;
}, z.core.$loose>;
type DiscordChannel = z.infer<typeof ChannelSchema>;
declare const MessageSchema: z.ZodObject<{
  id: z.ZodString;
  channel_id: z.ZodString;
  timestamp: z.ZodString;
  content: z.ZodDefault<z.ZodString>;
  author: z.ZodObject<{
    id: z.ZodString;
    username: z.ZodOptional<z.ZodString>;
    global_name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    bot: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$loose>;
  message_reference: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    message_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    channel_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    guild_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$loose>>>;
  mentions: z.ZodDefault<z.ZodArray<z.ZodObject<{
    id: z.ZodString;
  }, z.core.$loose>>>;
}, z.core.$loose>;
type DiscordMessage = z.infer<typeof MessageSchema>;
/** A read message as the model-facing context format; attachments are not included, so empty content stays empty. */
declare function discordMessage(message: DiscordMessage): ContextMessage;
declare const ConfigSchema: z.ZodObject<{
  tokenFile: z.ZodDefault<z.ZodString>;
  channels: z.ZodDefault<z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    listen: z.ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, z.core.$strict>>>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
type DiscordConfig = z.infer<typeof ConfigSchema>;
/** The stable Trigger id of one Discord message, equal for every read path that sees it. */
declare const discordTriggerId: (messageId: string) => string;
/** The reply address of one Discord message; it carries the bot token file, the one fact a send needs that settings do not pass it. */
declare const discordChannel: (message: DiscordMessage, channel: DiscordChannel, tokenFile?: string) => ChannelRef;
/**
 * Translates one message of `channel` into a Trigger, or returns undefined for the bot's own messages. A message in a
 * thread channel belongs to the domain Thread of that channel; one in a normal channel belongs to the conversation of
 * the message it answers, or of itself when it answers nothing.
 */
declare function discordTrigger(input: unknown, me: string, channel: DiscordChannel, tokenFile?: string): Trigger | undefined;
/** The source-native parts of a Trigger that Discord reads use; `channelId` is the channel the message was posted in. */
interface DiscordRef {
  channelId: string;
  messageId: string;
  threadId?: string;
  parentId?: string;
  guildId?: string;
  rootId?: string;
  replyToId?: string;
  referenceChannelId?: string;
}
/** Reads a Trigger's Discord references, or returns undefined for another Source's Trigger or one without a location. */
declare function discordRef(trigger: Trigger): DiscordRef | undefined;
/**
 * Context reader for a Discord Trigger: the pages of its thread channel, the Thread's root message, or the message the
 * Trigger replies to. A normal channel's root conversation is its messages before the Trigger followed by the Trigger.
 */
declare const discordThreadContext: ThreadContext<DiscordConfig>;
/**
 * One polling round: the bot's own id, the configured channels, and the active threads under them. Each channel or
 * thread fails independently; the round reports what could not be read after everything it could read ran.
 */
declare function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<{
  read: number;
  unreadable: number;
}>;
/**
 * Posts a message to a Discord channel, replying under the Trigger's message. The deterministic `nonce` with
 * `enforce_nonce` makes Discord return the message it already created for this id instead of posting a second one,
 * so an Outbox retry after a lost response does not duplicate it. A permanent 403 or 404 drops the message (`gone`);
 * a rate limit or server error throws so the Outbox retries.
 */
declare function sendDiscord(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
/** The Discord deep link of a message's address; the Trigger's own URL is preferred when it has one. */
declare function discordLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink;
/** The Discord source kind: configuration, receiving scope, replies, assessment context, search, Policy and environment. */
declare const discordKind: SourceKind<DiscordConfig>;
/**
 * Polls Discord while the Source is enabled, waiting for setup, following the switch, and reporting its declared health
 * entry; a token file problem is reported at once because only a person can fix it, while failed polls count to an error.
 */
declare function watch(ctx: SourceContext, signal: AbortSignal): Promise<void>;
declare const name = "dsh-superagent-discord";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { DiscordChannel, DiscordConfig, DiscordConfigError, DiscordError, DiscordMessage, DiscordRef, SOURCE, apply, discordChannel, discordKind, discordLink, discordMessage, discordRef, discordSnowflake, discordThreadContext, discordTrigger, discordTriggerId, inject, name, pollRound, readDiscordToken, sendDiscord, watch };