# Harness comparison, 2026-10-25: DSH vs Pi vs omp

Plus how Claude Code, Codex/ChatGPT, and Copilot CLI actually do multi-agent work.
Everything below is checked against the installed CLIs, the shipped package READMEs,
and the vendors' own docs/changelogs on this date. Version claims are dated; re-check
before betting on them.

## TL;DR

- **DSH** is the only one of the three that ships the whole stack the owner wants:
  orchestrator + shared task board (DAG via `blocked_by`) + durable teammates with
  mailboxes + nested subagents + scripted workflows + a Web UI that shows the roster
  and board. It is also the youngest and is a release candidate (0.2.1-rc.2); the team
  bundle is experimental.
- **Pi** is the most mature *substrate* (1.x, huge install base, extension/package
  ecosystem) and deliberately has **no** subagents, plan mode, todos, or MCP built in.
  You build the orchestration as an extension or on Pi Durable.
- **omp** is the strongest *single-agent terminal harness* and has the richest built-in
  agent-tree machinery: nested `task` subagents (recursion depth 2 by default), an IRC
  mailbox/peer roster including `agent://all` broadcast, an eval kernel for scripted
  fan-out (`workflowz`), per-task isolated worktrees/patches, and an Agent Hub TUI.
  No durable shared task board and no GUI.
- Industry pattern: Claude Code, Codex/ChatGPT, Copilot CLI, DSH, and omp have all
  converged on **two** shapes — *conversational agent teams* (model decides turn by
  turn) and *script-defined workflows* (a JS program decides the DAG, intermediates live
  in script variables). Claude Code productizes both; Codex only the first; DSH both;
  omp mostly the tree/msg shape plus an eval-kernel script shape; Pi neither.
- Maturity ranking: **Pi > omp > DSH** in age/stability. Momentum/breadth of
  first-party multi-agent surface: **DSH > omp > Pi**. Best "juice" for this owner's
  stated architecture: **DSH as the control plane**, with omp/Claude Code/Codex wired in
  as child backends where their tools or models are better.

## What each project is

| | DSH (`dsh`) | Pi (`pi`) | omp (`omp`) |
|---|---|---|---|
| Repo | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [earendil-works/pi](https://github.com/earendil-works/pi) | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) |
| Repo created | 2026-08-13 | 2025-08-09 | 2025-12-31 |
| Stars (today) | 260,962 | 117,688 | 36,520 |
| Installed / latest | 0.2.1-rc.2 | 0.74.0 installed, 1.4.0 on npm | 18.0.11 |
| Thesis | "Everything is a plugin": Cordis DI tree, ordered patch layers, agent presets compose per-agent plugin lists; Web/Desktop/TUI/headless/ACP | Minimal harness: four core tools, small system prompt; extend with TypeScript extensions, skills, prompt templates, themes, packages | Fork of Pi with the IDE wired in: Rust core, 31 tools, LSP/DAP, hashline edits, plan/goal modes, nested subagents, memory, model roles |
| Refuses / omits | a stable 1.0 (still RC); nested Teams; durable coordination across processes | subagents, MCP, plan mode, todos, background bash — by design | a durable team task board; a GUI (TUI + web Collab guests); a 1.x-style stability story |
| Distribution | pnpm global + profile bundles | npm global (`@earendil-works/pi-coding-agent`) | Homebrew/Rust binary |
| Install signal | 1.56M npm downloads / 30d (core) | 15.8M npm downloads / 30d | not npm; brew formula |

Pi's number is inflated by the ecosystem that depends on it (OpenClaw and other apps
build on Pi; `pi-ai` is the provider layer other projects reuse — DSH itself mounts
`dsh-llm-pi-ai` in this profile). Treat download counts as a direction, not a score.

## The owner's target architecture, mapped

The ask: one orchestrator model plans a DAG; it launches subagents; subagents can split
into smaller todos and launch their own subagents; they have a group chat for progress
and coordination; changes must not conflict.

| Capability | DSH | Pi | omp | Claude Code | Codex/ChatGPT |
|---|---|---|---|---|---|
| Orchestrator model | any preset, any provider; per-agent composition | you write it | main agent + `task`/`eval` | Agent tool / team lead / workflow | multi-agent v2 root agent |
| Shared DAG / task board | **yes**: durable board, `blocked_by` dependency edges, CAS revisions, Web UI | no | no (DAG lives in eval script) | yes (team task list) | no board; messages + consolidated results |
| Nested delegation | yes, but `maxDepth` defaults to **1** — raise it | no | **yes**, `task.maxRecursionDepth` default **2**; `spawns` policy per agent | workflow agents can fan out; teams are flat peers | **yes**: children can spawn their own sub-agents (source prompt) |
| Group chat / messaging | pairwise `send_message` + mailbox; board is the shared surface; no broadcast channel | — | **IRC peer roster** + `write agent://<id>` and `agent://all` broadcast — closest to a group channel | teammates message each other directly (experimental) | `send_message`/`followup_task`; messages carry sender/recipient; tree-addressed |
| Conflict avoidance | `writeScopes` (advisory overlap warnings), FS version guard, worktree tool/skill; bash bypasses guards | — | per-task isolated workspaces: patch or branch mode, nested patches; strongest mechanical isolation | shared filesystem, no scopes | shared filesystem |
| Observability | Web roster/task board/teammate sessions, workflow run UI, session log | TUI only | Agent Hub (roster, tree, transcripts, revive/kill), Collab guests | agent panel + `/workflows` progress view | Subagents lists in app/web; consolidated answer |
| Per-child model/effort | yes: provider/model/reasoning effort per subagent; presets per child | you write it | yes: agent definitions, model roles (`smol`/`slow`/`plan`/advisor), prewalk handoff | yes: per-subagent model; workflow-wide override env | yes: custom agents, `[agents]` defaults, per-subagent effort |
| Durability | durable sessions/projections; teams require durable storage | session tree + RPC/SDK | session files + parked/revive | session resume; workflows resumable | resumable threads |

### DSH specifics

- Agent Teams: 9 tools (`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`,
  `interrupt_agent`, `team_task_create/list/get/update`); only the Lead creates and
  interrupts; every member can message any other member and use the board. Durable
  roster, per-target mailboxes, CAS revisions, `blocked_by` DAG validation, advisory
  `writeScopes` (warn on overlap with in-progress tasks, never lock). Web UI shows the
  roster and board and opens teammate sessions. Experimental package, off in the
  shipped bundle; durable session storage required; **nested Teams are not supported**.
- The shipped agent-team bundle disables the ordinary `subagent`/`subagent_fork` tools
  and replaces them with `spawn_teammate`; Workflow still creates fresh children.
  This profile's orchestrator preset re-adds `subagent` + `subagent_fork`, and this
  session has both — that hybrid is live, not theoretical.
- Subagents: spawn or fork provider, per-call child preset/model/effort, completion
  notices, local children can be messaged and resumed; **one-shot external backends**
  for Codex (app-server), Claude Code (Agent SDK), ACP, and the DSH SDK.
  `dsh-subagent-acp`, `dsh-subagent-codex`, `dsh-subagent-claude-code` are published
  at 0.0.1-rc.1 (experimental).
- Workflow tool: a JS script with `agent()`, `pipeline()`, `parallel()`, `phase()`,
  `log()`; intermediates stay in script variables; background jobs; result JSON capped
  at 50k chars; run/member lifecycle recorded to the Session.
- Also shipped: goals + fresh-agent Ralph loop, schedules, jobs, session search,
  worktree tool, auto-review bundle, relay for remote access.
- Live caveat: this session's toolset includes `workflow` even though the preset file
  marks `tool-workflow` disabled — the Web preset editor overrides file config by
  plugin id. Trust the live composition over the file.

### Pi specifics

- 1.0 shipped 2026-10-01; Pi Durable is a separate **experimental** framework (not the
  coding agent): storage plus machinery for long-running, durable, parallel
  conversations, tasks, and execution environments; ~15k LOC; multiple humans can
  steer the same agents; intended for building agentic applications, with lessons
  flowing back into the coding agent. [Pi Durable post](https://earendil.com/posts/pi-durable/)
- The coding agent deliberately omits subagents, MCP, plan mode, todos, and background
  bash; extensions can add them (the extension docs include a `subagent/` example;
  the SDK advertises "build custom tools that spawn sub-agents").
- Modes: interactive, print/JSON, RPC, SDK. Session tree with branching/rewind,
  compaction, skills, AGENTS.md, prompt templates, themes, packages on npm/git.
- Ecosystem: OpenClaw is the flagship integration; pi-ai is reused widely.

### omp specifics

- `task` tool: one spawn or a `tasks[]` batch; async background jobs; session-scoped
  concurrency (`task.maxConcurrency`, default 32); **`task.maxRecursionDepth` default 2**
  (negative = unlimited); custom agent definitions in `~/.omp/agent/agents/*.md` with
  `tools`, `spawns`, model, thinking level, structured output, isolation; plan-mode
  spawns stay read-only.
- Peer messaging: subagents get an IRC roster in their system prompt; `write` to
  `agent://<id>` delivers a message; `agent://all` is the write-only broadcast (the
  closest thing to a group channel among any of these harnesses); the Agent Hub shows
  unread IRC counts and the flat/tree roster.
- Isolation: `task.isolation` patch or branch mode (`omp/task/<id>` branch, cherry-pick
  back), `apply=false` keeps captured changes, nested repos get separate patch
  artifacts. This is real mechanical separation, not advisory scopes.
- Scripted fan-out: the `eval` kernel is a persistent JS/Python REPL with `agent()`,
  `workpool()`, `wait()`, `completion()`, `judge()`, `judgeBatch()`. `task` and `eval`
  subagents keep their own kernels; `agent()` children are keep-alive and can be
  messaged. This is omp's equivalent of a workflow runtime, but it lives in a REPL
  cell instead of a dedicated tool.
- Human surfaces: Agent Hub, `/collab` (share one live session with other omp
  instances or a browser guest, E2E encrypted), `omp acp` (run as an ACP server),
  RPC/SDK modes, marketplace/extensions (Pi-compatible).

## How Claude Code does it

Three separate mechanisms, documented at
[code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows) and
[code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams):

1. **Subagents** — the Agent tool; own context window; results return to the caller;
   named subagents can message each other; per-subagent model/effort.
2. **Agent teams** — experimental, **disabled by default** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
   One session is the lead; teammates are independent sessions with their own context;
   they share a task list (in sessions that have the Task tools) and message each other
   directly; the human can talk to any teammate; display is in-process or tmux/iTerm
   split panes. Docs warn about coordination overhead, token cost, and resumption
   limitations, and say to prefer subagents for sequential or same-file work.
3. **Dynamic workflows** — Claude writes a JavaScript orchestration script; a runtime
   executes it in the background. Hooks are `agent()`, `parallel()`, `pipeline()`;
   intermediate results live in script variables, not the chat; the run is resumable;
   `/workflows` gives a phase/agent progress view with pause/stop/restart/save-as-command.
   Caps: **1,000 agents per run**, **16 concurrent by default**
   (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1–256). No mid-run user input;
   a bundled `/deep-research` workflow ships. Available on paid plans.

**Ultracode** is the *opt-in switch for workflows*, not a model: `ultracode` as a
standalone prompt keyword writes a workflow for that request; `/effort ultracode` turns
on automatic workflow planning for every substantive task in the session
(`claude --effort ultracode` also sets effort to xhigh). The CLI changelog records that
Ultracode stopped forcing xhigh effort and became its own toggle at any effort level.
It costs tokens and hits usage limits sooner — the docs say so explicitly.

## How Codex / ChatGPT do it

Docs: [learn.chatgpt.com/docs/agent-configuration/subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

- Codex has **multi-agent v2** built in: `spawn_agent`, `followup_task` (message +
  trigger a turn), `send_message` (message without triggering a turn), plus close.
  Children can spawn their own sub-agents. `fork_turns` decides how much context to
  propagate. Messages arrive in the analysis channel tagged with type, recipient, and
  sender (`MESSAGE` / `FINAL_ANSWER`, addressed as `/root/...`). The harness waits for
  all requested results and returns one consolidated response.
- **Ultra** is an intelligence/reasoning level, not a workflow product: maximum
  reasoning plus *proactive delegation* — ChatGPT can spawn agents when parallel work
  is useful. In ChatGPT Work/web, Ultra enables proactive delegation; current local
  Codex clients spawn only after a direct request or an applicable project/skill
  instruction. Ultra is restricted to eligible accounts/models.
- Custom agents: `~/.codex/agents/*.toml` (model, `model_reasoning_effort`, tools);
  defaults via `[agents]` in `config.toml`.
- As of today's docs there is **no user-authored script/workflow layer** in Codex —
  "subagent workflow" in OpenAI docs means the conversational spawn/message pattern,
  not Claude's dynamic workflows. If "Ultra has workflows" is a memory, it is likely
  either the ChatGPT Work delegation behavior or a different product (Copilot CLI
  shipped dynamic workflows on 2026-10-01; same pattern as Claude's).
- ChatGPT Work uses the same subagent docs; the ChatGPT surface is where proactive
  Ultra delegation actually runs.

## omp's magic keywords, demystified

They are **not commands and not modes**. They are standalone prose words; on a match,
omp injects a hidden, user-attributed instruction notice for that turn only. Matching
is exact-lowercase, standalone, and ignored inside code fences/inline code. The TUI
animates recognized words, and they are exempt from macOS autocorrect (so `workflowz`
is not "fixed"). Source: [docs/magic-keywords.md](https://github.com/can1357/oh-my-pi/blob/main/docs/magic-keywords.md).

| Keyword | What it injects | Requires |
|---|---|---|
| `ultrathink` | careful multi-step reasoning; selects the highest reasoning effort for the turn (bypasses `autoThinkingMaxEffort`) | — |
| `orchestrate` | multi-agent orchestration contract: scope the task, delegate substantial independent work in parallel, verify each phase, continue until complete | `task` tool |
| `workflowz` | deterministic multi-subagent workflow contract built on the eval kernel's `agent()`, `completion()`, handle, `wait()`, `workpool()` | `eval` **and** `task` |
| `jevify` | bulk-classification contract on the eval kernel's `judge()`/`judgeBatch()`: freeze rubric, batch, read only flagged items | `eval` |

Why it never clicked: the word has to be exact and standalone, the required tools must
be active, it affects only the turn containing it, and nothing visible is printed except
subtle highlighting. There is no `/workflowz` command and no settings screen that runs it.

Use it by putting the word in the prose:

```text
orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

ultrathink about the failure modes before changing this API

jevify commit a17c3e0 for changes unrelated to the tui refactor
```

With `workflowz`, a capable model will write and run an eval cell roughly like:

```js
const findings = await workpool({ agent: "reviewer" });
const ids = findings.push("src/a.ts", "src/b.ts", "src/c.ts");
const refs = await agent("double-check each finding against docs/", { schema: reviewSchema });
await wait([refs]);
```

Turn keywords off per-word with `omp config set magicKeywords.orchestrate false`; the
global switch is `magicKeywords.enabled`. Inspect with `omp config list`, or
`/settings` → Interaction → Magic Keywords.

## Maturity and "juice"

Two different questions hide in "squeeze as much juice as possible":

1. **Juice per token** — how much model capability reaches the task per context token.
   Pi is the leanest (small prompt, four tools, broad providers). omp is lean for its
   power level (Rust core, benchmark-tuned tools, LSP/DAP, model roles). DSH pays more
   fixed context but offers per-agent model/effort routing and compaction/caching.
2. **Juice per unit of orchestration intent** — how much work a human can hand over and
   have verified. This is where the harness matters: deterministic scripts, durable
   boards, isolated workspaces, per-child models, and observability. DSH and Claude Code
   leverage this best; omp is close at the tree/terminal level; Codex is simplest to
   use; Pi gives you the parts to build it.

The owner's architecture is question 2. DSH is the only one of the three that ships it,
and it can additionally treat the other ecosystems as **child backends**: `subagent`
with the Codex, Claude Code, or ACP providers (published as `dsh-subagent-codex`,
`dsh-subagent-claude-code`, `dsh-subagent-acp`, all `0.0.1-rc.1`). That is the strongest
single argument for DSH as the control plane — omp can be an ACP child (`omp acp`),
Claude Code and Codex can be one-shot children, and the Web UI remains the one pane of
glass.

### Honest caveats

- **No harness has a literal group chat room among agents.** Closest: omp's
  `agent://all` broadcast plus IRC roster; DSH's shared board plus pairwise messages;
  Claude teams' direct messages plus shared task list; Codex's addressed mailbox
  messages. If a real group channel is a hard requirement, it is a plugin you build
  (DSH) or a protocol you invent — none ship it.
- **Multi-agent costs 4–12x tokens** (Codex Ultra community reports; Claude docs warn
  about usage limits; same physics everywhere). Cap it with cheap worker models and
  per-agent effort.
- **Teams are experimental in both DSH and Claude Code.** Expect churn, and expect the
  shipped bundle to trade plain subagents for team tools.
- **DSH is a young RC** (repo created 2026-08-13, version 0.2.1-rc.2). Package READMEs
  are good; public docs are thinner; a couple of inspector surfaces were rough when
  probed. The plugin ecosystem (311 indexed at last count, per
  `docs/ideas-from-other-harnesses.md`) is large but uneven quality.
- **omp is a fork with a small core team** (Stencil Labs); big built-in surface, high
  release velocity, highest single-maintainer risk of the three.
- **Pi intentionally does none of this.** Choosing Pi for this architecture means
  writing the orchestration layer yourself, which is coherent (it is the point of Pi)
  but not a shortcut.

## What to change on this machine

1. `presets/orchestrator/cordis.patch.yml`: `tool-subagent` has no `maxDepth`, so it
   falls back to the host default of **1** — children cannot delegate further. Add
   `maxDepth: 2` (or 3) to both `tool-subagent` instances. Verify where the live
   composition sets it, because the Web preset editor overrides file config by id.
2. `tool-workflow` is marked disabled in that file but is present live; keep it enabled
   and use it for deterministic DAG runs (audits, migrations, adversarial review), while
   teams handle long-running peers and the board handles progress. `workflow-ptc` can
   stay off.
3. Create team tasks with `write_scopes` and `blocked_by`; on write-heavy slices prefer
   one worktree per task (the worktree bundle and skill are both installed). Treat write
   scopes as warnings, not locks — bash can always bypass them.
4. Wire the other harnesses in only where they earn it: `omp acp` for omp's LSP/DAP and
   mechanical isolation, `dsh-subagent-claude-code` for Claude's agent loop, Codex for
   OpenAI models. All three backends are 0.0.1-rc.1 — experimental.
5. Keep omp as the power terminal and Pi as the lab. The installed Pi is 0.74.0 while
   npm ships 1.4.0; upgrading is the precondition for anything Pi Durable-shaped.

## Sources

- DSH repo and package READMEs: `@deepseek-ai/dsh-tool-subagent`,
  `dsh-experimental-tool-agent-team`, `dsh-experimental-agent-team`,
  `dsh-experimental-agent-team-profile`, `dsh-tool-workflow`, `dsh-acp` (installed
  profile tree); [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Pi: [pi.dev](https://pi.dev/), [docs](https://pi.dev/docs/latest), installed
  `docs/usage.md` (explicit no-subagents note), [Pi Durable](https://earendil.com/posts/pi-durable/),
  [github.com/earendil-works/pi](https://github.com/earendil-works/pi)
- omp: [omp.sh/docs](https://omp.sh/docs), repo docs `magic-keywords.md`, `tools/task.md`,
  `tools/eval.md`, `collab.md`, `agent-hub.md`, `task-agent-discovery.md`,
  [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- Claude Code: [dynamic workflows](https://code.claude.com/docs/en/workflows),
  [agent teams](https://code.claude.com/docs/en/agent-teams),
  [subagents](https://code.claude.com/docs/en/sub-agents),
  [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Codex/ChatGPT: [subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents),
  Codex prompt source `codex-rs/prompts/src/model_messages/multi_agent.rs`,
  [github.com/openai/codex](https://github.com/openai/codex)
- Version/star/download checks: `npm view`, `api.github.com/repos/*`,
  `api.npmjs.org/downloads/point/last-month/*` on 2026-10-25.
