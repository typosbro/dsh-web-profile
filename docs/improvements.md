# Improvements: what shipped, what is blocked, and what else is on the table

The first list (in `ideas-from-other-harnesses.md`) was a survey. This is the build log: what
became real, what cannot be installed on this harness version, and what else is worth doing
that the survey missed.

## Shipped in this repo

| Idea | What it became | Where |
|---|---|---|
| Context economics | `context-audit.mjs` separates resident cost (AGENTS.md + skill descriptions, every request) from on-demand skill bodies, finds repeated rules, and catches skill-name collisions that make a skill unreachable. | `scripts/context-audit.mjs`, `skills/context-audit/` |
| Repository map | `repo-map.mjs` ranks files by symbols, recency, and role, and fits the map to an explicit token budget. Regex symbols, no parser dependency. | `scripts/repo-map.mjs`, `skills/repo-map/` |
| Isolation | `wt.sh` creates one worktree per task beside the repo, runs the gate on finish, and never merges. | `scripts/wt.sh`, `skills/worktree/` |
| Diff-level review gate | The stop hook now runs `scripts/agent-review.sh` after a passing gate and blocks on a credential, a conflict marker, or a `debugger` statement. A ready template is provided. | `hooks/stop-gate.sh`, `examples/agent-review.sh` |
| Model A/B benchmark | `bench/run.mjs` runs one task on two routes and keeps both transcripts, durations, and exits. | `bench/run.mjs` |

## Previously blocked on the harness version — resolved 2026-10-26

The ecosystem plugins named in the survey target `@deepseek-ai/dsh-*@^0.2.1-rc.2`. The profile
runs `0.2.1-rc.2` (pinned in `bootstrap.sh:14`), so the peer ranges are satisfied and these are
mountable, pending an owner decision:

- `dsh-tool-search@0.1.8` (progressive tool schema disclosure)
- `dsh-llm-fallbacks@0.6.8` (provider fallback chains)
- `dsh-continual-evolve@0.19.3` (trace-driven self-improvement)
- `dsh-usage-meter@0.1.3`, `dsh-browser@0.1.0`, `dsh-cron@0.1.0` (lower risk, still unverified)

Two paths: upgrade the harness to a `0.2.1-rc.*` build and re-run `doctor.sh`, or implement the
missing behaviour locally against the alpha API. Upgrade first; the plugins are written for the
newer seams.

Not on npm under the surveyed names: `dsh-context-doctor`, `context-pruner`,
`dsh-agent-loop-guard`, `worktree-mgr`, `review-gate`, `DeepJIT`. Their ideas are partly covered
here by scripts; a real loop guard needs a per-tool-call hook, which the alpha profile does not
expose to shell hooks.

## Other improvements the survey missed

### Context

- Audit tool schemas, not only text. A large MCP surface is a fixed cost per request; count the
  schemas and drop servers nobody uses.
- Trim skill descriptions first: they are resident, bodies are not.
- Load AGENTS.md per repository rather than one global file plus exceptions. The resident cost
  follows the task.

### Tool ergonomics

- Write failure strings for recovery, not for logs: what was attempted, what the state is, what
  to do next. A stale element ref should say "re-read the page", not "error 400".
- Batch browser actions with stop-at-first-failure and an explicit "not executed" result for the
  skipped tail.
- Prune screenshots on a cadence (keep the last three, every N turns), not per turn, so the
  prompt prefix stays cacheable.

### Verification

- Run the gate on the diff, not the whole repo, when the repo is large: changed files first,
  full suite before merge.
- Quarantine flakes instead of retrying forever; a flaky gate teaches the agent to ignore gates.
- Require proof in the stop reason: a command and its exit code, not "tests pass".

### Model routing

- Route utility calls (titles, summaries, classifiers) to a cheap model so the main model spends
  its budget on the task.
- Default effort per task type: mechanical edits low, debugging high, design max.
- A fallback chain turns a 429 from a dead turn into a slower turn. Worth the plugin once the
  harness is upgraded.

### Memory and handoff

- After compaction, re-read the last few edited files. A summary loses exact code; the files do
  not.
- Prefer a handoff file over a longer context: a fresh session with a good brief beats a session
  that remembers everything badly.
- Keep the memory index short and prune it; an index that lists everything is not an index.

### Parallelism

- One worktree per task (shipped).
- One writer per file; reviewers read, they do not edit.
- A merge queue, even a manual one, prevents two green branches from conflicting silently.

### Observability

- Track gate block rate: a gate that never fires is decoration, a gate that fires every turn is
  too strict.
- Track tokens per task, not per session; the session number hides which task was expensive.
- Run the A/B bench before and after a harness change, or the change is a vibe.

### Security

- Secret scanning belongs in the review stage (shipped) and in a pre-commit hook.
- Permission presets are a policy, not a sandbox. Untrusted repositories need a real one.
- Never mount a plugin that can read `~/.dsh/.credentials.yaml` without reading its code first.

## What "all of them" should mean next

1. Upgrade to a `0.2.1-rc.*` harness and re-run `doctor.sh` before installing any ecosystem
   plugin.
2. Install `dsh-tool-search` and `dsh-llm-fallbacks` first; they change every request.
3. Add a per-tool-call loop guard only after the upgrade; there is no honest shell-hook version.
4. Keep the bench in CI: one task, two routes, daily. Harness regressions look like model
   regressions until you measure.
