# superagent profile

A second, isolated profile for the [dsh-superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype).
It is deliberately separate from the `web` profile: the plugin changes
process-wide PATH and git settings, owns an `orchestrator.sqlite` state database,
and is meant to be restarted on its own.

- Bundle list: `dsh-base`, `dsh-web-app`, `dsh-superagent`.
- Source: a **vendored snapshot** at `profiles/superagent/plugin/` (the upstream
  `.gitignore` was removed so the prebuilt `lib/` is part of the backup) (MIT, from
  `github.com/deepseek-ai/dsh-superagent-prototype`). It is not the upstream tip:
  the local checkout carried six commits on top of upstream `main` — the Discord
  Source, discussion mode, and build fixes — and those are the ones backed up here.
  `lib/` is the built output, so no build step is needed; `bootstrap.sh` runs
  `pnpm install` in the plugin directory and in the profile.
- State: `@DSH_HOME@/state/superagent` (resolved by bootstrap; back up
  `orchestrator.sqlite` before upgrades).
- Panel/API port: 3082, loopback only.
- The Discord Source row is enabled in the patch, but needs its bot token file
  and channel ids on the Discord card in the panel. The GitHub Source needs its
  own app credentials in the panel too.
- Start it with `dsh --profile superagent --no-open`; it is intentionally not a
  launchd service here, so it never fights the `web` profile for the model API.

This directory is a template: `bootstrap.sh` copies it to
`$DSH_HOME/profiles/superagent` and substitutes `@DSH_HOME@`.
