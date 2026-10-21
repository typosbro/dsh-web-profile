# dsh-web-profile

A reproducible profile for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
web GUI, phone-sized shell, installable PWA, a pinned Playwright browser stack, and a
stop-gate hook that refuses to end a turn on "looks done" when the repository has a gate.

This is the "everything is a plugin" harness configured the way an agent actually needs to run:
a declarative patch layer, pinned versions, a doctor that proves the composition, and no
credentials in the tree.

## Quickstart

```bash
git clone https://github.com/<you>/dsh-web-profile.git
cd dsh-web-profile
./bootstrap.sh          # installs dsh 0.2.1-alpha.1, the profile, plugins, hooks
dsh web                 # http://127.0.0.1:3080/
```

Requirements: Linux or macOS, Node 22+, pnpm (`corepack enable`), `rsync`, `python3`, and a
system Chrome/Chromium for the browser tools.

Model access is deliberately not installed. Set `DEEPSEEK_API_KEY` in `~/.dsh/.env` for the
native route, or add an OpenAI-compatible provider with `examples/providers.cordis.patch.yml`.
See [docs/models.md](docs/models.md).

Re-running: `FORCE=1 ./bootstrap.sh` replaces the profile and keeps a timestamped backup.
Verify any install with `./doctor.sh`.

## What you get

| Layer | What it does | Where |
|---|---|---|
| Loopback auth skip | local GUI opens without the per-process token; Host/Origin fence stays | `profiles/web/no-browser-auth.mjs` |
| Phone shell | sidebar as overlay drawer, stacked settings nav, dynamic viewport, safe-area insets | `profiles/web/mobile-shell/` |
| PWA | real manifest and icons so Chrome offers an install; no service worker | `profiles/web/web-pwa/` |
| Browser stack | pinned `@playwright/mcp` 0.0.83, headless Chrome, CDP side-channel for the pane | `plugins/playwright-browser/`, `plugins/browser-pane/`, `plugins/browser-live/` |
| Stop gate | repository's own `gate` script blocks the end of a turn, max two blocks | `hooks/` |
| Permissions | read-only / workspace-write / danger-full-access presets | `profiles/web/cordis.patch.yml` |

## Toolbox

Dependency-free scripts, plus skills that teach the agent when to run them:

- `scripts/repo-map.mjs` — ranked, token-budgeted map of a repository. A directory tree says
  what exists; this says what matters.
- `scripts/context-audit.mjs` — separates resident context cost (AGENTS.md plus skill
  descriptions) from on-demand skill bodies, finds rules written three times, and catches
  skill-name collisions.
- `scripts/wt.sh` — one git worktree per task, beside the repo, with the gate run on finish.
- `hooks/stop-gate.sh` — runs the repository's gate, then a diff-level review stage
  (`examples/agent-review.sh`) that blocks on leaked keys, conflict markers, and `debugger`
  statements.
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
