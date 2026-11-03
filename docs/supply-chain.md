# Supply chain: when to install, when to build

The rule "the best code is the code you don't write" is right about *large,
generic* code and wrong about *trust boundaries*. This file is the boundary.

## The exposure, precisely

A DSH plugin is not sandboxed. Host-plugin code runs inside the Harness process
with the owner's filesystem, network and credentials; tool approvals do not
gate it. On this machine that means `~/.dsh/.credentials.yaml`, `~/.ssh`,
`~/.dsh/relay` keys, the Discord bot token, `~/.env` files and every session
transcript are readable by any installed plugin, and a plugin update is code
execution with a `pnpm install`.

Skills are not code, but they are instructions the agent follows. A malicious
`SKILL.md` is prompt injection with full tool access: it can tell the agent to
run commands. "It's just markdown" is not a safety property.

## Tiers

| Tier | What | Policy |
|---|---|---|
| 1 | Bundles shipped inside `dsh` (`@deepseek-ai/*`) | install freely, they move with the pinned harness version |
| 2 | Code in this repo (`@local/*`: voice-mode, presets, gate, relay pin) | owned here, reviewed in git, no third-party update path |
| 3 | Community plugins/skills | exact version, lockfile, read the tarball once, lab profile first |
| 4 | Anything asking for credentials, shell, or network transport | do not install blind; prefer building 50–200 lines yourself |

## Vetting checklist for tier 3

1. **Exact pin, never a range.** `0.6.5`, not `^0.6.5`: a range turns every
   later `pnpm install` (including adding an unrelated plugin) into an implicit
   upgrade. `profiles/web/package.json` carries exact versions and
   `pnpm-lock.yaml` is committed; `--frozen-lockfile` installs it verbatim.
2. **Read the package, not the README.** `npm pack <pkg>`, then check:
   `scripts` (`preinstall`/`install`/`postinstall` run code at install time),
   dependency count, `lib/*.js` for `child_process`, `fetch`, `http`, `~/.ssh`,
   `credentials`. Ten minutes, once per version.
3. **Lab profile first.** A separate `DSH_HOME` and `--profile lab` with no
   credentials and no sessions. Only after it behaves, install into `web`.
4. **No auto-update.** Upgrade deliberately, then re-read the diff. Do not add
   plugins whose feature is "upgrade everything on boot".
5. **After an upgrade**, run the repo's own tooling: `leak_guard` on the tree
   and the adapter/route behaviour in the GUI.

## Audit of what is installed now (2026-11-03)

| Plugin | Version | Install scripts | Host code touches | Notes |
|---|---|---|---|---|
| `@addozhang/dsh-discord` | 0.6.5 | none | network (Discord gateway) | 2 deps; bot token via Host credential store |
| `dshmarket` | 1.73.9 | `prepare` (build; not run for registry installs) | network + exec (pnpm install for plugins) | the market itself installs code — treat its Install buttons as tier 3 |
| `dsh-leak-guard` | 0.1.1 | none | none | read-only scanner |
| `@goodandready/dsh-time-machine` | 0.1.31 | none | exec + fs (git/checkpoint) | snapshots the workspace it is asked to guard |
| `@goodandready/dsh-plugin-notify` | 0.4.8 | none | network (webhooks) + chime | webhook URLs are credentials |
| `dsh-context` | 0.80.2 | `prepare` (husky + build; not run for registry installs) | network (remote reads) | manifest marks dsh 0.2.1-rc.2 compatible |

All six are pinned exactly. Nothing here has a `preinstall`/`install`/
`postinstall` hook.

## Build vs buy, by size

- **Buy/vendor** (don't write): protocol adapters (Discord, relay), model
  routing, sandboxes, UI frameworks, anything over ~1,000 lines or generic.
  Writing these is a maintenance tax with no personal payoff.
- **Build** (own it): credentials handling, shell/exec policies, memory,
  notification routing, anything that reads your keys or decides what the agent
  may do. These are small (50–300 lines), personal, and are exactly where a
  compromise lands.
- **Vendor the idea, not the package**: read a community skill, rewrite the
  steps in `agent-kit` where they are reviewable, and skip the plugin wrapper.
  That is what the interview-coach skill should be — read it, put the procedure
  in agent-kit, no auto-cloning of arbitrary repos.
- **Avoid**: `dsh-skills-nexus`-style tools that clone arbitrary GitHub repos
  into the skill root (prompt-injection surface), auto-updaters, and anything
  that wants your credentials to "configure itself".

The test: *if this plugin turned malicious tomorrow, what could it read before
I noticed?* If the answer includes keys or SSH, it must be tier 2 or heavily
vetted tier 3 with an exact pin.
