# launchd services

Plists for the harness and its sidecars. They are **templates**: every path is
`@HOME@` and the harness one also carries `@TAILNET_HOST@` / `@TAILNET_IP@`.
`scripts/install-services.sh` substitutes them and writes real plists into
`~/Library/LaunchAgents`.

| Label | What runs | Load it? |
|---|---|---|
| `com.typosbro.dsh-web` | `dsh web` on port 3080 for the `web` profile (the main GUI) | **never from inside a turn.** Install the file only with `--with-harness`; a restart is an owner action (2026-10-26 crash loop: six turns lost). |
| `com.typosbro.dsh-voice-bridge` | the standalone Discord voice sidecar (`services/voice-bridge`) | yes, after its config + token exist |
| `com.voicemode.whisper` | whisper.cpp server on `127.0.0.1:2022` (the bridge's STT) | yes, if the bridge uses whisper |
| `com.voicemode.kokoro` | kokoro-fastapi on `127.0.0.1:8880` (local TTS for both the browser voice mode and the bridge) | yes, for the natural voice |
| `com.typosbro.career-ops-scan` | private career-ops repo: daily scan | opt-in, after `scripts/install-career-ops.sh` |
| `com.typosbro.career-ops-funding` | private career-ops repo: funding scan | opt-in |

The last two reference `@HOME@/Documents/private/career-ops`, which is not part of
this repo (private source, user data). See `scripts/install-career-ops.sh`.

## Install

```bash
# write the non-harness plists, print the commands to load them
./scripts/install-services.sh

# also load the bridge + model services now
./scripts/install-services.sh --load

# additionally write the dsh-web plist (never loaded by the script)
./scripts/install-services.sh --with-harness
```

`TAILNET_HOST` and `TAILNET_IP` override the placeholders for the harness plist;
without them the file gets `localhost` / `127.0.0.1` and can still be edited later.

The model servers themselves (whisper.cpp binary + ggml model, kokoro-fastapi +
Kokoro ONNX model) are downloaded/installed by their own tooling — they are not
vendored in this repo. With neither running, browser voice mode falls back to
macOS `say`, and the voice bridge cannot transcribe.
