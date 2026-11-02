# voice-mode

Continuous, **fully local** voice conversation for the dsh Web GUI. It replaces
the record-button/dictation loop with a hands-free conversation:

- **Talk, don't press.** One click starts the mode; the microphone stays open and
  a local voice-activity detector cuts utterances. A pause sends the utterance
  as the next prompt.
- **It talks back.** The assistant's streamed reply is spoken sentence by
  sentence as the tokens arrive, not after the whole turn finishes.
- **Interrupt.** Speaking while it talks stops the speech immediately (local
  playback stop, no network round trip), cancels the running turn, and takes the
  interruption as the next prompt — before the sentence has finished.

Both speech engines run on the host this plugin is mounted in. Nothing goes to a
cloud speech service:

| Direction | Engine | Where |
| --- | --- | --- |
| Speech → text | harness `speechToText` / SenseVoice ONNX (int8) | host, already provisioned by `dsh-experimental-voice-input-bundle` |
| Text → speech (preferred) | **kokoro-fastapi** on loopback `127.0.0.1:8880` — fp32 Kokoro v1.0 on Apple MPS, voice `af_sky` (the same stack the VoiceMode MCP installs and runs) | host, no download needed |
| Text → speech (fallback) | Kokoro-82M int8 multi-lang via `sherpa-onnx-node`, model in `~/.dsh/voice-mode/tts/` | host |
| Fallback TTS | macOS `say` (local) for Hangul text and when no Kokoro is available | host |

The browser only captures audio, runs the VAD, and plays returned WAV through Web
Audio. That is what makes barge-in feel immediate: stopping playback is local and
synchronous.

## Requirements

- Chrome or Edge on a secure origin (HTTPS or `localhost`); `getUserMedia` refuses
  plain HTTP.
- The host profile must have the voice-input bundle's local SenseVoice provider
  ready (it already is on this machine). The plugin never falls back to a cloud
  provider.
- Preferred voice: the local `kokoro-fastapi` service that the VoiceMode MCP
  setup already runs on `127.0.0.1:8880` (fp32 Kokoro v1.0, Apple MPS, voice
  `af_sky`). If it is not running the plugin falls back to its own int8 Kokoro.
  Override the endpoint with `VOICE_MODE_KOKORO_HTTP` and the Latin voice with
  `VOICE_MODE_KOKORO_HTTP_VOICE`; only loopback URLs are accepted.
- Built-in Kokoro model: ~132 MB, downloaded once into
  `~/.dsh/voice-mode/tts/kokoro-int8-multi-lang-v1_0/` by
  `node scripts/fetch-tts-model.mjs`. On this machine it is already installed.
- `sherpa-onnx-node` (native, darwin-arm64) — a package dependency. The host half resolves it
  from the profile's pnpm store when the linked plugin has no `node_modules` of its own;
  running `pnpm install` in this directory also satisfies it.

## Install

```bash
cd ~/src/dsh-web-profile
# the plugin manager links this directory into the active profile and selects it
# as a bundle; the host row serves the routes, the client half is the mic control
```

A fresh `./bootstrap.sh` installs it too: `profiles/web/package.json` links
`@local/voice-mode` and lists it in `dsh.profile.bundles`.

Model fetch (idempotent, safe to re-run):

```bash
node scripts/fetch-tts-model.mjs
```

Rebuild the browser artifact after editing `src/`:

```bash
node scripts/build.mjs      # writes client.js
node --check client.js
node --test                 # engine + audio + host tests
node tools/tts-check.mjs    # synthesizes test WAVs from the local engine
```

## Routes (host half)

| Route | Purpose |
| --- | --- |
| `GET /voice-mode/status` | engine readiness: STT provider, TTS engine, sample rate, speaker ids |
| `POST /voice-mode/transcribe` | raw 16 kHz mono PCM16 WAV body → `{ text }`, local SenseVoice |
| `POST /voice-mode/speak` | `{ text, sid?, speed? }` → `audio/wav`, Kokoro or `say` |

All routes sit behind the harness connection gate.

## Use

1. Open a Session, click the microphone in the composer.
2. Talk. Pause to send.
3. While it speaks, talk over it to interrupt.
4. Click the microphone again to leave voice mode.

## Limits

- One Session at a time: switching Sessions turns the mode off.
- Turn-taking is endpointed, not full duplex: the agent starts after your ~0.7 s
  pause, so overlapping speech mid-sentence is used for interruption rather than
  streaming ASR.
- Engine latency is the local models': SenseVoice ~0.3 s for a short utterance,
  Kokoro ~0.5 s per sentence on this Mac. That is the price of staying local.
- Barge-in trusts the browser's echo cancellation; on loud speakers raise the
  playback thresholds in `src/app.js` or use headphones.
