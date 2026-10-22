/**
 * session-message — let one live dsh session hand a message to another.
 *
 * WHY. dsh has no cross-session messaging: `send_message` reaches only the agents a
 * session spawned, and the inspect providers are read-only. Two sessions running side
 * by side in the same app — the common case when one works in ~/project-a and another
 * in ~/project-b — cannot address each other at all. This row adds one tool that can.
 *
 * HOW. Every live agent is registered in `ctx.agents`, and the agent loop implements
 * `followup(input)` (queue for the next turn, waking an idle agent) and `steer(input)`
 * (insert into the next step of the current turn). That is the same pair the session
 * controller uses when a human submits a prompt, so this tool delivers a message the
 * target's model sees as an ordinary user message — it does not reach into the target's
 * model, tools, or session log.
 *
 * SCOPE AND RISK. The tool is registered globally, so every session on this host can
 * use it, including the one being addressed (they can answer). A message wakes an idle
 * session and interrupts nothing that is mid-step; `steer` is the interrupting mode and
 * is therefore not the default. Delivery is best-effort: a session that is not live
 * cannot be addressed, and the tool reports that rather than pretending.
 */
export const name = 'session-message'

/** The registry of live agents is the whole mechanism. */
export const inject = ['agents', 'workingDirectory']

/** Tool name as the model sees it. */
const TOOL_NAME = 'talk_to_session'

/** Build the user message the target's model will read. */
function userMessage(text) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    time: Date.now(),
    content: [{ type: 'text', text }],
  }
}

/** Short, human-readable identity for one live agent. */
async function describe(ctx, agent, signal) {
  let cwd
  try {
    cwd = await ctx.workingDirectory.ensure(agent, signal)
  } catch {
    cwd = undefined
  }
  return { id: String(agent.id), cwd }
}

/**
 * Resolve the target: an exact session id first, then a working-directory match.
 * @returns the live agent, its description, or an error string.
 */
async function resolveTarget(ctx, wanted, signal) {
  const live = ctx.agents.list()
  for (const agent of live) {
    if (String(agent.id) === wanted) return { agent, info: await describe(ctx, agent, signal) }
  }
  const wantedPath = wanted.replace(/\/+$/, '')
  for (const agent of live) {
    const info = await describe(ctx, agent, signal)
    if (info.cwd !== undefined && info.cwd.replace(/\/+$/, '') === wantedPath) {
      return { agent, info }
    }
  }
  const known = []
  for (const agent of live) known.push(await describe(ctx, agent, signal))
  return { error: `no live session matches ${JSON.stringify(wanted)}`, known }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          'Send a message to another live dsh session on this host, addressed by session id or by its working directory. ' +
          'Use it to hand a task or a finding to a session working in a different folder, or to answer one that messaged you. ' +
          'The message arrives as an ordinary user message from that session\'s point of view. ' +
          'Delivery is best-effort: a session that is not currently open cannot be reached, and the result lists the live sessions when the target does not match.',
        parameters: {
          type: 'object',
          properties: {
            session: {
              type: 'string',
              description:
                'Session id (e.g. session-b272a84c-...) or the absolute working directory of the target session (e.g. /Users/you/agent-memory).',
            },
            message: {
              type: 'string',
              description: 'The text to deliver. It becomes a user message in the target session.',
            },
            mode: {
              type: 'string',
              enum: ['followup', 'steer'],
              description:
                'followup (default) queues the message as the next turn and wakes an idle session. steer inserts it into the next step of a turn already running.',
            },
          },
          required: ['session', 'message'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              delivered: { type: 'boolean' },
              sessionId: { type: 'string' },
              cwd: { type: 'string' },
              mode: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['delivered', 'detail'],
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
        },
        async execute(args, exec) {
          const wanted = String(args?.session ?? '').trim()
          const text = String(args?.message ?? '')
          const mode = args?.mode === 'steer' ? 'steer' : 'followup'
          if (wanted === '') return { delivered: false, detail: 'session is required' }
          if (text.trim() === '') return { delivered: false, detail: 'message is required' }

          const found = await resolveTarget(ctx, wanted, exec.signal)
          if (found.error !== undefined) {
            const list = (found.known ?? [])
              .map((info) => `  ${info.id}  ${info.cwd ?? '(unknown cwd)'}`)
              .join('\n')
            return {
              delivered: false,
              detail: `${found.error}. Live sessions:\n${list || '  (none)'}`,
            }
          }

          const target = found.agent
          if (typeof target.followup !== 'function' || typeof target.steer !== 'function') {
            return {
              delivered: false,
              sessionId: found.info.id,
              detail: `session ${found.info.id} is live but exposes no inbox (not an agent loop)`,
            }
          }

          if (mode === 'steer') target.steer(userMessage(text))
          else target.followup(userMessage(text))

          return {
            delivered: true,
            sessionId: found.info.id,
            cwd: found.info.cwd,
            mode,
            detail: `delivered via ${mode} to ${found.info.id} (${found.info.cwd ?? 'unknown cwd'})`,
          }
        },
      }),
    'session-message: register the cross-session messaging tool',
  )
}
