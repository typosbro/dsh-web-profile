/**
 * stop-gate — refuse to end a turn on "looks done" when the repository has a gate.
 *
 * WHY THIS EXISTS, AND WHY NOT THE UPSTREAM ROW. typosbro/dsh-web-profile mounts
 * '@deepseek-ai/dsh-hooks-claude-code' and a Stop hook. The dsh Desktop app does not
 * bundle that package (verified: no hook packages in app.asar), and it peer-depends on
 * the entire dsh 0.2.1-rc.2 stack. The desktop profile sets autoInstallPeers: false,
 * so that row cannot import. This file reaches the same outcome with the native
 * extension point instead: `agent/turn-stopping` is dispatched serially before the
 * turn boundary commits, and the loop re-reads its inbox afterwards — so a listener
 * that steers a message forces another step instead of closing the turn.
 *
 * FAIL-SAFE RULES, in priority order:
 *   1. Anything unexpected (missing service, unreadable repo, spawn failure) ends the
 *      listener silently. A gate that cannot run must never block a turn.
 *   2. A clean git tree skips every check: nothing changed, nothing to verify.
 *   3. A repository opts in by exposing scripts/agent-gate.sh, a package.json
 *      "gate"/"gate:fast" script, or scripts/agent-review.sh. No repo, no gate.
 *   4. At most MAX_BLOCKS forced continuations per session, so pre-existing breakage
 *      cannot trap the user in a loop.
 *   5. If the agent object has no steer(), the listener does nothing at all.
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'stop-gate'

/** The directory owner is the only service this row needs. */
export const inject = ['workingDirectory']

/** Forced continuations allowed per session before the gate stands down. */
const MAX_BLOCKS = 2

/** Wall-clock ceiling for one gate run; the upstream hook used the same 180s. */
const GATE_TIMEOUT_MS = 180_000

/** Per-session block counters, keyed by SessionId. Process memory only, by design. */
const blocks = new Map()

/** True when the path exists (any type). */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Run one shell command in the repository, never throwing.
 * @param command - shell command line, executed by bash -lc.
 * @param cwd - repository root.
 * @param signal - the turn's abort signal.
 * @returns ok flag plus combined stdout/stderr.
 */
function run(command, cwd, signal) {
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-lc', command],
      { cwd, timeout: GATE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
      },
    )
  })
}

/**
 * Resolve the repository's gate the same way the upstream hook does.
 * @param dir - repository root.
 * @returns the command to run and its label, or null when the repo opted out.
 */
async function resolveGate(dir) {
  if (await exists(join(dir, 'scripts/agent-gate.sh'))) {
    return { label: 'scripts/agent-gate.sh', command: 'bash scripts/agent-gate.sh' }
  }
  if (await exists(join(dir, 'package.json'))) {
    let scripts = {}
    try {
      scripts = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts ?? {}
    } catch {
      return null
    }
    if (scripts.gate) return { label: 'pnpm gate', command: 'pnpm -s gate' }
    if (scripts['gate:fast']) return { label: 'pnpm gate:fast', command: 'pnpm -s gate:fast' }
  }
  return null
}

/** True when the repository has a diff-level review stage. */
async function hasReview(dir) {
  return exists(join(dir, 'scripts/agent-review.sh'))
}

/** True when the working tree has no changes (including untracked files). */
async function isClean(dir, signal) {
  const inside = await run('git rev-parse --is-inside-work-tree', dir, signal)
  if (!inside.ok) return true // not a repository: nothing to gate
  const status = await run('git status --porcelain', dir, signal)
  if (!status.ok) return true
  return status.output.length === 0
}

/** Build the steering message the model sees, without importing dsh-llm. */
function steerMessage(label, dir, output) {
  const tail = output.split('\n').slice(-40).join('\n')
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    time: Date.now(),
    content: [
      {
        type: 'text',
        text:
          `The check failed: ${label} in ${dir}\n` +
          `This turn cannot end until it passes, or until the gate has blocked twice.\n` +
          `Run the same command yourself to see the full output. The tail follows.\n\n` +
          (tail.length > 0 ? tail : '(no output)'),
      },
    ],
  }
}

/**
 * One turn-stop check. Returns after steering when the gate fails.
 * @param ctx - plugin context.
 * @param payload - the agent/turn-stopping payload.
 */
async function check(ctx, { agent, signal }) {
  const dir = await ctx.workingDirectory.ensure(agent, signal)
  if (await isClean(dir, signal)) return

  const gate = await resolveGate(dir)
  const review = await hasReview(dir)
  if (gate === null && !review) return

  if (gate !== null) {
    const result = await run(gate.command, dir, signal)
    if (!result.ok) return block(agent, gate.label, dir, result.output)
  }
  if (review) {
    const result = await run('bash scripts/agent-review.sh', dir, signal)
    if (!result.ok) return block(agent, 'scripts/agent-review.sh', dir, result.output)
  }
  blocks.delete(String(agent.id))
}

/** Count, cap, then steer the agent with the failing output. */
function block(agent, label, dir, output) {
  if (typeof agent.steer !== 'function') return
  const key = String(agent.id)
  const count = (blocks.get(key) ?? 0) + 1
  if (count > MAX_BLOCKS) {
    blocks.delete(key)
    return
  }
  blocks.set(key, count)
  agent.steer(steerMessage(label, dir, output))
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.on('agent/turn-stopping', async (payload) => {
        try {
          await check(ctx, payload)
        } catch {
          // Rule 1: a gate that cannot run must never block a turn.
        }
      }),
    'stop-gate: run the repository gate before a turn ends',
  )
}
