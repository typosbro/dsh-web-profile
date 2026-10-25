# Orchestration repos and the instruction budget, 2026-10-25

Two questions: which public repos implement the orchestrator/DAG/nested-agents/coordination
pattern best, and whether instructions should be minimized or increased — including skills.
Evidence is dated 2026-10-25 unless noted. Star counts fetched before GitHub's anonymous rate
limit ran out; DSH plugin candidates come from the curated directory and carry no star figure.

## Part 1 — repos that do it best

No single repo ships the whole quartet (orchestrator, dependency DAG, nested delegation,
group coordination) with a usable UI. The best results are a composition: a runtime, an
isolation rule, and an observability layer.

### A. DSH-native (fits this machine)

| Repo | ★ | What it does | Fit |
|---|---|---|---|
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 2.4k | Captain-led team with durable members, **dependency-aware task DAG**, direct mailbox messages, live Web UI with task DAG, plan → **Approve & Run**, opt-in quality gates (requirements → implementation → verification → review → integration) | **Closest single repo to the target architecture.** Recommended pair: DSH 0.2.1-rc.2 + plugin 0.1.26. Third-party: audit before installing |
| first-party `@deepseek-ai/dsh-experimental-agent-team-profile` | — | Already mounted here: roster, shared board, mailboxes | What you have now; fewer scheduler/quality-gate features |
| [ff66ccff/dsh-ATN](https://github.com/ff66ccff/dsh-ATN) | — | Adaptive-topology multi-agent preset: peer messaging, task handoff, live network visualization | Topology experiments + message inspection |
| [Tisitan/dsh-my-go](https://github.com/Tisitan/dsh-my-go) | — | Lead dispatches a role roster over separate read/write lane pools with per-role model bindings | Per-role model routing |
| [mrzturn/dsh-switchman](https://github.com/mrzturn/dsh-switchman) | — | Main model becomes a dispatcher: six pools (economy/mechanical/main/hard/vision/review) route each subtask | Model routing / cost control |
| [FelixJiashengFu/dsh-force-collab](https://github.com/FelixJiashengFu/dsh-force-collab) | — | Forces every hands-on task to be split across exactly N child agents | Enforcing delegation instead of trusting prose |
| [wuanthony397-hash/dsh-codex-peer](https://github.com/wuanthony397-hash/dsh-codex-peer) | — | DSH ↔ local Codex CLI peer collaboration: shared work list, hand tasks, review results | Cross-harness workers |
| [lj100886/dsh-team-canvas](https://github.com/lj100886/dsh-team-canvas) | — | Swimlane canvas above the composer; tasks laid out by **longest dependency path** | The DAG view the target design wants |
| [xx529/dsh-task-gantt](https://github.com/xx529/dsh-task-gantt) | — | Per-teammate swimlane Gantt of shared tasks from real session-log time | Progress/coordination view |
| [dadgrand/dsh-agent-teams-dashboard](https://github.com/dadgrand/dsh-agent-teams-dashboard) | — | Teams sidebar: roster, task roadmap, token spend, online time | Cost/ops view |
| [CAI-MH/dsh-agent-group-panel](https://github.com/CAI-MH/dsh-agent-group-panel) | — | Feishu multi-agent robot console | Literal group-chat surface |
| [Aealen/dsh-coding-workspace](https://github.com/Aealen/dsh-coding-workspace) | — | Parallel git-worktree workbench with cross-session collaboration | Conflict avoidance |
| [BestQ-A/dsh-session-tree](https://github.com/BestQ-A/dsh-session-tree) | — | Sidebar tree of sessions plus nested subagent descendants | Lineage view |
| [KevinZhangNothing/dsh-task-graph](https://github.com/KevinZhangNothing/dsh-task-graph) | — | Interactive DAG of turns, steps, tools, skills, subagents, changes, tests | Debugging a run |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 20.6k | Curated directory + installable market index | Discovery; 462 entries match team/worktree/orchestration keywords |

### B. Cross-harness and workbench

| Repo | ★ | Best at | Caveat |
|---|---|---|---|
| [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | 13.6k | Human-supervised orchestration: desktop workspace, per-worker **branch + worktree**, live kanban of workers/PRs/CI/review | Human-driven planning; not a model-run DAG |
| [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) | 11k | Meta-harness over Claude Code, Codex, Cursor, OpenCode, Hermes, **Pi**: policies, sandboxing, cross-device collaboration, "Polly" tech-lead agent that plans/delegates | Python/PyPI; younger |
| [Devin-AXIS/iPolloWork](https://github.com/Devin-AXIS/iPolloWork) | 7.3k | Local-first agent workbench connecting Codex, **DSH**, OpenCode; team projects/tasks/skills; approvals | Broad workspace product, not a minimal harness |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28k | Kanban planning + per-task worktree workspaces + inline diff review/PRs | No agent-to-agent messaging |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8.7k | tmux + git worktrees, one agent per workspace | No coordination layer beyond isolation |

### C. Claude Code-first

| Repo | ★ | Best at | Caveat |
|---|---|---|---|
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 40k | Teams-first orchestration: `/team` staged pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`), autopilot workflow stages, Ralph loop, tmux workers, cross-provider `ask` | Claude Code runtime; needs native teams flag; also [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) |
| [ruvnet/claude-flow](https://github.com/ruvnet/ruflo) (now RuFlo) | 79k | Full meta-harness: swarms, goals, vector memory, console, plugin/mod surface | Heaviest option; large surface to trust and maintain |

### D. Instruction/persona libraries — not orchestration

[bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) (54.5k),
[SuperClaude-Org/SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) (23.9k),
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (163.8k),
[jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) (21.6k).
These provide personas, commands, and process documents. They do not run a DAG, a board, or
mailboxes. Useful as content for skills; not as the runtime.

[hesreallyhim/ultracode-workflows](https://github.com/hesreallyhim/ultracode-workflows) (8★) is a
tiny but readable set of Claude Code workflow scripts; good for stealing script patterns.

### Patterns the good ones share

1. **Plan → approve → run.** A draft roster and DAG is staged, a human approves, only then is
   scheduling enabled (dsh-agent-teams; oh-my-claudecode's autopilot stages).
2. **One worktree/branch per worker.** agent-orchestrator, vibe-kanban, claude-squad,
   oh-my-claudecode. This is the only reliable conflict fix; advisory scopes are not.
3. **Dependency-aware claims.** A task cannot be claimed before its blockers finish
   (dsh-agent-teams). The board is the coordination substrate; messages are secondary.
4. **A verifying stage with teeth.** `team-verify`/`team-fix` (oh-my-claudecode) and the
   requirement→implementation→verification→review→integration contracts (dsh-agent-teams).
5. **Live view of the run.** Kanban/Gantt/DAG/swimlane, token spend, per-agent transcripts.
6. **Per-role model routing.** switchman/my-go route cheap work to cheap models.

### Verdict

- Stay on DSH: **dsh-agent-teams + worktree isolation + one DAG/Gantt view**. Optionally
  `dsh-codex-peer` or `dsh-switchman` for cross-model workers. This is the closest thing to
  the stated architecture that exists as a maintained repo today.
- Leave DSH: **oh-my-claudecode** for a batteries-included team pipeline on Claude Code;
  **agent-orchestrator** for human supervision with worktree isolation; **omnigent** for a
  meta-harness over all of them.
- None of these gives agents a literal chat room; the group surfaces are mailboxes + board +
  an external console (Feishu, dashboard) or nothing.

## Part 2 — minimize or increase instructions?

Verdict: **minimize what is resident on every request; increase what is on-demand and
deterministic.** The goal is not "fewer words", it is the smallest set of high-signal tokens
that produces the behaviour, with the rest moved to skills, tools, hooks, tests, or files.

### Evidence

- **IFScale** (arXiv:2507.11538, Jul 2025): 500 keyword-inclusion instructions in one prompt;
  the best frontier models reach only **68%** at max density, degrade non-uniformly, and show a
  **bias toward earlier instructions**. Practical reading: every instruction added dilutes the
  ones after it; late rules are the first casualties.
- **Context rot** (Chroma, Jul 2025): accuracy degrades as input length grows, even on trivial
  tasks; the degradation is non-uniform and real across models.
- **Anthropic, "Effective context engineering"** (Sep 2025): LLMs have an **attention budget**;
  "find the smallest possible set of high-signal tokens"; system prompts should sit at the
  "right altitude" (specific enough to steer, flexible enough for heuristics) and avoid both
  brittle if-else prose and vague filler; prefer **canonical examples** over laundry lists of
  edge cases; keep the tool set minimal and non-overlapping; retrieve just-in-time instead of
  pre-loading.
- **Anthropic, Agent Skills** (Oct 2025): the answer to context pressure is **progressive
  disclosure** — metadata at startup, body on demand, linked files deeper, code as a resource.
  Skills are preloaded by name+description into the system prompt; that is the only part that
  costs every turn.

### The decision ladder

| Tier | Where it goes | Rule of thumb |
|---|---|---|
| 0 | Hook, gate, permission, test, linter, CI | If it must hold, enforce it; prose is advisory |
| 1 | AGENTS.md / persona / system prompt | Only what applies on every request; high-signal, no duplication |
| 2 | Skill (name + description resident, body on demand) | Reusable procedure, checklist, branchy workflow |
| 3 | Repo file / doc / reference | Large or rarely needed: read on demand |
| 4 | Memory file, goal, task board | State that must survive turns/sessions |
| never | Duplicated rules, stale rules, restatements of tool behaviour, conflicting style guides | Delete |

### Practical rules

1. **Evaluation first.** Add a rule only after an observed failure on a representative task;
   delete rules that no longer map to a failure.
2. **Prefer the stronger medium.** Test, hook, script, or permission preset over a sentence;
   a skill with a script over a prose checklist; a tool schema over "remember to call X".
3. **One copy.** Three copies of a rule is a stale rule; keep it in one tier and link.
4. **Descriptions are the tax.** For model-invoked skills, the description is the resident
   cost; bodies are not. Prune descriptions first.
5. **Make optional style skills user-invoked** (`disable-model-invocation`) — zero context load,
   at the cost of you remembering they exist.
6. **Prune tool schemas per agent.** A worker preset that cannot use `schedule`, `jobs`,
   `present`, or `web` should not pay for their schemas. In DSH this is a preset-level lever,
   and it usually saves more than editing prose.
7. **Measure, don't debate.** Snapshot resident tokens, A/B the change on real tasks, keep
   what moves the failure rate.
8. **Beware the two failure modes.** Over-instruction: brittle, stale, dilutes attention.
   Under-instruction: the model invents conventions. The cure for the second is not prose —
   it is affordances, repo conventions, tests, and examples.

## Part 3 — skills

### Mechanics

A skill is a directory with `SKILL.md`:
1. **Level 1**: `name` + `description` in the system prompt — always resident.
2. **Level 2**: `SKILL.md` body — loaded when the model decides the skill is relevant (or you
   invoke it).
3. **Level 3+**: linked files, scripts, templates — read or executed only as needed.

Model-invoked skills pay description tokens every turn and can be selected autonomously.
User-invoked skills (`disable-model-invocation: true`) pay nothing but depend on you as the
index. Skills can bundle code, which is the cheapest and most reliable way to make a step
deterministic.

### When a skill is the right answer

- A procedure you repeat, with a stable order and checkable steps.
- Domain knowledge that is irrelevant to most turns (audits, release flows, review rubrics).
- A branchy workflow where each branch needs different context (split into reference files).
- A deterministic step (a script the skill tells the model to run, not a list of commands to
  retype).

### When a skill is the wrong answer

- A rule that must always hold → hook/gate/permission/test.
- A one-off fact → memory file or the task prompt.
- Something already expressed by a tool's schema/description.
- A secret or credential (never in a skill).
- Duplicate of an existing skill (collision means one is unreachable).

### This machine's measurement

Run after patching `scripts/context-audit.mjs` to scan `~/.dsh/skills` (it previously scanned
only `.agents/skills`, `.claude/skills`, and `~/agent-memory/skills`, so it reported zero):

```
# context audit — 21 files
resident:  ~1645 tokens (AGENTS.md + 20 skill descriptions, on every request)
on-demand: ~24253 tokens across skill bodies (loaded only when invoked)
largest skill body: 2333 tokens ~/.dsh/skills/writing-great-skills/SKILL.md
```

- Resident split: AGENTS.md 265 tokens + ~1380 tokens of skill descriptions.
- Largest resident descriptions: wise-teacher 130, swarm-remediation 127, swarm-director 118,
  social-audit 96, cto-audit 88, briefing 86. Trimming those six to ~40–50 tokens each saves
  ~400–450 resident tokens with no body changes.
- Bodies are only a problem if invoked often: writing-great-skills (2.3k), diagnosing-bugs
  (2.1k), social-audit (2k), epic (1.9k), swarm-remediation (1.9k), cto-audit (1.8k).
- Overlap to audit: the voice/style skills (`audhd`, `briefing`, `caveman`, `caveman-commit`,
  `wise-teacher`) and the swarm family (`swarm-director`, `swarm-remediation`, `cto-audit`).
  Each pair must have distinct trigger language, or selection becomes a coin flip.
- The catalog in the session prompt shows 18 of the 20 on disk; two are not reachable — likely
  a name collision or a disabled registration. The audit's collision check is the place to
  look.

### Suggested skill budget

- Resident skill catalog: keep under ~1,000–1,200 tokens if you also carry a large system
  prompt and many tools.
- Model-invoked catalog: ~15–25 tight skills is workable; beyond that descriptions start
  fighting. Move personal/rare skills to user-invoked.
- One skill per repeated workflow; split by branch, not by prose section; push references and
  scripts into linked files.

## Sources

- IFScale: https://arxiv.org/abs/2507.11538
- Chroma context rot: https://research.trychroma.com/context-rot
- Anthropic context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic Agent Skills: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Skills docs: https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview
- Local skill-authoring reference: `~/.dsh/skills/writing-great-skills/SKILL.md`
- Repo stars/descriptions: GitHub API, 2026-10-25 (anonymous limit reached partway)
- DSH plugin inventory: `awesome-dsh-plugin/awesome-dsh-plugin` README, plus the first-party
  package READMEs in the installed profile tree
