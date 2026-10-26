#!/usr/bin/env node
// usage-meter — per-turn token totals from persisted DSH session logs.
//
// Why: the harness shows session stats but no spend line. Session logs persist a
// `usage` object on every assistant message, so a daily brief can carry tokens per
// turn and per session. No pricing is invented: this reports tokens, not dollars.
//
// Verified against DSH 0.2.1-rc.2 session format (session.v4.jsonl.zstd):
//   {"type":"assistant/message",
//    "data":{"turn":1,"step":2,
//            "usage":{"inputTokens":559,"outputTokens":395,
//                     "totalTokens":15802,"cacheReadTokens":14848}}}
//
// Usage:
//   ./scripts/usage-meter.mjs                     latest session in $DSH_HOME/sessions
//   ./scripts/usage-meter.mjs --turns 5           last 5 turns only
//   ./scripts/usage-meter.mjs --session <file>    explicit session log (.zstd or plain)
//   ./scripts/usage-meter.mjs --sessions 4        aggregate the last 4 sessions
//   ./scripts/usage-meter.mjs --json              machine-readable (briefs)
//
// Requires: node and the `zstd` CLI on PATH (session logs are multi-frame zstd).
//
// Notes:
// - `inputTokens` excludes cache reads here; `totalTokens` = input + output + cacheRead.
// - Turn/step come from the log; an assistant message without usage is skipped.
// - zstd decoding needs the system `zstd` binary (append-only logs are multi-frame).
// - Read-only: opens session files, writes nothing.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const HELP = `usage-meter — per-turn token totals from DSH session logs

  --session <file>   explicit session log (.zstd or plain .jsonl)
  --latest           default: newest session log under $DSH_HOME/sessions
  --sessions <N>     aggregate totals for the newest N sessions
  --workspace <path> only sessions whose workspace folder matches this path
  --turns <N>        print only the last N turns
  --json             emit JSON instead of a table
  --dir <path>       override sessions root (default: $DSH_HOME/sessions)
  -h, --help
`

function fail(msg, code = 2) {
  process.stderr.write(`usage-meter: ${msg}\n`)
  process.exit(code)
}

const options = { session: null, sessions: 1, turns: null, json: false, workspace: null, dir: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  const next = () => {
    const value = argv[i + 1]
    if (value === undefined) fail(`${arg} needs a value`)
    i += 1
    return value
  }
  switch (arg) {
    case '--session': options.session = next(); break
    case '--latest': options.sessions = 1; break
    case '--sessions': options.sessions = Number.parseInt(next(), 10); break
    case '--workspace': options.workspace = next(); break
    case '--turns': options.turns = Number.parseInt(next(), 10); break
    case '--json': options.json = true; break
    case '--dir': options.dir = next(); break
    case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break
    default: fail(`unknown argument: ${arg}`)
  }
}
if (options.sessions !== null && (!Number.isFinite(options.sessions) || options.sessions < 1)) fail('--sessions must be >= 1')
if (options.turns !== null && (!Number.isFinite(options.turns) || options.turns < 1)) fail('--turns must be >= 1')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = options.dir || join(DSH_HOME, 'sessions')

function findSessionLogs(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    // Workspace directory names encode the path with '-' instead of '/'
    // (--Users-typosbro-agent-memory--); keep both raw and a readable label.
    const workspaceDir = workspace.name
    const decoded = workspaceDir.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '/')
    for (const session of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(workspacePath, session.name)
      // Newest format first: a dir can hold both v3 and v4 for the same session,
      // and the break below keeps us from double-counting the older copy.
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.v3.jsonl.zstd', 'session.v3.jsonl', 'session.jsonl']) {
        const file = join(dir, name)
        if (!existsSync(file)) continue
        const stat = statSync(file)
        found.push({ file, mtime: stat.mtimeMs, size: stat.size, workspaceDir, workspace: decoded, sessionId: session.name })
        break
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function decodeSession(file) {
  const raw = readFileSync(file)
  const isZstd = file.endsWith('.zstd') || (raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd)
  if (!isZstd) return raw.toString('utf8')
  // Session logs are append-only, so a .zstd file holds MANY concatenated frames.
  // node:zlib.zstdDecompressSync stops after the first frame (8/8/2026: a 538 KB log
  // decoded to 281 bytes), so prefer the CLI, which walks every frame.
  const cli = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  if (cli.status === 0) return cli.stdout.toString('utf8')
  // node:zlib decodes only the first frame, which would silently under-report
  // tokens (a 538 KB log decoded to 281 bytes when tested). Fail loudly instead.
  return fail(
    `cannot decode ${file}: the zstd CLI is required for multi-frame session logs ` +
    `(${((cli.error && cli.error.message) || (cli.stderr || '')).toString().trim() || 'zstd failed'})`,
    1,
  )
}

function readSession(file) {
  const text = decodeSession(file)
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* torn line at tail; skip */ }
  }
  let model = null
  let provider = null
  const turns = new Map()
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'request/header') {
      // Shape: {"data":{"header":{"config":{"provider","model",...}},"reason":"initial"}}
      const config = event.data?.header?.config ?? event.data?.config
      if (config) {
        model = config.model ?? model
        provider = config.provider ?? provider
      }
    }
    if (event.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const usage = data.usage
    if (!usage || typeof usage.inputTokens !== 'number') continue
    const turn = data.turn ?? 0
    const row = turns.get(turn) ?? { turn, calls: 0, input: 0, output: 0, cacheRead: 0, total: 0 }
    row.calls += 1
    row.input += usage.inputTokens ?? 0
    row.output += usage.outputTokens ?? 0
    row.cacheRead += usage.cacheReadTokens ?? 0
    row.total += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0))
    turns.set(turn, row)
  }
  const ordered = [...turns.values()].sort((a, b) => a.turn - b.turn)
  const totals = ordered.reduce((acc, row) => ({
    calls: acc.calls + row.calls,
    input: acc.input + row.input,
    output: acc.output + row.output,
    cacheRead: acc.cacheRead + row.cacheRead,
    total: acc.total + row.total,
  }), { calls: 0, input: 0, output: 0, cacheRead: 0, total: 0 })
  return { file, model, provider, turns: ordered, totals }
}

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function printTable(sessions) {
  for (const session of sessions) {
    const label = session.file.split('/').slice(-2).join('/')
    process.stdout.write(`\nsession  ${label}\n`)
    if (session.model) process.stdout.write(`model    ${session.provider ?? '?'}/${session.model}\n`)
    process.stdout.write(`\n turn  calls   ${'in'.padStart(8)}  ${'out'.padStart(8)}  ${'cache'.padStart(8)}  ${'total'.padStart(9)}\n`)
    let rows = session.turns
    if (options.turns !== null) rows = rows.slice(-options.turns)
    for (const row of rows) {
      process.stdout.write(`  ${String(row.turn).padStart(4)}  ${String(row.calls).padStart(5)}   ${fmt(row.input).padStart(8)}  ${fmt(row.output).padStart(8)}  ${fmt(row.cacheRead).padStart(8)}  ${fmt(row.total).padStart(9)}\n`)
    }
    const t = session.totals
    process.stdout.write(`\n  total   ${String(t.calls).padStart(4)} calls  ${fmt(t.input)} in / ${fmt(t.output)} out / ${fmt(t.cacheRead)} cache read / ${fmt(t.total)} tokens\n`)
  }
}

const explicit = options.session
let selected
if (explicit) {
  if (!existsSync(explicit)) fail(`session log not found: ${explicit}`, 1)
  selected = [{ file: explicit, mtime: statSync(explicit).mtimeMs, workspace: null, sessionId: explicit }]
  if (options.sessions > 1) fail('--session cannot be combined with --sessions > 1')
} else {
  let logs = findSessionLogs(SESSIONS_ROOT)
  if (options.workspace) {
    // '/Users/me/agent-memory' -> 'Users-me-agent-memory' (the encoded dir form).
    const encoded = options.workspace.replace(/\/+$/, '').replace(/^\//, '').replace(/\//g, '-')
    logs = logs.filter((entry) => entry.workspaceDir.replace(/^--|--$/g, '').endsWith(encoded))
  }
  if (logs.length === 0) fail(`no session logs under ${SESSIONS_ROOT}${options.workspace ? ` for workspace ${options.workspace}` : ''}`, 1)
  selected = logs.slice(0, options.sessions)
}

const sessions = selected.map((entry) => readSession(entry.file))
if (options.json) {
  const payload = sessions.length === 1
    ? { session: sessions[0].file, workspace: selected[0].workspace, sessionId: selected[0].sessionId, model: sessions[0].model, provider: sessions[0].provider, turns: sessions[0].turns, totals: sessions[0].totals }
    : { sessions: sessions.map((s, i) => ({ session: s.file, workspace: selected[i].workspace, model: s.model, totals: s.totals })), totals: sessions.reduce((acc, s) => { for (const k of ['calls', 'input', 'output', 'cacheRead', 'total']) acc[k] = (acc[k] ?? 0) + s.totals[k]; return acc }, {}) }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
} else {
  printTable(sessions)
  if (sessions.length > 1) {
    const agg = sessions.reduce((acc, s) => { for (const k of ['calls', 'input', 'output', 'cacheRead', 'total']) acc[k] = (acc[k] ?? 0) + s.totals[k]; return acc }, {})
    process.stdout.write(`\nall sessions: ${fmt(agg.input)} in / ${fmt(agg.output)} out / ${fmt(agg.cacheRead)} cache read / ${fmt(agg.total)} tokens across ${sessions.length} sessions\n`)
  }
}
