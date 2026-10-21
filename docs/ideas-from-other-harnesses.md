# What the ecosystem is doing better

A survey of the DeepSeek Harness plugin ecosystem and the neighbouring agent harnesses, filtered
for one question: what would make this profile produce better work, not just more features?

Sources are listed at the bottom. Plugin behaviour is as described by the directory; I have not
audited every repository, so treat the specifics as claims to verify before installing.

## The ecosystem in one paragraph

DSH's "everything is a plugin" design produced a large third-party surface quickly: the
independent directory indexes 311 plugins across interaction, tools, memory, content,
integrations, automation, and development. A `dsh-plugin` topic and a plugin template exist, and
distribution repos already package the harness for Windows and as a desktop app. That is a
healthy sign for a young harness, and it means most missing capabilities are a plugin install
rather than a fork.

## Where other projects are ahead of this profile

### 1. Context economics

- `dsh-context-doctor` audits injected context for token cost, duplication, and conflicting
  instructions or schemas. This profile has no equivalent, and duplicate or contradictory
  instructions are a silent quality killer.
- `context-pruner` prunes stale, repeated, failed, and oversized context before compaction, which
  is cheaper than summarising and preserves more signal than a summary.
- `dsh-tool-search` discovers tools on demand with progressive schema disclosure. With a large
  MCP surface, tool schemas are a fixed cost on every request; disclosure makes that cost
  proportional to use.
- `dsh-agent-budget` controls token budgets across an agent tree, which is the multi-agent
  version of the same problem.

Lesson: the context window is a budget with several line items (system prompt, tool schemas,
tool results, screenshots, summaries). Optimising only compaction is optimising the last line
item.

### 2. Loop reliability

- `dsh-agent-loop-guard` intercepts repeated tool calls and repetitive assistant output and
  cancels runaway loops through lifecycle hooks. This profile's stop gate prevents ending on a
  broken tree; it does not prevent burning an hour on the same failing command.
- `dsh-llm-fallbacks` applies role-based retry and fallback policies across models, so a 429 or a
  dead key degrades instead of ending the turn.
- `dsh-tool-approval`, `safety-net`, and `secret-guard` put policy in front of tool execution:
  approval modes, destructive-command interception, secret masking.

Lesson: harness quality is dominated by failure behaviour. A mediocre model with a loop guard and
a fallback chain beats a good model that stalls.

### 3. Verification as a pipeline

- `review-gate` (deterministic severity rules plus LLM findings and approval quorum),
  `adversarial-review` (parallel lenses), and `dsh-llm-verifier` (ranks independent patches
  before applying one) all treat verification as a stage, not a sentence in the prompt.
- `dsh-test-drive` runs isolated install-and-smoke tests for plugins with structured pass/fail.

This profile's stop gate is the smallest version of the same idea: the repository decides, not
the model. The next step is a review gate that runs on the diff, not only the test suite.

### 4. Learning from traces

- `DeepJIT` mines agent execution traces and compiles recurring workflows into reusable skills
  and flow templates.
- `dsh-continual-evolve` persists and refines prompt notes, memories, skills, and subagent specs
  with rollback and benchmark validation.
- `distill` distils conversations in the background through subagent reflection and skill
  updates.

Lesson: a harness that only reads its config never improves. A harness that reads its own
traces can. This is the highest-upside, highest-risk category: self-modification needs a
benchmark and a rollback, or it optimises for plausible prose.

### 5. Long-running and parallel work

- `dsh-goal`, `dsh-loop`, `dsh-cron`, `dsh-sentinel`, and `dsh-automation` cover goals,
  recurring runs, schedules, watchers, and fresh-session automation.
- `worktree-mgr` and `dsh-worktree-flow` isolate each task in its own git worktree, which is the
  only safe way to run several agents on one repository.
- `dsh-agent-teams` and `dsh_workflow` coordinate multiple agents; `dsh-moa` runs parallel
  proposals with a judge.

The base harness already has goals, schedules, subagents, and worktrees. What is missing here is
the discipline of one worktree per task and a merge step that is not "the agent said it worked".

### 6. Desktop and browser control

- `dsh-browser` drives the user's real browser through a Chrome extension and a text-based tool
  surface, instead of a fresh headless profile.
- `dsh-computer-use` and `computer-control` are accessibility-first: they read the OS
  accessibility tree and act by element, with pixels as fallback.
- `dsh-codex-computer-use` bridges the Codex desktop runtime into DSH.

This matches the split documented in the harness-internals note: refs for webpages, pixels only
when there is no tree, and the user's real session when the task depends on their logins.

## What the big harnesses still teach that no plugin covers

- Repository map. Aider's tree-sitter-ranked map of the repo is a better context primitive than
  a directory tree snapshot: it ranks by symbol importance and fits a token budget. Nothing in
  the DSH directory does this yet.
- Checkpoints and rewind. Cline's checkpoints and DSH's own `dsh-turn-rewind` point at the same
  need: undo a turn, not just edit a message.
- Sandbox runtime. OpenHands isolates execution in a container; DSH's sandbox plugins are
  partial (microsandbox, mxc, nono). The profile default (`workspace-write`) is a policy, not an
  isolation boundary.
- Minimal loop. mini-swe-agent is a few hundred lines and competitive on SWE-bench-style tasks.
  It is a useful reminder that most harness complexity is optional.
- Plan/act separation. Cline and Claude Code's plan mode front-load a reviewable plan. This
  profile relies on the model choosing to plan; a mode that forbids edits until a plan is
  approved is a stronger contract.

## Ranked adoptions for this profile

1. `dsh-context-doctor` + `dsh-tool-search`: measure and shrink the fixed context cost before
   adding anything else.
2. `dsh-agent-loop-guard` + `dsh-llm-fallbacks`: make failure boring.
3. A diff-level review gate as a second hook, after the existing stop gate.
4. `worktree-mgr` for multi-agent work; one worktree per task, always.
5. Repository map as a local tool (tree-sitter + token budget) if no plugin lands first.
6. Trace mining (`DeepJIT` or `continual-evolve`) only with a benchmark and rollback in place.

## Sources

- Plugin directory (311 entries): https://github.com/HackSing/dsh-plugins
- Plugin topic: https://github.com/topics/dsh-plugin
- Official harness: https://github.com/deepseek-ai/deepseek-harness
- Harness comparison: https://winder.ai/ai-agent-harness-comparison/
- Claude Code, Codex, and computer-use internals: `reference/agent-harness-internals-2026-10.md`
  in the author's memory repo.
