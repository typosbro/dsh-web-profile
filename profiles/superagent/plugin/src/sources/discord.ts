/** Discord Source: bot-token polling of configured channels, their active threads, replies, and thread reads over the REST v10 API. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { isoTime, key, threadKey, type ChannelRef, type OutboundMessage, type ThreadFact, type Trigger } from '../core/index.ts'
import { validItems } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, ContextMessage, SourceKind, ThreadContext } from './kind.ts'
import { cursorAt, pause } from './poll.ts'

export const SOURCE = 'discord'
const API = 'https://discord.com/api/v10'
/** Discord's epoch in milliseconds; a snowflake's timestamp counts from it, and pagination cursors are built from times. */
const EPOCH = 1420070400000
const SNOWFLAKE = /^\d{17,20}$/
/** Messages per page, Discord's maximum for message listings. */
const PAGE = 100
/** Pages of one channel a poll reads before it keeps its read position and reports the backlog as a failure. */
const PAGE_LIMIT = 10
/** Discord's content limit for one message, in characters. */
const CONTENT_LIMIT = 2000
/** Consecutive failed polls before the Source reports an error; one network failure is retried on the next round. */
const POLL_FAILURES = 3
/** Thread channel types: public and private threads, and threads under announcement channels. */
const THREAD_TYPES = new Set([10, 11, 12])
/** Channel types that carry no messages of their own: a category, and forum and media channels, whose messages are their threads'. */
const MESSAGELESS_TYPES = new Set([4, 15, 16])
const TOKEN_FILE = /^(\/.*)?$/
const USER_AGENT = 'DiscordBot (https://github.com/deepseek-ai/dsh-superagent, 0.1.0)'

/** A failure of the Discord REST API; `status` is its HTTP status, so a caller can tell a gone channel from a retryable one. */
export class DiscordError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
/** A configuration failure that needs a person, such as a bot token file that is unnamed, missing, unreadable or empty. */
export class DiscordConfigError extends Error {}

/** Reads the bot token from its file, naming the path but never the token when the file is missing or unreadable. */
export async function readDiscordToken(path: string): Promise<string> {
  if (!path) throw new DiscordConfigError('The Discord Source names no bot token file; set the bot token file on the Discord Source.')
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error)
    const reason = code === 'ENOENT' ? 'does not exist' : code === 'EACCES' ? 'is not readable' : `cannot be read (${code})`
    throw new DiscordConfigError(`The Discord bot token file ${path} ${reason}.`)
  }
  const token = text.trim()
  if (!token) throw new DiscordConfigError(`The Discord bot token file ${path} is empty.`)
  return token
}

/** Turns a time in milliseconds into the snowflake for that instant, as Discord's pagination is documented. */
export function discordSnowflake(time: number): string {
  return ((BigInt(Math.max(0, Math.floor(time - EPOCH))) << 22n)).toString()
}
/** Orders snowflakes as numbers; they are decimal strings beyond Number's safe range, so compare by length and then lexically. */
function compareIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
}
function newer(a: string, b: string): string { return compareIds(a, b) >= 0 ? a : b }

const ChannelSchema = z.looseObject({
  id: z.string().min(1), type: z.number().int().optional(), guild_id: z.string().nullish(), parent_id: z.string().nullish(), name: z.string().nullish(),
  thread_metadata: z.looseObject({ create_timestamp: z.string().nullish(), archived: z.boolean().optional() }).nullish(),
})
export type DiscordChannel = z.infer<typeof ChannelSchema>
const ThreadsSchema = z.looseObject({ threads: z.array(ChannelSchema).default([]) })
const BotSchema = z.looseObject({ id: z.string().min(1), username: z.string().optional() })
const MessageSchema = z.looseObject({
  id: z.string().min(1), channel_id: z.string().min(1), timestamp: z.string().min(1), content: z.string().default(''),
  author: z.looseObject({ id: z.string().min(1), username: z.string().optional(), global_name: z.string().nullish(), bot: z.boolean().optional() }),
  message_reference: z.looseObject({ message_id: z.string().nullish(), channel_id: z.string().nullish(), guild_id: z.string().nullish() }).nullish(),
  mentions: z.array(z.looseObject({ id: z.string() })).default([]),
})
export type DiscordMessage = z.infer<typeof MessageSchema>
const ChannelPageSchema = z.array(z.unknown())

const threadChannel = (channel: DiscordChannel): boolean => THREAD_TYPES.has(channel.type ?? -1)
/** Discord shows the author's global name before the username; the actor stays the user id. */
const authorName = (author: DiscordMessage['author']): string => author.global_name || author.username || author.id

/**
 * Requests one Discord REST endpoint, validating the JSON body and turning an HTTP failure into a DiscordError that
 * carries its status; the bot token is sent only in the Authorization header and never appears in an error.
 */
async function discord<T>(token: string, method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json',
      'User-Agent': USER_AGENT }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  } catch (error) {
    throw new DiscordError(`Discord ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    // Discord's error body names the cause (such as an unknown channel); it never contains credentials.
    const detail = await response.text().catch(() => '')
    throw new DiscordError(`Discord ${method} ${path} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`, response.status)
  }
  if (response.status === 204) return undefined as T
  let value: unknown
  try { value = await response.json() } catch (error) {
    throw new DiscordError(`Discord ${method} ${path} returned an unreadable body: ${error instanceof Error ? error.message : String(error)}`, response.status)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new DiscordError(`Discord ${method} ${path} returned an unexpected response: ${parsed.error.message.slice(0, 500)}`, response.status)
  return parsed.data
}
const getChannel = (token: string, id: string): Promise<DiscordChannel> => discord(token, 'GET', `/channels/${id}`, ChannelSchema)
const activeThreads = (token: string, guild: string): Promise<DiscordChannel[]> =>
  discord(token, 'GET', `/guilds/${guild}/threads/active`, ThreadsSchema).then(page => page.threads)

/** A read message as the model-facing context format; attachments are not included, so empty content stays empty. */
export function discordMessage(message: DiscordMessage): ContextMessage {
  const reference = message.message_reference
  return { id: message.id, from: authorName(message.author), at: isoTime(message.timestamp), text: message.content,
    ...message.author.bot ? { bot: true as const } : {},
    ...reference?.message_id ? { reply_to: reference.message_id } : {} }
}

const ConfigSchema = z.object({
  /** Absolute path of the file that holds the bot token; the token itself is never part of settings. */
  tokenFile: z.string().trim().regex(TOKEN_FILE, 'An absolute path').default(''),
  channels: z.array(z.object({ id: z.string().regex(SNOWFLAKE, 'A Discord channel id'), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate channel IDs').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(10),
}).strict()
export type DiscordConfig = z.infer<typeof ConfigSchema>

/** The stable Trigger id of one Discord message, equal for every read path that sees it. */
export const discordTriggerId = (messageId: string): string => key(SOURCE, messageId)
/** The reply address of one Discord message; it carries the bot token file, the one fact a send needs that settings do not pass it. */
export const discordChannel = (message: DiscordMessage, channel: DiscordChannel, tokenFile = ''): ChannelRef => ({
  source: SOURCE, thread: `discord:${threadChannel(channel) ? channel.id : `${message.channel_id}:${message.message_reference?.message_id ?? message.id}`}`,
  address: { channelId: message.channel_id, messageId: message.id, ...channel.parent_id ? { parentId: channel.parent_id } : {},
    ...channel.guild_id ? { guildId: channel.guild_id } : {}, ...tokenFile ? { tokenFile } : {} },
})
/**
 * Translates one message of `channel` into a Trigger, or returns undefined for the bot's own messages. A message in a
 * thread channel belongs to the domain Thread of that channel; one in a normal channel belongs to the conversation of
 * the message it answers, or of itself when it answers nothing.
 */
export function discordTrigger(input: unknown, me: string, channel: DiscordChannel, tokenFile = ''): Trigger | undefined {
  const message = MessageSchema.parse(input)
  if (message.author.id === me) return undefined
  const root = message.message_reference?.message_id ?? message.id
  const thread = threadChannel(channel) ? channel.id : `${message.channel_id}:${root}`
  const mentioned = message.mentions.some(mention => mention.id === me)
  const url = channel.guild_id ? `https://discord.com/channels/${channel.guild_id}/${message.channel_id}/${message.id}` : undefined
  return { id: discordTriggerId(message.id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.author.id }, human: !message.author.bot,
    ...mentioned ? { addressed: 'mention' as const } : {},
    at: isoTime(message.timestamp), text: message.content, channel: discordChannel(message, channel, tokenFile),
    ...url ? { url } : {},
    meta: { channelId: message.channel_id, messageId: message.id, rootId: root, mentioned, author: authorName(message.author),
      ...threadChannel(channel) ? { threadId: channel.id } : {}, ...channel.parent_id ? { parentId: channel.parent_id } : {},
      ...channel.guild_id ? { guildId: channel.guild_id } : {},
      ...message.message_reference?.message_id ? { replyToId: message.message_reference.message_id,
        ...message.message_reference.channel_id ? { referenceChannelId: message.message_reference.channel_id } : {} } : {} } }
}

/** The source-native parts of a Trigger that Discord reads use; `channelId` is the channel the message was posted in. */
export interface DiscordRef {
  channelId: string
  messageId: string
  threadId?: string
  parentId?: string
  guildId?: string
  rootId?: string
  replyToId?: string
  referenceChannelId?: string
}
/** Reads a Trigger's Discord references, or returns undefined for another Source's Trigger or one without a location. */
export function discordRef(trigger: Trigger): DiscordRef | undefined {
  const meta = trigger.meta as Record<string, unknown>
  if (trigger.source !== SOURCE) return undefined
  const text = (name: string): string | undefined => typeof meta[name] === 'string' && meta[name] ? meta[name] as string : undefined
  const channelId = text('channelId')
  const messageId = text('messageId')
  if (!channelId || !messageId) return undefined
  return { channelId, messageId, ...text('threadId') ? { threadId: text('threadId') } : {}, ...text('parentId') ? { parentId: text('parentId') } : {},
    ...text('guildId') ? { guildId: text('guildId') } : {}, ...text('rootId') ? { rootId: text('rootId') } : {},
    ...text('replyToId') ? { replyToId: text('replyToId') } : {}, ...text('referenceChannelId') ? { referenceChannelId: text('referenceChannelId') } : {} }
}

const NO_MESSAGES: ContextMessage[] = []
function partOf(status: string, messages: ContextMessage[], next?: string): { messages: ContextMessage[]; next?: string; body: Record<string, unknown>; status: string } {
  return { messages, ...next ? { next } : {}, body: { status, messages }, status }
}
/** Reads one message by id, returning undefined when Discord answers that it does not exist. */
async function message(token: string, channelId: string, messageId: string): Promise<DiscordMessage | undefined> {
  try { return await discord(token, 'GET', `/channels/${channelId}/messages/${messageId}`, MessageSchema) }
  catch (error) {
    if (error instanceof DiscordError && error.status === 404) return undefined
    throw error
  }
}
/**
 * Context reader for a Discord Trigger: the pages of its thread channel, the Thread's root message, or the message the
 * Trigger replies to. A normal channel's root conversation is its messages before the Trigger followed by the Trigger.
 */
export const discordThreadContext: ThreadContext<DiscordConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger, part, cursor, config) => {
    const ref = discordRef(trigger)
    if (!ref) throw new Error('A Discord source trigger is required')
    const token = await readDiscordToken(config.tokenFile)
    // A thread's root is the message it was started from, which shares the thread channel's id but lives in the parent.
    const parent = ref.parentId ?? ref.channelId
    const rootId = ref.threadId ?? ref.rootId ?? ref.messageId
    if (part === 'root') {
      const found = await message(token, parent, rootId) ?? (parent !== ref.threadId ? await message(token, ref.threadId ?? parent, rootId) : undefined)
      return found ? partOf('available', [discordMessage(found)]) : partOf('no_root', NO_MESSAGES)
    }
    if (part === 'parent') {
      if (!ref.replyToId) return partOf('no_parent', NO_MESSAGES)
      const found = await message(token, ref.referenceChannelId ?? ref.channelId, ref.replyToId)
      return found ? partOf('available', [discordMessage(found)]) : partOf('no_parent', NO_MESSAGES)
    }
    const channelId = ref.threadId ?? ref.channelId
    if (cursor) {
      // A later page continues after the newest message the previous page held; Discord returns it newest first.
      const page = validItems(MessageSchema, await discord(token, 'GET', `/channels/${channelId}/messages?after=${cursor}&limit=${PAGE}`, ChannelPageSchema))
        .sort((a, b) => compareIds(a.id, b.id))
      const messages = page.map(discordMessage)
      return partOf('available', messages, page.length === PAGE ? page.at(-1)!.id : undefined)
    }
    // The first page holds the messages before the Trigger, oldest first, followed by the Trigger itself.
    const before = validItems(MessageSchema, await discord(token, 'GET', `/channels/${channelId}/messages?before=${ref.messageId}&limit=${PAGE - 1}`,
      ChannelPageSchema)).sort((a, b) => compareIds(a.id, b.id))
    const own = await message(token, channelId, ref.messageId)
    const messages = [...before.map(discordMessage), ...own ? [discordMessage(own)] : []]
    return partOf('available', messages, ref.messageId)
  },
}

/** One message of a point-in-time snapshot; minds nothing beyond what a poll needs. */
type Tally = { read: number; skipped: number }

/** Advances one channel's read position and takes in the messages written after it, oldest first, before moving it. */
async function pollChannel(ctx: SourceContext, token: string, me: string, channel: DiscordChannel, tokenFile: string, signal: AbortSignal | undefined,
  tally: Tally, initial: string): Promise<void> {
  const checkpoint = KV.discord.cursor(channel.id)
  const cursor = ctx.state.get(checkpoint) ?? initial
  let newest = cursor
  const found: DiscordMessage[] = []
  let before: string | undefined
  let complete = false
  // Discord lists messages newest first; read back from now until the read position is covered, then take them in oldest first.
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    if (signal?.aborted) throw new Error('The Discord Source stopped during the poll')
    const listed = await discord(token, 'GET', `/channels/${channel.id}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`, ChannelPageSchema)
    const messages = validItems(MessageSchema, listed, tally).sort((a, b) => compareIds(a.id, b.id))
    // Stop at the beginning of the channel, or once a page reaches into what the Source already read.
    if (!messages.length) { complete = true; break }
    newest = newer(newest, messages.at(-1)!.id)
    found.push(...messages.filter(message => compareIds(message.id, cursor) > 0))
    if (compareIds(messages[0]!.id, cursor) <= 0 || listed.length < PAGE) { complete = true; break }
    before = messages[0]!.id
  }
  // Keeping the read position leaves the backlog to the next round, where it is reported as a failure rather than skipped.
  if (!complete) throw new DiscordError(`Discord returned more than ${PAGE_LIMIT * PAGE} messages for channel ${channel.id}; the read position stays where it was.`)
  found.sort((a, b) => compareIds(a.id, b.id))
  for (const message of found) {
    if (signal?.aborted) throw new Error('The Discord Source stopped during the poll')
    const trigger = discordTrigger(message, me, channel, tokenFile)
    if (!trigger) continue
    await ctx.receive(trigger)
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: channel.name ? `#${channel.name}` : channel.id,
      ...trigger.url ? { url: trigger.url } : {}, facts: { channel: { value: channel.name ? `#${channel.name}` : channel.id } } satisfies Record<string, ThreadFact> })
    tally.read += 1
  }
  // Moving the cursor only now means an interrupted round reads the same messages again; stable ids make that safe.
  ctx.state.set(checkpoint, newest)
}

/** The snowflake a channel read starts from when the Source has not read it before. */
function initialCursor(channel: DiscordChannel, started: string, since: string, discovered: boolean): string {
  if (!discovered) return discordSnowflake(Date.parse(cursorAt(started)))
  // A thread discovered while polling is read from its creation, or from when this process started watching it.
  const created = Date.parse(channel.thread_metadata?.create_timestamp ?? '')
  const watching = Date.parse(since)
  return discordSnowflake(Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(watching) ? watching : 0))
}

/**
 * One polling round: the bot's own id, the configured channels, and the active threads under them. Each channel or
 * thread fails independently; the round reports what could not be read after everything it could read ran.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const config = ctx.config<DiscordConfig>(SOURCE)
  if (!config) throw new Error('The Discord Source is off')
  const token = await readDiscordToken(config.tokenFile)
  const me = (await discord(token, 'GET', '/users/@me', BotSchema)).id
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.discord.since) ?? started
  if (ctx.state.get(KV.discord.since) === undefined) ctx.state.set(KV.discord.since, started)
  const tally: Tally = { read: 0, skipped: 0 }
  const failures: string[] = []
  const channels = new Map<string, DiscordChannel>()
  for (const row of config.channels) {
    if (signal?.aborted) throw new Error('The Discord Source stopped during the poll')
    try {
      const channel = await getChannel(token, row.id)
      channels.set(channel.id, channel)
      // A forum or media channel holds only threads; its posts are read as the active threads below.
      if (!MESSAGELESS_TYPES.has(channel.type ?? -1)) {
        await pollChannel(ctx, token, me, channel, config.tokenFile, signal, tally, initialCursor(channel, started, since, false))
      }
    } catch (error) {
      if (signal?.aborted) throw error
      failures.push(`${row.id}: ${String(error)}`)
    }
  }
  const guilds = new Map<string, Set<string>>()
  for (const channel of channels.values()) {
    if (!channel.guild_id) continue
    const rows = guilds.get(channel.guild_id) ?? new Set<string>()
    rows.add(channel.id)
    guilds.set(channel.guild_id, rows)
  }
  for (const [guild, parents] of guilds) {
    if (signal?.aborted) throw new Error('The Discord Source stopped during the poll')
    try {
      for (const thread of await activeThreads(token, guild)) {
        if (signal?.aborted) throw new Error('The Discord Source stopped during the poll')
        // Only threads under a configured channel are received; their messages name that channel as the row.
        if (!thread.parent_id || !parents.has(thread.parent_id) || channels.has(thread.id)) continue
        try {
          await pollChannel(ctx, token, me, thread, config.tokenFile, signal, tally, initialCursor(thread, started, since, true))
        } catch (error) {
          if (signal?.aborted) throw error
          failures.push(`${thread.id}: ${String(error)}`)
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      failures.push(`threads of ${guild}: ${String(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} Discord reads failed: ${failures.slice(0, 3).join('; ')}`)
  return { read: tally.read, unreadable: tally.skipped }
}

/** Length-capped Discord content: Discord rejects a message over 2000 characters, so a longer report keeps its head. */
function contentOf(text: string): string {
  if (text.length <= CONTENT_LIMIT) return text
  const head = text.slice(0, CONTENT_LIMIT - 1)
  // Do not split a surrogate pair.
  const last = head.charCodeAt(head.length - 1)
  return `${last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head}…`
}
/**
 * Posts a message to a Discord channel, replying under the Trigger's message. The deterministic `nonce` with
 * `enforce_nonce` makes Discord return the message it already created for this id instead of posting a second one,
 * so an Outbox retry after a lost response does not duplicate it. A permanent 403 or 404 drops the message (`gone`);
 * a rate limit or server error throws so the Outbox retries.
 */
export async function sendDiscord(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { channelId, messageId, tokenFile } = message.channel.address
  if (!channelId) throw new Error('Missing Discord reply channel')
  const token = await readDiscordToken(tokenFile ?? '')
  const body = { content: contentOf(message.text), enforce_nonce: true, nonce: key('discord-nonce', message.id).slice(0, 25),
    ...messageId ? { message_reference: { message_id: messageId, fail_if_not_exists: false } } : {} }
  try { await discord(token, 'POST', `/channels/${channelId}/messages`, z.unknown(), body) }
  catch (error) {
    if (error instanceof DiscordError && (error.status === 403 || error.status === 404)) return 'gone'
    throw error
  }
  return 'sent'
}
/** The Discord deep link of a message's address; the Trigger's own URL is preferred when it has one. */
export function discordLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const guild = address.guildId, channel = address.channelId, message = address.messageId
  return { url: guild && channel ? `https://discord.com/channels/${guild}/${channel}${message ? `/${message}` : ''}` : '',
    label: { zh: 'Discord 消息', en: 'Discord message' }, ...message ? { triggerId: discordTriggerId(message) } : {} }
}

/** The Discord source kind: configuration, receiving scope, replies, assessment context, search, Policy and environment. */
export const discordKind: SourceKind<DiscordConfig> = {
  kind: SOURCE,
  title: { zh: 'Discord', en: 'Discord' },
  description: { zh: '接收下列 Discord 频道及其活动子区里发给机器人的消息。', en: 'Receives messages to the bot in these Discord channels and their active threads.' },
  schema: ConfigSchema,
  fields: [
    { key: 'tokenFile', type: 'text', pattern: '/.*', label: { zh: '机器人令牌文件', en: 'Bot token file' },
      hint: { zh: '绝对路径。文件内容就是机器人令牌（只读、不写进设置、界面不显示）。保存后启用来源并重启 dsh-superagent；轮询时读取，换令牌只需改文件内容。', en: 'An absolute path whose content is the bot token; it is never saved in settings or shown in the panel. Enable the Source and restart dsh-superagent after saving. It is read on every poll, so rotating the token needs no restart.' } },
    { key: 'channels', type: 'rows', label: { zh: '接收的频道', en: 'Channels' },
      hint: { zh: '这些频道的消息和它们下面的活动子区都会接收。“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估按规则推断工作。', en: 'Messages in these channels and in their active threads. "@ only" receives messages that mention the bot and Threads with Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '频道 ID', en: 'Channel ID' }, pattern: '[0-9]{17,20}' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
          { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'Discord 的限速规则可能要求更长间隔。', en: 'Discord\'s rate limits may require a longer interval.' } },
  ],
  health: [SOURCE],
  // A message in a configured channel, or in a thread under one, is received; the admission row is the configured channel.
  scope({ meta }, config) {
    const channelId = typeof meta.channelId === 'string' ? meta.channelId : ''
    const parentId = typeof meta.parentId === 'string' ? meta.parentId : ''
    const row = config.channels.find(item => item.id === channelId) ?? config.channels.find(item => item.id === parentId)
    if (!row) return { listened: false, reason: 'channel_not_listed' }
    return { listened: true, observed: row.listen === 'all', row: row.id }
  },
  channel: {
    // A reply goes only to a channel, or a thread under a channel, the Source still receives.
    allowed: (address, config) => config.channels.some(row => row.id === address.channelId || row.id === address.parentId),
    send: sendDiscord,
    link: discordLink,
  },
  threadContext: discordThreadContext,
  // A message link names its channel; its Thread is that thread channel, or the conversation of the message in a normal channel.
  find: query => {
    const link = /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/.exec(query)
    if (link) return { threads: [...new Set([`${SOURCE}:${link[2]}`, ...link[3] ? [`${SOURCE}:${link[2]}:${link[3]}`] : []])], terms: [] }
    const snowflake = /^(\d{17,20})$/.exec(query.trim())
    return snowflake ? { threads: [`${SOURCE}:${snowflake[1]}`], terms: [] } : { threads: [], terms: [] }
  },
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.replyToId === 'string' ? discordTriggerId(trigger.meta.replyToId) : undefined,
  policy: {
    unnamed: { person: { zh: 'Discord 用户', en: 'Discord user' }, bot: { zh: 'Discord 机器人', en: 'Discord bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(SNOWFLAKE, 'A Discord user id'), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
      bots: z.array(z.object({ id: z.string().regex(SNOWFLAKE, 'A Discord user id'), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Discord 用户', en: 'Discord users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '[0-9]{17,20}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的频道和子区里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in channels and threads the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '[0-9]{17,20}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的人 @ 机器人时，是明确的请求。', en: 'Someone on the list who mentions the bot makes an explicit request.' },
    rows(stored) {
      const config = ConfigSchema.partial().parse(stored)
      return (config.channels ?? []).map(row => ({ id: row.id, label: row.id,
        note: row.listen === 'all' ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: row.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: row.listen === 'all' } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DISCORD_GUILD', description: { zh: '接下工单的 Discord 服务器 ID；工单不是从 Discord 来的时为空', en: 'The Discord guild id that started the ticket; empty when the ticket did not start on Discord' } },
      { key: 'DSH_SUPERAGENT_DISCORD_CHANNEL', description: { zh: '接下工单的频道 ID（子区消息为父频道）；工单不是从 Discord 来的时为空', en: 'The channel id that started the ticket (the parent channel for a thread message); empty when the ticket did not start on Discord' } },
      { key: 'DSH_SUPERAGENT_DISCORD_THREAD', description: { zh: '接下工单的子区频道 ID；消息不在子区里时为空', en: 'The thread channel id that started the ticket; empty when the message was not in a thread' } },
      { key: 'DSH_SUPERAGENT_DISCORD_MESSAGE', description: { zh: '接下工单的消息 ID；工单不是从 Discord 来的时为空', en: 'The message id that started the ticket; empty when the ticket did not start on Discord' } },
    ],
    values: ({ trigger }) => {
      const meta: Record<string, unknown> = trigger?.source === SOURCE ? trigger.meta : {}
      const text = (name: string) => typeof meta[name] === 'string' ? meta[name] as string : ''
      return { DSH_SUPERAGENT_DISCORD_GUILD: text('guildId'), DSH_SUPERAGENT_DISCORD_CHANNEL: text('parentId') || text('channelId'),
        DSH_SUPERAGENT_DISCORD_THREAD: text('threadId'), DSH_SUPERAGENT_DISCORD_MESSAGE: text('messageId') }
    },
  },
}

/**
 * Polls Discord while the Source is enabled, waiting for setup, following the switch, and reporting its declared health
 * entry; a token file problem is reported at once because only a person can fix it, while failed polls count to an error.
 */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  let watching = false
  while (!signal.aborted) {
    const config = ctx.config<DiscordConfig>(SOURCE)
    try {
      if (config) {
        // A thread discovered later is read from its creation or from this start, not from before this process watched it.
        if (!watching) { ctx.state.set(KV.discord.since, new Date().toISOString()); watching = true }
        const { read, unreadable } = await pollRound(ctx, signal)
        ctx.report(SOURCE, { state: 'ready', detail: `${read} messages${unreadable ? `, ${unreadable} unreadable` : ''}`, at: new Date().toISOString() })
      } else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      if (!signal.aborted && error instanceof DiscordConfigError) ctx.report(SOURCE, { state: 'error', detail: error.message })
      else if (!signal.aborted && failures >= POLL_FAILURES) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause((config?.pollSeconds ?? 10) * 1000, signal)
  }
}

export const name = 'dsh-superagent-discord'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(discordKind), 'discord: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, discordKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
