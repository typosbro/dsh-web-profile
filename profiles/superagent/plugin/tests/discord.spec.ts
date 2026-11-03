import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import {
  DiscordConfigError, DiscordError, apply, discordChannel, discordKind, discordLink, discordThreadContext, discordTrigger, discordTriggerId,
  pollRound, readDiscordToken, sendDiscord,
} from '../src/sources/discord.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** The Test guild, its channels and threads, and two people, as snowflakes Discord returns them. Every id is 19 digits, so ids sort as snowflakes. */
const GUILD = '1200000000000000001'
const CHANNEL = '1200000000000000010'
const OTHER = '1200000000000000011'
const THREAD = '1200000000000000020'
const STRAY = '1200000000000000021'
const MEMBER = '1200000000000000101'
const BOT = '1200000000000000102'
const MESSAGE = '1200000000000000201'
const ROOT = '1200000000000000202'
const EARLIER = '1200000000000000200'
const LATER = '1200000000000000204'
const TOKEN = 'discord-bot-token'
const EPOCH = 1420070400000

const temporaries: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const directory of temporaries.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'discord-'))
  temporaries.push(directory)
  return directory
}
function tokenFile(contents = TOKEN): string {
  const path = join(temporary(), 'token')
  writeFileSync(path, contents)
  return path
}
let sequence = 0
/** The snowflake for a time, unique in this test run and ordered by the time it names. */
function snowflakeAt(iso: string): string {
  return ((BigInt(Date.parse(iso) - EPOCH) << 22n) + BigInt(sequence++)).toString()
}
function snowflakeNow(offset = 0): string {
  return snowflakeAt(new Date(Date.now() + offset).toISOString())
}
/** One message as the Discord API lists it. */
function message(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, channel_id: CHANNEL, timestamp: '2026-11-01T00:00:00.000000+00:00', content: `message ${id.slice(-3)}`,
    author: { id: MEMBER, username: 'alice', global_name: 'Alice' }, mentions: [], ...fields }
}
const compareIds = (a: string, b: string): number => a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0

interface Call { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | undefined }
type Answer = (call: Call) => unknown
/** Stubs the global fetch with a fake Discord API and collects the calls it receives. */
function discordApi(answer: Answer): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v10/, ''), query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined }
    calls.push(call)
    const value = answer(call)
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
/** One page of a channel's messages, newest first, honouring `before` and `after` as Discord does. */
function page(messages: Record<string, unknown>[], call: Call): Record<string, unknown>[] {
  const after = call.query.get('after')
  const before = call.query.get('before')
  const limit = Number(call.query.get('limit') ?? 50)
  return [...messages].filter(item => (!after || compareIds(String(item.id), after) > 0) && (!before || compareIds(String(item.id), before) < 0))
    .sort((a, b) => compareIds(String(b.id), String(a.id))).slice(0, limit)
}
/** A fake Discord: each channel's info and messages, and each guild's active threads. */
function fakeDiscord(channels: Record<string, { info?: Record<string, unknown>; messages?: Record<string, unknown>[] }>,
  threads: Record<string, Record<string, unknown>[]> = {}): Answer {
  return call => {
    if (call.path === '/users/@me') return { id: BOT, username: 'discord-bot' }
    const one = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(call.path)
    if (one) return (channels[one[1]!]?.messages ?? []).find(item => item.id === one[2])
      ?? new Response(JSON.stringify({ message: 'Unknown Message', code: 10008 }), { status: 404 })
    const list = /^\/channels\/(\d+)\/messages$/.exec(call.path)
    if (list) return page(channels[list[1]!]?.messages ?? [], call)
    const active = /^\/guilds\/(\d+)\/threads\/active$/.exec(call.path)
    if (active) return { threads: threads[active[1]!] ?? [] }
    const channel = /^\/channels\/(\d+)$/.exec(call.path)
    if (channel) return channels[channel[1]!]?.info ?? { id: channel[1]!, type: 0, guild_id: GUILD, name: 'ops' }
    return new Response(JSON.stringify({ message: 'Unknown Channel', code: 10003 }), { status: 404 })
  }
}
const configOf = (fields: Record<string, unknown> = {}) => discordKind.schema.parse({ tokenFile: tokenFile(), channels: [{ id: CHANNEL, listen: 'all' }], ...fields })

interface HostOptions {
  config?: Record<string, unknown>
  sources?: SourceRegistry
  board?: HealthBoard
  overrides?: Partial<SourceContextDeps>
}
function host(options: HostOptions = {}) {
  const store = new Store(join(temporary(), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { discord: { allowed: [{ id: MEMBER, name: 'Alice' }] } } },
    sources: { discord: { enabled: true, config: { tokenFile: tokenFile(), channels: [{ id: CHANNEL, listen: 'all' }], ...options.config } } } }))
  const board = options.board ?? new HealthBoard()
  const sources = options.sources ?? new SourceRegistry(() => store.settings(), board)
  // A kind supplied by a test is registered by the plugin under test.
  if (!options.sources) sources.register(discordKind)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: outbound => { store.receipts.add(outbound) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...options.overrides }
  return { store, sources, board, commands, receive, deps, engine,
    ctx: sourceContextOf(deps, discordKind),
    host: { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) } }
}
/** A registry of its own, so a plugin test can watch a folderless kind register and unregister. */
function registryOf(config?: { enabled?: boolean; config?: Record<string, unknown> }) {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { discord: config ?? {} } }), board)
  return { sources, board }
}

describe('discord source', () => {
  it('translates a thread message into a stable Trigger, and drops the bot\'s own messages', () => {
    const channel = { id: THREAD, type: 11, parent_id: CHANNEL, guild_id: GUILD, name: 'topic' }
    const input = { id: MESSAGE, channel_id: THREAD, timestamp: '2026-11-01T00:00:00.000000+00:00', content: '<@bot> please fix',
      author: { id: MEMBER, username: 'alice', global_name: 'Alice' }, mentions: [{ id: BOT }],
      message_reference: { message_id: ROOT, channel_id: THREAD } }
    const trigger = discordTrigger(input, BOT, channel, '/srv/discord/token')!
    expect(trigger).toEqual({ id: key('discord', MESSAGE), source: 'discord', threads: [{ source: 'discord', id: THREAD }],
      actor: { source: 'discord', id: MEMBER }, human: true, addressed: 'mention', at: '2026-11-01T00:00:00.000Z', text: '<@bot> please fix',
      channel: { source: 'discord', thread: `discord:${THREAD}`, address: { channelId: THREAD, messageId: MESSAGE, parentId: CHANNEL,
        guildId: GUILD, tokenFile: '/srv/discord/token' } }, url: `https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`,
      meta: { channelId: THREAD, messageId: MESSAGE, rootId: ROOT, mentioned: true, author: 'Alice', threadId: THREAD, parentId: CHANNEL,
        guildId: GUILD, replyToId: ROOT, referenceChannelId: THREAD } })
    // A normal channel's message belongs to the conversation of the message it answers, or of itself.
    const flat = { id: EARLIER, channel_id: CHANNEL, timestamp: '2026-11-01T00:00:00Z', content: 'hi', author: { id: MEMBER }, mentions: [] }
    expect(discordTrigger(flat, BOT, { id: CHANNEL, type: 0, guild_id: GUILD, name: 'ops' })!.threads)
      .toEqual([{ source: 'discord', id: `${CHANNEL}:${EARLIER}` }])
    expect(discordTrigger({ ...flat, message_reference: { message_id: ROOT } }, BOT, { id: CHANNEL, type: 0, guild_id: GUILD })!.threads)
      .toEqual([{ source: 'discord', id: `${CHANNEL}:${ROOT}` }])
    // Only the mentions array addresses the bot; a bot author is not human; the bot's own message is dropped.
    expect(discordTrigger(flat, BOT, { id: CHANNEL, type: 0, guild_id: GUILD })).not.toHaveProperty('addressed')
    expect(discordTrigger({ ...flat, author: { id: MEMBER, bot: true } }, BOT, { id: CHANNEL, type: 0, guild_id: GUILD })).toMatchObject({ human: false })
    expect(discordTrigger({ ...flat, author: { id: BOT, bot: true } }, BOT, { id: CHANNEL, type: 0, guild_id: GUILD })).toBeUndefined()
    // The reply address records where the message is, and the token file the send reads.
    expect(discordChannel({ ...flat, id: MESSAGE } as never, { id: CHANNEL, type: 0, guild_id: GUILD, name: 'ops' }, '/srv/token').address)
      .toEqual({ channelId: CHANNEL, messageId: MESSAGE, guildId: GUILD, tokenFile: '/srv/token' })
  })
  it('receives a channel and its threads under the configured row, and renders the Policy rows and search terms', () => {
    const config = configOf({ channels: [{ id: CHANNEL, listen: 'mentions' }, { id: OTHER, listen: 'all' }] })
    expect(discordKind.scope!({ meta: { channelId: CHANNEL } }, config)).toEqual({ listened: true, observed: false, row: CHANNEL })
    expect(discordKind.scope!({ meta: { channelId: OTHER } }, config)).toEqual({ listened: true, observed: true, row: OTHER })
    // A thread's messages name the thread, and their admission row is the parent channel configured.
    expect(discordKind.scope!({ meta: { channelId: THREAD, parentId: OTHER } }, config)).toEqual({ listened: true, observed: true, row: OTHER })
    expect(discordKind.scope!({ meta: { channelId: STRAY } }, config)).toEqual({ listened: false, reason: 'channel_not_listed' })
    expect(discordKind.policy!.rows!(config)).toEqual([
      { id: CHANNEL, label: CHANNEL, note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: OTHER, label: OTHER, note: { zh: '全部消息', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
    ])
    expect(discordKind.policy!.unnamed).toEqual({ person: { zh: 'Discord 用户', en: 'Discord user' }, bot: { zh: 'Discord 机器人', en: 'Discord bot' } })
    // A message link finds its thread channel, and its message in a normal channel; a bare id names a thread channel.
    expect(discordKind.find!(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`))
      .toEqual({ threads: [`discord:${CHANNEL}`, `discord:${CHANNEL}:${MESSAGE}`], terms: [] })
    expect(discordKind.find!(`https://discord.com/channels/${GUILD}/${THREAD}`)).toEqual({ threads: [`discord:${THREAD}`], terms: [] })
    expect(discordKind.find!(MESSAGE)).toEqual({ threads: [`discord:${MESSAGE}`], terms: [] })
    expect(discordKind.find!('login fails')).toEqual({ threads: [], terms: [] })
    // A reply carries the id of the Trigger of the message it answers.
    const reply = discordTrigger({ id: MESSAGE, channel_id: THREAD, timestamp: '2026-11-01T00:00:00Z', content: '', author: { id: MEMBER },
      mentions: [], message_reference: { message_id: ROOT } }, BOT, { id: THREAD, type: 11, parent_id: CHANNEL })!
    expect(discordKind.repliesTo!(reply)).toBe(discordTriggerId(ROOT))
  })
  it('receives messages under one Policy row and validates the allowed users, refusals of other scopes, and reply destinations', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { discord: { enabled: true,
      config: { tokenFile: tokenFile(), channels: [{ id: CHANNEL, listen: 'mentions' }] } } } }))
    sources.register(discordKind)
    expect(sources.validatePolicy({ discord: { allowed: [{ id: MEMBER, name: 'Alice' }], admission: {} } }).discord)
      .toEqual({ allowed: [{ id: MEMBER, name: 'Alice' }], admission: {} })
    expect(() => sources.validatePolicy({ discord: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('discord')).toEqual({ allowed: [], admission: {} })
    expect(sources.channelAllowed({ source: 'discord', address: { channelId: CHANNEL, messageId: MESSAGE } })).toBe(true)
    expect(sources.channelAllowed({ source: 'discord', address: { channelId: THREAD, parentId: CHANNEL } })).toBe(true)
    expect(sources.channelAllowed({ source: 'discord', address: { channelId: THREAD } })).toBe(false)
  })
  it('takes in the messages after the read position once, moves the position past them, and replays safely', async () => {
    const h = host()
    h.store.set(KV.discord.cursor(CHANNEL), '0')
    const earlier = message(snowflakeAt('2026-11-01T00:00:00Z'), { content: 'earlier' })
    const question = message(snowflakeAt('2026-11-01T00:00:01Z'), { content: '@bot fix the title', mentions: [{ id: BOT }] })
    discordApi(fakeDiscord({ [CHANNEL]: { messages: [question, earlier] } }))
    expect(await pollRound(h.ctx)).toEqual({ read: 2, unreadable: 0 })
    expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual([discordTriggerId(earlier.id as string), discordTriggerId(question.id as string)])
    expect(h.store.get(KV.discord.cursor(CHANNEL))).toBe(question.id)
    // The allowed sender's mention is an explicit request; the earlier message is not addressed.
    expect(h.engine.candidate(discordTriggerId(question.id as string))?.strength).toBe('explicit')
    expect(h.store.threads.get(`discord:${CHANNEL}:${question.id}`)?.meta).toMatchObject({ label: '#ops', facts: { channel: { value: '#ops' } } })
    // Reading the same messages again stores them once.
    h.store.set(KV.discord.cursor(CHANNEL), '0')
    await pollRound(h.ctx)
    expect(h.receive.mock.results.slice(2).map(result => result.value)).toEqual(['duplicate', 'duplicate'])
  })
  it('starts at the time it is switched on and skips the channel backlog', async () => {
    const h = host()
    const backlog = message(snowflakeAt('2026-01-01T00:00:00Z'))
    let messages = [backlog]
    discordApi(fakeDiscord({ [CHANNEL]: { get messages() { return messages } } }))
    expect(await pollRound(h.ctx)).toEqual({ read: 0, unreadable: 0 })
    expect(Number(h.store.get(KV.discord.cursor(CHANNEL)))).toBeGreaterThan(0)
    // A message written after the Source started watching is taken in on the next round.
    const fresh = message(snowflakeNow(), { content: '@bot now', mentions: [{ id: BOT }] })
    messages = [fresh, backlog]
    expect(await pollRound(h.ctx)).toEqual({ read: 1, unreadable: 0 })
    expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual([discordTriggerId(fresh.id as string)])
  })
  it('takes in a thread under a configured channel as one Thread, counting an unreadable message', async () => {
    const h = host()
    h.store.set(KV.discord.since, '2026-01-01T00:00:00.000Z')
    const reply = message(snowflakeAt('2026-02-02T00:00:00Z'), { channel_id: THREAD, content: 'more context' })
    const broken = { content: 'no id' }
    discordApi(fakeDiscord({ [CHANNEL]: { messages: [] }, [THREAD]: { messages: [reply, broken] } },
      { [GUILD]: [{ id: THREAD, type: 11, parent_id: CHANNEL, guild_id: GUILD, name: 'topic',
        thread_metadata: { create_timestamp: '2026-02-01T00:00:00.000Z', archived: false } }] }))
    expect(await pollRound(h.ctx)).toEqual({ read: 1, unreadable: 1 })
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ threads: [{ source: 'discord', id: THREAD }], text: 'more context',
      meta: { channelId: THREAD, threadId: THREAD, parentId: CHANNEL } })
    expect(h.store.get(KV.discord.cursor(THREAD))).toBe(reply.id)
    expect(h.store.threads.get(`discord:${THREAD}`)?.meta).toMatchObject({ label: '#topic', facts: { channel: { value: '#topic' } } })
    h.store.close()
  })
  it('keeps a channel\'s read position when a round is cut short, so the next round replays it', async () => {
    const h = host()
    h.store.set(KV.discord.cursor(CHANNEL), '0')
    let failing = true
    const messages = [message(snowflakeAt('2026-11-01T00:00:00Z')), message(snowflakeAt('2026-11-01T00:00:01Z'))]
    discordApi(call => {
      const answer = fakeDiscord({ [CHANNEL]: { messages } })(call)
      return failing && call.path === `/channels/${CHANNEL}/messages` ? new Response('{"message":"boom"}', { status: 500 }) : answer
    })
    await expect(pollRound(h.ctx)).rejects.toThrow('HTTP 500')
    expect(h.store.get(KV.discord.cursor(CHANNEL))).toBe('0')
    expect(h.receive).not.toHaveBeenCalled()
    failing = false
    expect(await pollRound(h.ctx)).toEqual({ read: 2, unreadable: 0 })
    expect(h.store.get(KV.discord.cursor(CHANNEL))).toBe(messages[1]!.id)
  })
  it('reads the token from its file without naming its content, and names the path when it cannot', async () => {
    expect(await readDiscordToken(tokenFile(`  ${TOKEN}\n`))).toBe(TOKEN)
    const missing = join(temporary(), 'missing-token')
    await expect(readDiscordToken(missing)).rejects.toThrow(DiscordConfigError)
    await expect(readDiscordToken(missing)).rejects.toThrow(missing)
    await expect(readDiscordToken(tokenFile(''))).rejects.toThrow('is empty')
    await expect(readDiscordToken('')).rejects.toThrow('names no bot token file')
    // A poll reports the same problem rather than a generic network failure.
    const h = host({ config: { tokenFile: missing } })
    await expect(pollRound(h.ctx)).rejects.toBeInstanceOf(DiscordConfigError)
    await expect(pollRound(h.ctx)).rejects.toThrow(missing)
  })
  it('posts replies under the trigger message once per message id, and tells a gone channel from a retryable failure', async () => {
    const path = tokenFile()
    const trigger = discordTrigger({ id: MESSAGE, channel_id: CHANNEL, timestamp: '2026-11-01T00:00:00Z', content: 'fix', author: { id: MEMBER },
      mentions: [] }, BOT, { id: CHANNEL, type: 0, guild_id: GUILD, name: 'ops' }, path)!
    const reply = (text: string): OutboundMessage => ({ id: key('reply', MESSAGE, text.slice(0, 10)), channel: trigger.channel!, text, kind: 'reply' })
    let status = 200
    const calls = discordApi(call => status === 200 ? { id: 'sent' } : new Response(JSON.stringify({ message: 'error', code: status }), { status }))
    const h = host()
    expect(await sendDiscord({ commands: h.commands }, reply('Done'))).toBe('sent')
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/channels/${CHANNEL}/messages` })
    expect(calls[0]!.body).toMatchObject({ content: 'Done', enforce_nonce: true, message_reference: { message_id: MESSAGE } })
    expect(String(calls[0]!.body!.nonce).length).toBeLessThanOrEqual(25)
    // Discord's 2000-character limit holds; a longer report keeps its head.
    expect(await sendDiscord({ commands: h.commands }, reply('x'.repeat(2500)))).toBe('sent')
    const content = String(calls[1]!.body!.content)
    expect(content).toHaveLength(2000)
    expect(content.endsWith('…')).toBe(true)
    // A permanent rejection drops the message; a rate limit or server error is retried.
    for (const gone of [403, 404]) {
      status = gone
      expect(await sendDiscord({ commands: h.commands }, reply('Gone'))).toBe('gone')
    }
    for (const retryable of [429, 500]) {
      status = retryable
      await expect(sendDiscord({ commands: h.commands }, reply('Retry'))).rejects.toBeInstanceOf(DiscordError)
    }
    // The fallback link opens the message; its trigger is preferred when the Trigger holds its own URL.
    expect(discordLink({ channelId: CHANNEL, messageId: MESSAGE, guildId: GUILD }, {})).toEqual({ url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
      label: { zh: 'Discord 消息', en: 'Discord message' }, triggerId: discordTriggerId(MESSAGE) })
    expect(discordLink({ channelId: CHANNEL }, {})).toEqual({ url: '', label: { zh: 'Discord 消息', en: 'Discord message' } })
  })
  it('pages a Thread around the Trigger for assessments, and reads its root message and the message it answers', async () => {
    const config = configOf()
    const trigger = discordTrigger({ id: MESSAGE, channel_id: THREAD, timestamp: '2026-11-01T00:00:00Z', content: 'please fix it',
      author: { id: MEMBER, username: 'alice' }, mentions: [], message_reference: { message_id: ROOT, channel_id: THREAD } }, BOT,
    { id: THREAD, type: 11, parent_id: CHANNEL, guild_id: GUILD, name: 'topic' })!
    const own = message(MESSAGE, { channel_id: THREAD, content: 'please fix it' })
    const earlier = message(EARLIER, { channel_id: THREAD, content: 'earlier context' })
    const later = message(LATER, { channel_id: THREAD, content: 'a later reply' })
    const root = message(THREAD, { channel_id: CHANNEL, content: 'the root' })
    const parent = message(ROOT, { channel_id: THREAD, content: 'the answered message' })
    const calls = discordApi(fakeDiscord({ [CHANNEL]: { messages: [root] }, [THREAD]: { messages: [own, earlier, later, parent] } }))
    const h = host()
    const thread = await discordThreadContext.read(h.commands, trigger, 'thread', undefined, config)
    // The first page holds the messages before the Trigger, then the Trigger.
    expect(thread.messages.map(item => [item.id, item.from, item.text])).toEqual([
      [EARLIER, 'Alice', 'earlier context'], [MESSAGE, 'Alice', 'please fix it']])
    expect(thread).toMatchObject({ next: MESSAGE, status: 'available' })
    // A later page continues after it.
    const continuation = await discordThreadContext.read(h.commands, trigger, 'thread', MESSAGE, config)
    expect(continuation.messages.map(item => item.id)).toEqual([ROOT, LATER])
    expect(continuation).not.toHaveProperty('next')
    expect(discordThreadContext.messageId(trigger)).toBe(MESSAGE)
    // The root of a thread is the message the thread was started from, in the parent channel.
    const rootPart = await discordThreadContext.read(h.commands, trigger, 'root', undefined, config)
    expect(rootPart.messages).toEqual([expect.objectContaining({ id: THREAD, text: 'the root' })])
    expect(calls.some(call => call.path === `/channels/${CHANNEL}/messages/${THREAD}`)).toBe(true)
    // The parent is the message the Trigger answers.
    const parentPart = await discordThreadContext.read(h.commands, trigger, 'parent', undefined, config)
    expect(parentPart.messages).toEqual([expect.objectContaining({ id: ROOT, text: 'the answered message' })])
    // A message without a reference has no parent; a missing message is no root.
    expect(await discordThreadContext.read(h.commands, { ...trigger, meta: { ...trigger.meta, replyToId: undefined } }, 'parent', undefined, config))
      .toMatchObject({ messages: [], status: 'no_parent' })
    const flat = discordTrigger({ id: MESSAGE, channel_id: CHANNEL, timestamp: '2026-11-01T00:00:00Z', content: 'hi',
      author: { id: MEMBER }, mentions: [] }, BOT, { id: CHANNEL, type: 0, guild_id: GUILD })!
    expect(await discordThreadContext.read(h.commands, flat, 'root', undefined, config)).toEqual(expect.objectContaining({ status: 'no_root' }))
  })
  it('describes the variables an Executor reads for a Discord Ticket and empties them for another Source', () => {
    const config = configOf()
    const trigger = discordTrigger({ id: MESSAGE, channel_id: THREAD, timestamp: '2026-11-01T00:00:00Z', content: 'hi', author: { id: MEMBER },
      mentions: [] }, BOT, { id: THREAD, type: 11, parent_id: CHANNEL, guild_id: GUILD })!
    expect(discordKind.environment!.variables.map(variable => variable.key))
      .toEqual(['DSH_SUPERAGENT_DISCORD_GUILD', 'DSH_SUPERAGENT_DISCORD_CHANNEL', 'DSH_SUPERAGENT_DISCORD_THREAD', 'DSH_SUPERAGENT_DISCORD_MESSAGE'])
    expect(discordKind.environment!.values({ deployment: testDeployment(), config, trigger })).toEqual({
      DSH_SUPERAGENT_DISCORD_GUILD: GUILD, DSH_SUPERAGENT_DISCORD_CHANNEL: CHANNEL, DSH_SUPERAGENT_DISCORD_THREAD: THREAD,
      DSH_SUPERAGENT_DISCORD_MESSAGE: MESSAGE })
    expect(discordKind.environment!.values({ deployment: testDeployment(), config, trigger: { ...trigger, source: 'github', meta: {} } }))
      .toEqual({ DSH_SUPERAGENT_DISCORD_GUILD: '', DSH_SUPERAGENT_DISCORD_CHANNEL: '', DSH_SUPERAGENT_DISCORD_THREAD: '', DSH_SUPERAGENT_DISCORD_MESSAGE: '' })
  })
  it('registers its kind and reports setup, the switch, a token problem and consecutive failed polls on its health', async () => {
    const run = (options: { registry: ReturnType<typeof registryOf>; overrides?: Partial<SourceContextDeps> }) => {
      const value = host({ sources: options.registry.sources, board: options.registry.board, overrides: options.overrides })
      const disposers: (() => unknown)[] = []
      apply({ orchestrator: value.host, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      return { ...value, value: options.registry, dispose: async () => { for (const dispose of disposers) await dispose() } }
    }
    // Setup restarts dsh-superagent once it resolves the accounts; until then the Source is paused.
    const pending = run({ registry: registryOf(), overrides: { configured: () => false } })
    await vi.waitFor(() => expect(pending.board.all.discord).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' }))
    expect(pending.sources.kind('discord')).toBe(discordKind)
    await pending.dispose()
    expect(pending.sources.kind('discord')).toBeUndefined()
    expect(pending.board.all.discord).toBeUndefined()
    // The switch turns it off without a failure.
    const off = run({ registry: registryOf({ enabled: false, config: {} }) })
    await vi.waitFor(() => expect(off.board.all.discord).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    await off.dispose()
    // A token file only a person can fix is reported at once, naming the path.
    const missing = join(temporary(), 'missing-token')
    const broken = run({ registry: registryOf({ enabled: true, config: { tokenFile: missing } }) })
    await vi.waitFor(() => expect(broken.board.all.discord).toMatchObject({ state: 'error', detail: expect.stringContaining(missing) }))
    await broken.dispose()
    // A single failed poll is retried; three in a row make the error.
    const calls = discordApi(() => new Response('{"message":"boom"}', { status: 500 }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flaky = run({ registry: registryOf({ enabled: true, config: { tokenFile: tokenFile(), channels: [{ id: CHANNEL, listen: 'all' }] } }) })
    // Each round reads its token from disk, so step the fake clock and let real I/O run between steps.
    for (let attempt = 0; attempt < 40 && flaky.board.all.discord?.code !== 'pollFailures'; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5_000)
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(flaky.board.all.discord).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } })
    await flaky.dispose()
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    const test = registryOf()
    const value = host({ sources: test.sources, board: test.board, overrides: { ready: Promise.reject(new Error('lock held')) } })
    apply({ orchestrator: value.host, effect: (effect: () => () => unknown) => { effect() } } as never)
    await vi.waitFor(() => expect(value.board.all.discord).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
  })
})
