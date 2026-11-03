# Replication: what is guaranteed, what is not

"Make it 100% replicable" is achievable for the configuration layer and impossible for the
credentials, the host, and the model. This file draws the line precisely so nobody debugs a
missing key as if it were a broken profile.

The unit of replication is **one command**: `./bootstrap.sh`. It restores profiles, plugins,
presets, skills, the agent-kit contract, and (optionally) the voice bridge, launchd plists and
career-ops wiring.

## Guaranteed by the installer

- The harness version: `0.2.1-rc.2`, pinned in `bootstrap.sh`. A different version is a
  different platform; the patch layer may compose differently.
- Every profile: `web` (primary), `superagent`, `headless`, plus the `desktop` template. Bundle
  order, patch layer and local modules come from this repo.
- The local plugins and presets: `plugins/voice-mode`, `plugins/web-search`, the optional
  browser stack, `presets/orchestrator`, `presets/worker`.
- The pinned dependencies: `dsh-relay@hazyumps/deepseek-harness-relay@36321a6` (head of PR #12)
  and `@addozhang/dsh-discord@^0.6.5`; `profiles/web/pnpm-lock.yaml` is committed and installed
  with `--frozen-lockfile`.
- The superagent profile's plugin: a vendored snapshot (`profiles/superagent/plugin/`, MIT) that
  includes local commits upstream does not have — the Discord Source, discussion mode, build
  fixes. `lib/` is prebuilt, so no build toolchain is needed.
- Paths: every `@TOKEN@` in the repo (`@DSH_HOME@`, `@HOME@`, `@NODE_BIN@`, `@CACHE_DIR@`,
  `@PLUGIN_DIR@`, `@SERVICES_DIR@`) is rewritten at install time. `doctor.sh` fails if one
  survived.
- The voice stack: the `voice-mode` plugin is linked into `web`, so hands-free browser voice and
  the local `/voice-mode/*` routes (transcribe, speak, turn) exist after boot. With
  `WITH_SERVICES=1` the Discord voice sidecar and launchd plists are staged too.
- A clean restore was verified: `DSH_HOME=/tmp/dsh-restore-test ./bootstrap.sh` exits 0 and the
  doctor reports `0 failure(s)`.

## Not guaranteed, by design

- **Credentials.** `~/.dsh/.env`, `~/.dsh/.credentials.yaml`, OAuth grants, the Discord bot
  token (Host credential store) and relay pairing keys stay on the machine. The repo holds none.
- **Personal identifiers.** Discord guild/user snowflakes are stripped from the committed
  `cordis.patch.yml`; re-enter them in Settings → Discord after a restore.
- **Private repositories.** career-ops source and user data
  (`~/Documents/private/career-ops`, `~/agent-memory/career-ops`, `~/.career-ops/backups`) are
  installed by `scripts/install-career-ops.sh`, not vendored.
- **Model servers and weights.** whisper.cpp (`:2022`) and kokoro-fastapi (`:8880`) are installed
  by their own tooling; the Kokoro ONNX model and whisper ggml files are not committed. Without
  Kokoro, voice falls back to macOS `say`; without whisper, the voice bridge cannot transcribe.
- **Host and sessions.** Browser binary, fonts, GPU, display; sessions, attachments, projections
  and the browser profile under `~/.dsh`.
- **Model behaviour.** Same prompt, same harness, different serving stack is a different model.

## Determinism levers you can pull

1. Commit `profiles/web/pnpm-lock.yaml` and the vendored plugin lockfiles; install with
   `--frozen-lockfile` where they exist.
2. Pin `DSH_VERSION`, the relay commit, the Discord adapter range and the superagent snapshot —
   all are pinned in the repo.
3. Keep durable instructions in `AGENTS.md` (agent-kit) and the profile patches, not in a
   session summary.
4. Run `./doctor.sh` after every restore and every harness upgrade; it composes the profile and
   lists missing stack pieces (voice, Discord, superagent, bridge).
5. When you change live config, move the change back into `profiles/<name>/cordis.patch.yml`
   and commit it; the repo is the backup, `~/.dsh` is the running copy.

## Restore on another machine

```bash
git clone git@github.com:typosbro/dsh-web-profile.git
cd dsh-web-profile
./bootstrap.sh                 # installs dsh + profiles + plugins + skills + agent-kit
dsh web                        # http://127.0.0.1:3080/
```

Then, as the owner: put model keys in `~/.dsh/.env` (or sign in), paste the Discord bot token in
Settings → Discord and fill the guild/user ids, and optionally `WITH_SERVICES=1
./bootstrap.sh` plus `WITH_CAREER_OPS=1 ./bootstrap.sh` for the voice bridge and private repo.

## Upgrade path

```bash
# bump the harness
DSH_VERSION=0.3.0 FORCE=1 ./bootstrap.sh
# bump a profile dependency
( cd profiles/web && pnpm add @addozhang/dsh-discord@latest && pnpm install )
./doctor.sh
dsh --profile web --dump-config > /tmp/after.yml   # diff against a pre-upgrade copy
```

## Portability notes

- The `web` and `superagent` profiles run on Linux and macOS. The voice stack is macOS-first:
  browser voice works anywhere Chrome runs (with `say` fallback only on macOS), while the Discord
  voice bridge assumes macOS audio tooling (`ffmpeg`, `say`).
- The installer refuses to load the harness's launchd plist. A harness restart is always an owner
  action; the 2026-10-26 crash loop came from a self-armed reload job.
- `DSH_HOME` is honoured everywhere: profile install, doctor, plugin links, services directory.
