# Upgrading to 0.2.1-rc.2

The ecosystem plugins target `@deepseek-ai/dsh-*@^0.2.1-rc.2`. This profile pins
`0.2.1-alpha.1`, and `alpha.1` sorts below `rc.2`, so the peer ranges never satisfy. `rc.2` is
also npm's `latest` (published 2026-10-17).

## Tested, not assumed

The upgrade was rehearsed against an isolated prefix and a copy of a real profile:

| Check | Result |
|---|---|
| `npm install @deepseek-ai/dsh@0.2.1-rc.2` into a separate prefix | installed, `dsh --version` prints `0.2.1-rc.2` |
| This repo's profile composed by rc.2 | 311 rows, no failed imports |
| Boot on a spare port | HTTP 200, no `failed to import` |
| A copy of a live profile (relay, SearXNG bundle, three local plugins, hook bridge) | HTTP 200, no failed imports |
| `dsh-tool-search@0.1.8` + `dsh-llm-fallbacks@0.6.8` added as bundles | rows composed, boot clean |

## What the alpha supplied implicitly

Three packages arrived transitively under `alpha.1`. Under `rc.2` the profile has to declare
them, or the plugin row fails at boot:

- `@deepseek-ai/dsh-hooks-claude-code` — the hook bridge itself. Without it the stop gate
  silently disappears.
- `@deepseek-ai/dsh-hook-protocol` — its runtime dependency.
- `@deepseek-ai/schemastery` — needed by a local plugin that declares it as a dependency.

Also: `pnpm` does not install the dependencies of a `link:` package. A local plugin with its own
`dependencies` needs `pnpm install` inside its directory, or its imports fail at boot
(`@local/browser-live` was the one that caught this).

## Cutover

```bash
# from a terminal, when no turn is in flight
scripts/upgrade.sh 0.2.1-rc.2
# then restart the harness
dsh web
```

The script backs the profile up to `profiles/web.bak.<timestamp>`, installs the target harness,
bumps every exact `@deepseek-ai/*` dependency, adds the three packages above, installs plugin
dependencies, and re-composes the profile. It does not restart anything.

Rollback:

```bash
ROLLBACK=1 scripts/upgrade.sh 0.2.1-alpha.1
```

## Why not from inside a session

`dsh web` hosts the conversation. Restarting it kills the process mid-turn, so an agent that
restarts the harness cannot report the result of its own upgrade. Two more reasons to keep the
cutover outside:

- Replacing the global install while the old process runs can mix versions on a lazy import.
- A conversation that is being served by the process you are about to kill loses its in-flight
  response. Sessions persist on disk; the current turn does not.

Do the install and the restart in the same window, from a terminal or from a second agent that
is not itself running under the harness being replaced.

## After the upgrade

```bash
./doctor.sh
```

Then install the plugins that were blocked. Start with the two that change every request:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-tool-search dsh-llm-fallbacks
```

Add `dsh-tool-search` and `dsh-llm-fallbacks` to `dsh.profile.bundles`, then restart. The rest
of the blocked list (`dsh-usage-meter`, `dsh-browser`, `dsh-cron`, `dsh-continual-evolve`) is
lower risk but still unaudited; read the code before mounting anything that can read the
credential store.
