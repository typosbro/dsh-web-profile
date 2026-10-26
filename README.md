# dsh-web-profile

A reproducible profile for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
web GUI, phone-sized shell, installable PWA, a pinned Playwright browser stack, and a
stop-gate plugin that refuses to end a turn on "looks done" when the repository has a gate.

This is the "everything is a plugin" harness configured the way an agent actually needs to run:
a declarative patch layer, pinned versions, a doctor that proves the composition, and no
credentials in the tree.

## Quickstart

```bash
git clone https://github.com/<you>/dsh-web-profile.git
cd dsh-web-profile
./bootstrap.sh          # installs dsh 0.2.1-rc.2, the profile and plugins
dsh web                 # http://127.0.0.1:3080/
```

## Two hosts, one patch layer

The same plugin files run under either host:

- **Linux / CLI** — `./bootstrap.sh` installs the `web` profile, then `dsh web`.
- **macOS / Desktop app** — `./install-desktop.sh` copies the same `mobile-shell/`,
  `web-pwa/` and `gate/` directories into `~/.dsh/profiles/desktop` and merges the
  same three rows into the app-managed patch layer inside a marked block
  (`--uninstall` removes them). Quit and reopen the app to apply.

The stop gate is a plain host plugin (`gate/index.mjs`) that listens to
`agent/turn-stopping`, runs the repository's gate, and steers a message back when it
fails. It replaces the earlier `@deepseek-ai/dsh-hooks-claude-code` row: that package
is not shipped by the Desktop app and peer-depends on the whole 0.2.1 stack, so a
machine without the dsh CLI could never mount it. The `hooks/` directory and the
Claude Code bridge were removed on 2026-10-26: the bridge is not mounted in any
profile here, so the hook file could never run, and a dead hook file is worse than
none — someone edits it and believes it is enforcing something.

Requirements: Linux or macOS, Node 22+, pnpm (`corepack enable`), `rsync`, `python3`, and a
system Chrome/Chromium for the browser tools.

Model access is deliberately not installed. Set `DEEPSEEK_API_KEY` in `~/.dsh/.env` for the
native route, or add an OpenAI-compatible provider with `examples/providers.cordis.patch.yml`.
See [docs/models.md](docs/models.md).

`dsh --profile headless "task"` is the scripting path, and its profile carries no provider
rows — it keeps the base `deepseek-official` route and fails `MISSING_CREDENTIAL` when that
key is absent. Mirror the web route for one run with
[`profiles/headless/headless-providers.cordis.patch.yml`](profiles/headless/headless-providers.cordis.patch.yml):

```bash
dsh --profile headless --patch "$PWD/profiles/headless/headless-providers.cordis.patch.yml" "task"
```

Permanent form and credential caveats: [profiles/headless/README.md](profiles/headless/README.md).

Re-running: `FORCE=1 ./bootstrap.sh` replaces the profile and keeps a timestamped backup.
Verify any install with `./doctor.sh`.

## What you get

| Layer | What it does | Where |
|---|---|---|
| Trusted-host auth skip | clean URLs on loopback and declared `trustedHosts` open without the per-process token; a valid `?token=` still mints the Desktop shell's cookie; Host/Origin fence stays | `profiles/web/remote-auth/` |
| Phone shell | sidebar as overlay drawer, stacked settings nav, dynamic viewport, safe-area insets | `profiles/web/mobile-shell/` |
| PWA | real manifest and icons so Chrome offers an install; no service worker | `profiles/web/web-pwa/` |
| Browser stack | pinned `@playwright/mcp` 0.0.83, headless Chrome, CDP side-channel for the pane | `plugins/playwright-browser/`, `plugins/browser-pane/`, `plugins/browser-live/` |
| Stop gate | repository's own `gate` script blocks the end of a turn, max two blocks | `profiles/web/gate/` |
| Cross-session messaging | `talk_to_session` addresses any live session by id or working directory | `profiles/web/session-message/` |
| Permissions | read-only / workspace-write / danger-full-access presets | `profiles/web/cordis.patch.yml` |
| Agent presets | `orchestrator` (acts first, escalates decisions, chooses team vs subagent vs workflow) and `worker` (lean child: no delegation, no web, no schedule, no deploy) | `presets/orchestrator/`, `presets/worker/` |

### Enabled on the author's Mac (2026-10-23)

The profile in this repo mirrors one real machine, so `bootstrap.sh` reproduces it
exactly. The bundle list is the source of truth:

`dsh-base`, `dsh-web-app`, and the official experimental bundles
`dsh-experimental-voice-input-bundle`, `dsh-experimental-agent-team-profile`,
`dsh-experimental-session-search`, `dsh-experimental-session-titles-bundle`,
`dsh-experimental-tool-worktree`, plus `@local/dsh-web-search-local` from
`plugins/web-search`.

Declined on this machine and kept in the tree as optional: the **phone shell**
(`mobile-shell/`), the **PWA** (`web-pwa/`) and the **browser stack**
(`plugins/playwright-browser`, `browser-pane`, `browser-live`). Their dependencies
still install; their rows are simply not mounted. Add the rows back to
`cordis.patch.yml` to enable them.

Permissions default to `danger-full-access` here, by owner decision: this is a
single-user machine and the agent edits outside the workspace constantly. Clone it
knowing `approval: never` removes the last prompt before a destructive command.

The experimental bundles ship inside `dsh`, not the profile, so they need no
version pinning — reproducing them requires only the `bundles` array above.

## Reproducing this machine

`./bootstrap.sh` is the whole install: it links dsh, installs the profile, copies
`plugins/` and `presets/` into `$DSH_HOME`, syncs `skills/` into `$DSH_HOME/skills`,
installs the profile's dependencies from the frozen lockfile, and runs the doctor.

Everything needed to rebuild is in git **except** deliberate machine state:

- `dsh-relay` pairing — the relay's password and the per-device bearer tokens live
  in the relay's `stateDir`, never in this repo. After a rebuild, set the password
  again at `https://127.0.0.1:3443` and re-pair the phone.
- `~/.dsh/.credentials.yaml` and `~/.dsh/.env` — API keys, never committed.
- Sessions, attachments, scored state — `$DSH_HOME`.

`dsh-relay` itself is pinned to the head of
[PR #12](https://github.com/sorsama/deepseek-harness-relay/pull/12)
(`hazyumps/deepseek-harness-relay@36321a6`, version 0.3.1): the published
`0.2.1` tarball's client half waits on the removed `settingsScope` service, so
the web boot fails on dsh 0.2.x, and its host bundle predates the harness
browser-session signing, so paired devices get 401. Move back to the registry
once a fixed 0.3.x is published.

The browser stack (`plugins/playwright-browser`, `browser-pane`, `browser-live`) is
kept in the tree but its dependencies are no longer declared, because this machine
does not enable it. Add them back with:

```bash
dsh plugin --profile web add @playwright/mcp
pnpm --dir "$HOME/.dsh/profiles/web" add @local/browser-pane @local/playwright-browser @local/browser-live
```

## Toolbox

Dependency-free scripts, plus skills that teach the agent when to run them:

- `scripts/repo-map.mjs` — ranked, token-budgeted map of a repository. A directory tree says
  what exists; this says what matters.
- `scripts/context-audit.mjs` — separates resident context cost (AGENTS.md plus skill
  descriptions) from on-demand skill bodies, finds rules written three times, and catches
  skill-name collisions.
- `scripts/wt.sh` — one git worktree per task, beside the repo, with the gate run on finish.
- `scripts/consult-codex.sh` — one-shot second opinion from OpenAI Codex
  (`codex exec … --json`, read-only): a diff review, a claim check, or a GPT-family answer on
  a separate quota. Paired skill: `skills/consult-codex/`.
- `scripts/usage-meter.mjs` — per-turn and per-session token totals from the persisted
  `session.v4.jsonl.zstd` logs (input / output / cache-read), for a daily brief.
- `scripts/night-batch.sh` — dry-run-first skeleton for unattended headless batches: explicit
  task list, hard caps, coarse no-external-sends guard, briefs under `docs/agent-os/runs/`.
  Needs the headless route (below) and a valid credential.
- `profiles/web/gate/index.mjs` — the live stop gate: runs the repository's gate, then a
  diff-level review stage that blocks on leaked keys, conflict markers, and `debugger`
  statements. At most two forced continuations per session.
- `bench/run.mjs` — runs one task on two model routes and keeps both transcripts, exits, and
  durations. Harness changes get measured, not argued.

The matching skills live in `skills/` (`repo-map`, `context-audit`, `worktree`); copy or symlink
the directories into your skill root. See [docs/improvements.md](docs/improvements.md) for what
else is worth doing and what is blocked on the harness version.

## Why a profile at all

DSH composes a profile as layered patches: bundle layers first, then
`profiles/<name>/cordis.patch.yml`, then any `--patch` overlay. Every row added here is a
decision with a reason, and the reason is written next to the row. That is what makes the setup
reviewable instead of a pile of settings: an entry that cannot justify itself gets deleted.

The short version of why this exists: the same model produces different work under a different
harness. A gate that runs the tests changes the output more than a temperature knob does, and a
subagent that throws away its search noise changes the context budget more than a longer system
prompt does. See [docs/why-these-rows.md](docs/why-these-rows.md).

## What is not in this repo

- Credentials, sessions, tokens, browser profiles, and the credential store.
- Personal skills and memory files. The `briefing` skill is included as an example of a
  structured output contract.
- The author's tailnet, relay hostnames, SearXNG instance, and multi-account model keys. Those
  are opt-in modules, documented in `examples/`.

## Replication, honestly

`bootstrap.sh` pins the harness version and the profile dependencies, installs the same patch
layer, and `doctor.sh` fails loudly when the composition is wrong. What cannot be replicated:

- model access (your key, your provider, your quota);
- the host (Chrome binary, fonts, GPU, display);
- anything you keep in `~/.dsh` outside this profile (credentials, sessions, personal skills).

See [docs/replication.md](docs/replication.md) for the exact guarantees and the upgrade path.

## License

MIT. The Playwright MCP server it pins is Apache-2.0; DeepSeek Harness is MIT.

## Documentation

- [docs/why-these-rows.md](docs/why-these-rows.md) — the decision log for every patch row.
- [docs/models.md](docs/models.md) — native, OpenAI-compatible, and subscription routes.
- [docs/replication.md](docs/replication.md) — what is guaranteed, what is not, upgrade path.
- [docs/improvements.md](docs/improvements.md) — shipped ideas, blocked plugins, next steps.
- [docs/upgrading.md](docs/upgrading.md) — moving to 0.2.1-rc.2 and unlocking the plugin ecosystem.
- [docs/ideas-from-other-harnesses.md](docs/ideas-from-other-harnesses.md) — the survey that
  started this.
- [docs/agent-os/README.md](docs/agent-os/README.md) — unattended runs: night batch, briefs,
  per-run token spend, and the safety model.
- [docs/harness-comparison-2026-10.md](docs/harness-comparison-2026-10.md) — DSH vs Pi vs omp,
  how Claude Code and Codex do teams and workflows, and what this profile borrows.
- [docs/orchestration-repos-and-context-budget-2026-10.md](docs/orchestration-repos-and-context-budget-2026-10.md)
  — public orchestration repos worth copying, plus the instruction and skill budget evidence.
