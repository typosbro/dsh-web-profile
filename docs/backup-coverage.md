# Backup coverage: what is in the repo, what is regenerated, what stays yours

This answers one question directly: **does the repo contain everything?**
Short version: everything that is a file and belongs to the harness setup is in
the repo; model weights, runtime payloads, sessions, secrets and one private
repository are not, and each has an explicit restore path below.

## In the repo (restored by `./bootstrap.sh`)

| Piece | Repo path | Restored to |
|---|---|---|
| `web` profile package + patch layer | `profiles/web/` | `$DSH_HOME/profiles/web` |
| `superagent` profile | `profiles/superagent/` | `$DSH_HOME/profiles/superagent` |
| superagent plugin (vendored, incl. local commits + built `lib/`) | `profiles/superagent/plugin/` | linked from the profile |
| `headless` profile + provider overlay | `profiles/headless/` | `$DSH_HOME/profiles/headless` |
| `desktop` profile template (app-managed) | `profiles/desktop/` | via `./install-desktop.sh` |
| voices, relational, agent-team and browser-stack plugins | `plugins/` | `$DSH_HOME/plugins` |
| orchestrator + worker presets | `presets/` | `$DSH_HOME/presets` |
| DSH-only skills | `skills/` | `$DSH_HOME/skills` |
| operator contract + portable skills + `repo-map`/`wt`/`consult-codex` | external private repo `typosbro/agent-kit` (auto-cloned beside this repo by bootstrap) | `$DSH_HOME/AGENTS.md`, skill root, `~/.local/bin` |
| Discord voice bridge source | `services/voice-bridge/` | `$DSH_HOME/services/voice-bridge` (`WITH_SERVICES=1`) |
| launchd plists (harness, whisper, kokoro, bridge, career-ops) | `services/launchd/` | `~/Library/LaunchAgents` via `scripts/install-services.sh` |
| career-ops installer | `scripts/install-career-ops.sh` | private repo clone (`WITH_CAREER_OPS=1`) |
| doctor, model docs, this coverage table | `doctor.sh`, `docs/` | repo only |

Pinned versions: `dsh 0.2.1-rc.2`, `dsh-relay` at `hazyumps/deepseek-harness-relay@36321a6`,
`@addozhang/dsh-discord@^0.6.5`, superagent snapshot commit, `profiles/web/pnpm-lock.yaml`.

## Regenerated automatically (not committed, no action)

| Piece | Why not in git | How it comes back |
|---|---|---|
| `~/.dsh/speech-to-text/` SenseVoice + Silero VAD (230 MB) | model weights | the voice-input bundle downloads them on first use / Settings → voice |
| `~/.dsh/dsh-runtimes/` (359 MB: node, pnpm, python + Office libs) | DSH Desktop runtime payload | re-provisioned by the harness on demand |
| `~/.dsh/sessions/`, `attachments/`, `storages/`, caches | live data, grows forever | not needed for the setup; back up separately if wanted |
| node_modules and pnpm stores | rebuildable | `pnpm install` inside the profile/plugin |

## Owner-only (secrets, private data, external services)

| Piece | Where it lives | Restore |
|---|---|---|
| model keys (`DEEPSEEK_API_KEY`, `OPENCODE_GO_API_KEY`, OAuth grants) | `~/.dsh/.env`, `~/.dsh/.credentials.yaml` | re-enter / sign in from Settings → Models |
| Discord bot token | Host credential service | Settings → Discord: paste token |
| Discord guild/user snowflakes | stripped from the committed patch | Settings → Discord: add ids |
| relay pairing (password, device tokens, TLS keys) | `~/.dsh/relay/` | set password at `https://127.0.0.1:3443`, re-pair the phone |
| Kokoro model + whisper model (2.1 GB + 1.5 GB) | `~/.voicemode/services/` | their own installers; browser voice falls back to macOS `say` without Kokoro |
| career-ops source and data | private repo, `~/agent-memory/career-ops`, `~/.career-ops/backups` | `WITH_CAREER_OPS=1 ./bootstrap.sh` + restore the userdata archive |
| sessions, browser profile, agent memory tree | `~/.dsh` and other repos | separate backups |

## How to verify a restore

```bash
git clone git@github.com:typosbro/dsh-web-profile.git /tmp/restore-check
cd /tmp/restore-check
DSH_HOME=/tmp/restore-home ./bootstrap.sh     # exit 0, doctor 0 failures
```

Clean-room verification on 2026-11-03: clone of `96bbcc1`, `DSH_HOME=/tmp/dsh-verify`,
`bootstrap.sh` → exit 0, doctor `0 failure(s)`, all profiles installed, superagent
`lib/index.js` present, `@local/voice-mode` linked.
