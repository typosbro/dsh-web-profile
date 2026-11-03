# dsh-voice-bridge

A standalone Discord voice sidecar for the DSH agent system: the bot **joins a
voice channel, hears the operator, transcribes locally, and speaks locally**.
One process = one bot identity, so several agents can share the same channel.

**Status: transport MVP.** Join / receive / transcribe / speak is implemented
and tested. Agent and `/discuss` integration is deliberately **out of scope**
for this phase (later: a file/queue Source in `dsh-superagent`).

**Languages: English only** for the MVP. whisper always receives
`language=en` (never auto-detect — it mis-transcribes Korean as English), and
text is spoken by Kokoro, which is English-only. macOS `say` (Yuna) remains
available as an optional Korean fallback behind `tts.engine: "auto"`, off by
default.

---

## Architecture

```
Discord voice channel                       this process (one bot)
┌───────────────────────┐      ┌────────────────────────────────────────────┐
│ operator's mic audio  │─────▶│ @discordjs/voice receiver.subscribe(user)  │
│ (Opus, DAVE/MLS)      │      │   → Opus decode → 48 kHz stereo PCM        │
└───────────────────────┘      │   → energy VAD (hands-free) or PTT window  │
                               │   → WAV → whisper.cpp :2022 (language=en)  │
                               │   → transcript (logged; agent hook later)  │
┌───────────────────────┐      │                                            │
│ channel playback      │◀─────│ TTS: Kokoro :8880 (EN) / say (KO opt.)     │
│ (Opus, DAVE/MLS)      │      │   → ffmpeg → 48 kHz stereo PCM → Opus      │
└───────────────────────┘      └────────────────────────────────────────────┘
                                        ▲
                               loopback control API :3090
```

Discord has required E2EE/DAVE for voice since 2026-03-01 (voice close code
**4017**). The Node stack handles it: `@discordjs/voice` 0.19.2 carries
`@snazzah/davey` for MLS key exchange and per-sender frame decryption.
`selfDeaf` **must stay `false`** — Discord withholds voice packets from
deafened clients, so a deafened bot receives nothing.

## Requirements

- macOS on Apple silicon (verified: M1 Pro, macOS 26.6.2, Node 24.19.0)
- Node.js >= 22 (Node 24 recommended; ESM, no build step)
- `ffmpeg` on `PATH` (`brew install ffmpeg`) — resampling for TTS
- Local inference already running on this Mac:
  - whisper.cpp server at `http://127.0.0.1:2022/v1/audio/transcriptions`
  - Kokoro server at `http://127.0.0.1:8880/v1/audio/speech`
- A Discord bot that is a member of the target server, with **Connect** and
  **Speak** (`1 << 20`, `1 << 21`) plus View Channel on the voice channel.
  **No privileged intents are needed** — `Guilds` + `GuildVoiceStates` only.
  The Message Content intent is **not** needed for voice.

## Install

```bash
cd ~/src/dsh-voice-bridge
pnpm install
```

`@discordjs/opus` ships darwin-arm64 NAPI-v3 prebuilds; `package.json`'
`pnpm.onlyBuiltDependencies` lets its install script fetch the matching
prebuild. If it was skipped, run `pnpm rebuild @discordjs/opus`.

## Configure

1. **Bot token** — a file containing the token, one line, never committed:

   ```bash
   install -m 600 /dev/null ~/.config/dsh-superagent/discord-token
   printf '%s\n' '<BOT_TOKEN>' > ~/.config/dsh-superagent/discord-token
   ```

2. **Bridge config** — copy the example and fill in the ids:

   ```bash
   mkdir -p ~/.config/dsh-superagent
   cp config/voice-bridge.example.json ~/.config/dsh-superagent/voice-bridge.json
   chmod 600 ~/.config/dsh-superagent/voice-bridge.json
   $EDITOR ~/.config/dsh-superagent/voice-bridge.json
   ```

   The ids can be discovered with a read-only gateway probe (it never prints
   the token, does not join voice, and exits):

   ```bash
   node scripts/discord-probe.mjs \
     --token-file ~/.config/dsh-superagent/discord-token \
     --guild-id <guild-id>
   ```

   `guildId` and `voiceChannelId` are printed directly. `operatorUserId` is
   the **human** who will talk in the channel — have them join the voice
   channel first, then run the probe: their id appears under "voice states".
   No member-list intent is required.

### Config reference

| key | required | default | meaning |
|---|---|---|---|
| `instanceName` | no | `voice-bridge` | log/state label; one per process |
| `tokenFile` | yes | — | path to a 600-mode file holding the bot token |
| `guildId` | yes | — | Discord server id (snowflake) |
| `voiceChannelId` | yes | — | voice channel to join |
| `operatorUserId` | yes | — | the only human whose audio is captured |
| `ignoreUserIds` | no | `[]` | user ids to never react to |
| `ignoreBotIds` | no | `[]` | bot ids to never react to (self/other agents) |
| `replyTextChannelId` | no | `null` | reserved for the later text loop |
| `controlPort` | no | `3090` | loopback control API port |
| `selfMute` | no | `false` | cosmetic; `selfDeaf` is always false |
| `ffmpegPath` | no | `ffmpeg` | ffmpeg binary |
| `stt.url` | no | whisper on `:2022` | OpenAI-compatible transcription URL |
| `stt.language` | no | `en` | **always sent explicitly** |
| `stt.model` | no | `whisper-1` | multipart `model` field |
| `tts.engine` | no | `kokoro` | `kokoro` (EN everything) or `auto` (Hangul → `say`) |
| `tts.kokoroUrl` / `kokoroVoice` | no | `:8880` / `af_heart` | English TTS |
| `tts.sayVoice` | no | `Yuna` | optional Korean fallback voice |
| `capture.mode` | no | `vad` | `vad` (hands-free) or `ptt` (debug) |
| `capture.autoStart` | no | `true` | arm capture on startup |
| `capture.vad.*` | no | see example | threshold dBFS, min speech, silence hangover, pre-roll, min/max utterance |

## Run

```bash
pnpm check        # validate config + token shape + ffmpeg + local services
pnpm start        # or: node src/main.js
node src/main.js --config /path/to/other.json   # second agent, second config
```

The daemon logs in, joins the configured voice channel, arms VAD, and stays
idle-light (gateway events only, no polling). It reconnects on voice drops and
leaves cleanly on `Ctrl-C` / `SIGTERM`.

## Control API (loopback only)

Binds `127.0.0.1:$controlPort`. Intended for the operator and for the next
phase to drive; it is not exposed to the network.

```bash
B=http://127.0.0.1:3090

curl -s $B/state                                   # transport/capture/transcript state (JSON)
curl -s -X POST $B/join                            # join the configured channel
curl -s -X POST $B/leave                           # leave, disarming capture
curl -s -X POST $B/listen/start                    # arm capture (VAD) / start PTT window
curl -s -X POST $B/listen/stop                     # disarm capture / flush PTT window
curl -s -X POST $B/say -H 'content-type: application/json' \
     -d '{"text":"Hello from the bridge."}'        # synthesise + play now (debug)
```

`POST /say` responds with `{engine, language, synthMs, audioMs}`; while it
plays, operator speech stops playback (barge-in). `GET /state` never contains
the bot token.

## How the loop works

- **Receive**: only the operator's user id is subscribed
  (`receiver.subscribe(operatorUserId)`). The Opus stream is decoded with
  `@discordjs/voice`'s Opus decoder to 48 kHz stereo s16le PCM. Discord's
  SSRC→user mapping, DAVE decryption and jitter handling happen inside the
  library; the bot never hears itself.
- **Capture (default: VAD)**: deterministic frame-energy segmenter — a frame
  above `thresholdDbfs` opens a candidate, `minSpeechMs` confirms it (with
  `preRollMs` retained before onset), `silenceMs` of trailing quiet closes it,
  and `maxUtteranceMs` force-splits long monologues. Tuning lives in
  `config.capture.vad`; the class has the same interface a future
  webrtc/silero VAD can implement.
- **Capture (debug: PTT)**: `capture.mode: "ptt"` + `POST /listen/start` /
  `/listen/stop` records a fixed window instead. Not the main path.
- **STT**: the utterance is wrapped in a WAV and POSTed as multipart with
  `language` (always explicit), `model`, `response_format=json`. Transcripts
  are logged with timings. Empty/`[BLANK_AUDIO]` results are discarded.
- **TTS**: `kokoro` for English. Optional `auto` sends Hangul to macOS `say`
  (Korean) — note Kokoro does **not** support Korean. Either path is
  resampled by ffmpeg to 48 kHz stereo PCM and played as raw Opus frames.
- **Barge-in**: an above-threshold operator frame while the player is active
  calls `player.stop()`; a new `/say` also stops the previous line.

## Multi-agent room

The operator can run whalechan, Hermes and future agents in the same channel:

- one **process** per bot identity, each with its own `tokenFile`, config,
  `instanceName` and `controlPort` (e.g. 3090, 3091, 3092);
- each bridge captures **only its own operator** and **never a bot** — put
  other agents' bot ids in `ignoreBotIds` (defence in depth; the bridge only
  subscribes to `operatorUserId` anyway);
- three or more bots + speakers in one channel means echo risk: wear
  headphones, keep VAD thresholds conservative, and expect barge-in to fire
  on speaker bleed.

## Verification

Automated tests (no network, mocks/injection only — Discord, whisper, Kokoro
and child processes are all faked):

```bash
pnpm test
# 88 tests, 88 pass
```

Local end-to-end checks against the real services (start whisper + Kokoro;
never part of `pnpm test`):

```bash
pnpm verify:local
# ok   say -> 48 kHz WAV -> whisper(en): 4675 ms audio, 422 ms STT, transcript matched
# ok   Kokoro(en) -> PCM -> whisper round-trip: 3482 ms audio in 2922 ms, transcript matched
# ok   energy VAD segmentation: 1 utterance, 700 ms incl. 500 ms speech
# ok   loopback control API: GET /state, POST /say, POST /join, 404 on unknown
# ok   token redaction
# PASS: 5/5
```

Live Discord check on 2026-11-03 with the whalechan bot (valid token + bot in
the test guild), empty voice channel:

- `voice state: signalling → connecting → ready` — DAVE/MLS negotiated, **no
  4017**, `selfDeaf: false` receive path connected;
- `POST /say` → Kokoro synth 1630 ms for 3152 ms of audio, player
  `playing: true` → back to `playing: false` after playback;
- `POST /leave` / `POST /join` round-trip worked; `GET /nope` 404,
  `GET /join` 405;
- `SIGINT` → "left the voice channel" and "stopped", control port closed,
  process exited; no token in the log.

**Not yet exercised live:** the audio receive + VAD + transcript path, because
that needs a human speaking in the channel. To verify: start the bridge, have
the operator join the voice channel and say a sentence — the log should show
`utterance (vad): … ms`, then `transcript (en, … ms): "…"`. That is the next
manual step.

## Risks and fallback

- **Receive is unofficially supported.** The discord.js maintainer calls voice
  receiving "it may work" basis; ~34% Opus packet loss during MLS key
  transitions is a known open issue upstream. Expect occasional dropped words
  mid-sentence; keep utterances short and expect retries.
- **DAVE is mandatory.** A stale voice stack without `@snazzah/davey` cannot
  receive or send (close code 4017). Do not downgrade `@discordjs/voice` below
  0.19.2.
- **Korean TTS** is not part of the MVP: Kokoro has no Korean. The `say`
  fallback is flat but cheap; upgrade to an MLX Korean TTS later if needed.
- **Shared machine.** Kokoro (MPS) + whisper (Metal) + the agent LLM compete
  for 16 GB; use a small whisper model until quality matters, then
  `large-v3-turbo` q5_0.
- **Fallback if receive proves unreliable:** text-in/voice-out (the bridge
  still speaks agent replies; input comes from the text channel or the
  superagent pipeline). That keeps most of the value with none of the receive
  risk — the TTS path is independent of the receive path.
- **Recording/consent:** capturing another person's voice has consent
  implications (KR/EU). This bridge only captures the configured operator and
  only logs transcripts locally.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| close code `4017` or no audio | stack without DAVE; use `@discordjs/voice` >= 0.19.2 (bundles `davey`) |
| connects but receives nothing | `selfDeaf` must be false; is `operatorUserId` the speaker's real id? |
| `voice channel … not found` | wrong `voiceChannelId`/`guildId`, or bot lacks View Channel |
| bot won't join / no Speak | missing Connect/Speak permission on the channel |
| transcript in English when the speaker used Korean | MVP is English-only; set `stt.language` explicitly and `tts.engine: "auto"` for the `say` fallback |
| Kokoro `HTTP 500` / garbled speech | Kokoro is English-only; check the URL and that the model is warm |
| `bot token file …` failure from `--check` | token file empty/truncated/wrong: it must be ~70 chars, three dot-separated parts |
| `control port already in use` | another instance owns 3090; change `controlPort` per instance |
| `cannot read config file` | copy `config/voice-bridge.example.json` to `~/.config/dsh-superagent/voice-bridge.json` and `chmod 600` |

Run `pnpm check` first for everything that can be validated without Discord:

```bash
pnpm check
# [ok  ] config file: /Users/…/.config/dsh-superagent/voice-bridge.json (instance "whalechan")
# [ok  ] bot token file: … (72 chars, not printed)
# …
# config check passed
```

## Layout

```
src/
  main.js       daemon entry, lifecycle, wiring, control actions
  config.js     config load/validate/defaults, token shape (+ redaction-safe errors)
  transport.js  Discord voice: join/leave, operator-only receive, PCM playback, reconnect
  vad.js        deterministic energy VAD with pre-roll + hangover + max length
  capture.js    debug push-to-talk capture
  stt.js        whisper.cpp multipart client (explicit language)
  tts.js        Kokoro / macOS say -> 48 kHz stereo PCM
  audio.js      RMS/level helpers, ffmpeg resampling
  wav.js        RIFF/WAVE framing
  control.js    loopback HTTP control API (pure dispatcher + server)
  check.js      static + local-service self-check (`--check`)
  logger.js     leveled logging with mandatory secret redaction
scripts/
  discord-probe.mjs   read-only id discovery (no token printed, no voice join)
  verify-local.mjs    manual STT/TTS/VAD/control check against real services
test/           88 node:test cases, no network (Discord/whisper/Kokoro/spawn mocked)
config/voice-bridge.example.json
```

No token is ever logged, returned by `/state`, or committed: the token lives
in its own 600-mode file, the config is 600-mode, and the logger redacts both
the literal token and any Discord-token-shaped string.

---

## Restoring this sidecar from the backup repo

This directory is a vendored copy of `typosbro/dsh-voice-bridge` inside
`dsh-web-profile`; no bot token and no machine config is committed.

```bash
cd ~/.dsh/services/voice-bridge        # after WITH_SERVICES=1 ./bootstrap.sh
pnpm install
install -m 600 /dev/null ~/.config/dsh-superagent/discord-token
printf '%s\n' '<BOT_TOKEN>' > ~/.config/dsh-superagent/discord-token
cp config/voice-bridge.example.json ~/.config/dsh-superagent/voice-bridge.json
chmod 600 ~/.config/dsh-superagent/voice-bridge.json   # then fill in the ids
node src/main.js
```

The answer path calls `POST http://127.0.0.1:3080/voice-mode/turn` on the running
`web` profile (local agent turn → local Kokoro → the voice channel), so start
`dsh web` first. Override with `VOICE_BRIDGE_AGENT_URL`. The default STT/TTS
endpoints are local whisper.cpp `:2022` and kokoro-fastapi `:8880`; see
`../launchd/README.md` for the model services.
