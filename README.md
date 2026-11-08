# dsh-web-profile

A one-command reproducible home for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`): the Web GUI, **hands-free local voice**, a Discord surface (text and voice),
the **superagent** profile, career-ops scheduling, agent presets, skills, and the
operating rules that keep the agent shipping instead of narrating.

The machine is the source of truth; this repo is its backup. Everything that is a
file lives here, everything that is a secret stays out, and `./bootstrap.sh` puts a
fresh machine back together.

## Quickstart

```bash
git clone https://github.com/typosbro/dsh-web-profile.git
cd dsh-web-profile
./bootstrap.sh          # dsh, all profiles, plugins, presets, skills, voice plugin
dsh web                 # http://127.0.0.1:3080/
```

One command installs everything that needs no private credentials. Three things
stay with the owner because they are secrets or private repos:

1. **Model access** — `~/.dsh/.env` (`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`),
   or sign in from Settings → Models. See [docs/models.md](docs/models.md).
2. **Discord bot token** — Settings → Discord in the running GUI; the Host
   credential store keeps it, never this repo.
3. **career-ops** — a private repo: `WITH_CAREER_OPS=1 ./bootstrap.sh`.

Requirements: macOS or Linux, Node 22+, pnpm (`corepack enable`), `rsync`,
`python3`, `git`, and a system Chrome/Chromium for the browser tools. The voice
stack is macOS-first (macOS `say` fallback, VoiceMode model servers).
`bootstrap.sh` clones the private `typosbro/agent-kit` repo beside this checkout
(the operator contract and portable skills) on first run, so GitHub SSH access is
needed; set `AGENT_KIT_DIR` to point at an existing clone instead.

## What `bootstrap.sh` installs

| Piece | What it gives you | Where |
|---|---|---|
| `web` profile | the main GUI profile: voice input, hands-free voice, Discord, relay, auto-review, session search, worktree, ralph | `profiles/web/` |
| `superagent` profile | the [dsh-superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) on its own port 3082 and state DB | `profiles/superagent/` |
| `headless` profile | one-shot scripting path with no HTTP surface | `profiles/headless/` |
| `desktop` template | backup of the Desktop app's profile; installed by `./install-desktop.sh` | `profiles/desktop/` |
| Plugins | `@local/voice-mode`, `@local/dsh-web-search-local`, browser stack (optional), `kitsune-browser` live Firefox/Zen (optional; needs uv + the Kitsune extension) | `plugins/` |
| Community plugins | `dshmarket` (in-app plugin market), `dsh-leak-guard` (`leak_guard` secret scan before publishing), `@goodandready/dsh-time-machine` (checkpoints + rollback), `@goodandready/dsh-plugin-notify` (turn/approval notifications), `dsh-context` (context dashboard + `/context`), `dsh-keep-awake` (wake lock during long runs) | `profiles/web/package.json` |
| Presets | `orchestrator` (acts first, escalates decisions) and `worker` (lean child) | `presets/` |
| Skills + rules | DSH-only skills here, operator contract and portable skills from `agent-kit` | `skills/`, `agent-kit` |
| Voice bridge | standalone Discord voice sidecar (hear → transcribe → answer → speak) | `services/voice-bridge/` |
| Services | launchd plists for the harness, model servers, career-ops | `services/launchd/` |

Flags: `FORCE=1` replaces an existing web profile (timestamped backup kept),
`WITH_PLAYWRIGHT=1` fetches Chromium, `WITH_SERVICES=1` stages the voice bridge and
launchd plists, `WITH_CAREER_OPS=1` installs the private career-ops repo,
`WITH_DESKTOP=1` refreshes the Desktop profile files.

## Hands-free voice (browser)

`plugins/voice-mode` turns the chat composer into a full conversation: a local VAD
cuts utterances, the assistant's streamed reply is spoken sentence by sentence,
and talking over it stops the speech and cancels the turn. Everything audio is
local:

| Direction | Engine | Where |
|---|---|---|
| speech → text | harness SenseVoice (ONNX, int8) | host, already part of the voice-input bundle |
| text → speech | local `kokoro-fastapi` (fp32 Kokoro on Apple MPS, voice `af_sky`) | loopback `127.0.0.1:8880` |
| fallback TTS | macOS `say` (Hangul, or when the Kokoro service is down) | host |

The plugin exposes three local routes used by the browser and by any sidecar:
`POST /voice-mode/transcribe` (16 kHz WAV → text), `POST /voice-mode/speak`
(text → WAV), and `POST /voice-mode/turn` (text → one agent answer, for the voice
bridge). Full details: [plugins/voice-mode/README.md](plugins/voice-mode/README.md).

## Discord

Two independent surfaces, both local-first:

- **Text** — [`@addozhang/dsh-discord`](https://github.com/addozhang/dsh-discord)
  mounts on the `web` profile. Bind a channel with `/project bind`, then mention the
  bot with a task: a thread opens and the answer streams in, with approvals and
  questions as buttons. It needs a bot token (Settings → Discord) and the guild
  allowlist in the same card.
- **Voice** — `services/voice-bridge/` joins a voice channel as a bot: local
  whisper.cpp transcribes the operator, then it asks the running harness
  (`POST /voice-mode/turn`) and speaks the answer with local Kokoro. One process per
  bot identity; config in `~/.config/dsh-superagent/`. See its README.

## Services (launchd)

`services/launchd/` carries the plists for the harness and its sidecars;
`scripts/install-services.sh` installs them and **never** loads the `dsh-web` job (a
harness restart is an owner action, never something a turn schedules — the
2026-10-26 crash loop). Models for the voice bridge are separate servers
(whisper.cpp on `:2022`, Kokoro on `:8880`), documented in
`services/launchd/README.md`.

## career-ops

A private job-search system (`git@github.com:career-ops-hq/career-ops.git`) with
scheduled scan/funding jobs, plus user data that must not be in this public repo.
`scripts/install-career-ops.sh` clones and wires it; the data lives in
`~/agent-memory/career-ops` and `~/.career-ops/backups`.

## Re-running, verifying, upgrading

```bash
FORCE=1 ./bootstrap.sh     # replace the web profile, keep a timestamped backup
./doctor.sh                # read-only composition check; non-zero on hard failures
```

`dsh` is pinned to `0.2.1-rc.2`. The experimental bundles ship inside `dsh`, so
reproducing them needs only the `bundles` array. `dsh-relay` is pinned to the head
of [PR #12](https://github.com/sorsama/deepseek-harness-relay/pull/12)
(`hazyumps/deepseek-harness-relay@36321a6`, 0.3.1): the published 0.2.1 tarball's
client half waits on the removed `settingsScope` service and fails the web boot on
dsh 0.2.x. Move back to the registry once a fixed 0.3.x exists.

## What is not in this repo

The exact inventory — what is committed, what is regenerated, what stays with the
owner — is [docs/backup-coverage.md](docs/backup-coverage.md). In short:

- Credentials, tokens, relay pairing keys, sessions, attachments, browser profiles,
  and the Host credential store (`~/.dsh/.credentials.yaml`).
- Personal IDs (Discord guild/user snowflakes) — the committed patch has empty
  allowlists; fill them in Settings after restore.
- career-ops private source and its user data.
- Model weights: SenseVoice/VAD (auto-downloaded by the harness), Kokoro ONNX and
  whisper ggml (installed by their own services).

## Toolbox

- `scripts/context-audit.mjs` — resident context cost (AGENTS.md + skill
  descriptions), duplicated rules, skill-name collisions.
- `scripts/usage-meter.mjs` — per-turn and per-session token totals from persisted
  session logs.
- `scripts/night-batch.sh` — dry-run-first unattended headless batches with caps.
- `profiles/web/gate/index.mjs` — stop gate: runs the repository's gate and a
  diff-level review (leaked keys, conflict markers, `debugger`), max two blocks.
- `bench/run.mjs` — one task on two model routes, both transcripts kept.

## Why a profile at all

DSH composes a profile as layered patches: bundle layers first, then
`profiles/<name>/cordis.patch.yml`, then `--patch` overlays. Every row here is a
decision with its reason written next to it, so the setup stays reviewable instead
of becoming a pile of settings. See [docs/why-these-rows.md](docs/why-these-rows.md).

## Documentation

- [docs/why-these-rows.md](docs/why-these-rows.md) — the decision log for every patch row.
- [docs/models.md](docs/models.md) — native, OpenAI-compatible, and subscription routes.
- [docs/replication.md](docs/replication.md) — what is guaranteed, what is not, upgrade path.
- [docs/improvements.md](docs/improvements.md) — shipped ideas, blocked plugins, next steps.
- [docs/upgrading.md](docs/upgrading.md) — moving to 0.2.1-rc.2 and the plugin ecosystem.
- [docs/agent-os/README.md](docs/agent-os/README.md) — unattended runs and their safety model.
- [docs/backup-coverage.md](docs/backup-coverage.md) — does the repo contain everything? exact coverage table.

## License

MIT. DeepSeek Harness is MIT; the Playwright MCP server is Apache-2.0.
