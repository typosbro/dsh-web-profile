# voice-mode

Continuous voice conversation for the dsh Web GUI. It turns the chat composer into
a hands-free conversation surface instead of push-to-talk dictation:

- **Talk, don't press.** One click starts the mode; speech recognition stays open,
  a pause ends the utterance and it is sent as the next prompt automatically.
- **It talks back.** The assistant's streamed reply is spoken sentence by sentence
  as the tokens arrive, not after the whole turn finishes.
- **Interrupt.** Speaking while it talks stops the speech immediately, cancels the
  running turn, and takes the interruption as the next prompt — the same way you
  cut off a person.

Status lives in the composer dock: a microphone button plus a one-line status
(`Listening`, `Hearing you`, `Thinking`, `Speaking — talk to interrupt`).

## Requirements

- Chrome or Edge. Recognition uses the Web Speech API (`webkitSpeechRecognition`),
  which those browsers implement; Safari and Firefox do not implement it the same
  way and show `This browser has no speech recognition`.
- A secure context: HTTPS or `localhost`. The tailnet HTTP URL does not count for
  `getUserMedia`; use the relay HTTPS origin, or open the app on the machine itself.
- Speech synthesis is the browser's local voice (`speechSynthesis`); it needs no
  download and no key.
- Speech recognition is the browser's service, so recognition itself needs network
  access. Audio is not sent to the dsh Host; the transcript is.

## Install

The bundle is installed with the harness plugin manager, which links the package
into the active profile and selects it as a bundle:

- `plugin_manager` action `install_bundle`, target = absolute path of this directory.
  The host row is a no-op (the feature is entirely browser-side). Result is
  `application: "applied"` on a live profile; the page needs one refresh to load
  the new client artifact (a fresh boot picks it up automatically).
- A fresh `./bootstrap.sh` from the repo root installs it too, because
  `profiles/web/package.json` links `@local/voice-mode` and lists it in
  `dsh.profile.bundles`.

Rebuild the browser artifact after editing `src/`:

```bash
node scripts/build.mjs      # writes client.js
node --check client.js
node --test                 # engine unit tests (51)
```

## Use

1. Open a Session, click the microphone in the composer.
2. Talk. Pause to send.
3. While it speaks, talk over it to interrupt.
4. Click the microphone again to leave voice mode.

## How it works

| Concern | Mechanism |
| --- | --- |
| Speech in | `SpeechRecognition` continuous + interim results, auto-restart on `end` |
| End of utterance | 650 ms quiet timer after the last result |
| Prompt out | `remote.session.prompt({ mode: 'queue' })` with a client-minted `requestId` |
| Reply text | `remote.session.follow({ assistantStream: true })` live `assistant-stream` frames (`text-delta` chunks) |
| Speech out | `createSpeaker` → `speechSynthesis`, one utterance per sentence, lazily flushed |
| Interrupt | stop the speaker, `remote.session.cancel`, keep the in-progress transcript |
| Echo guard | `looksLikeEcho` compares the transcript against the sentence being spoken |

## Files

- `src/engine.mjs` — dependency-free engine: markdown-to-speech text, sentence
  splitting, echo matching, voice choice, sequential TTS queue. Unit tests in
  `test/engine.test.mjs` (`node --test test/`).
- `src/app.js` — the Client half: controller state machine, follow-stream handling,
  composer-dock React control.
- `scripts/build.mjs` — concatenates the engine into the ModuleLoader factory and
  writes `client.js` (the artifact the browser loads).
- `index.js` — host half, intentionally empty: no host state, routes, or config.
- `tools/cdp-check.mjs` — headless-Chrome smoke test for the live Web GUI.

## Limits (first version)

- One Session at a time: switching Sessions turns the mode off, because the
  recognition session and the follow stream are bound to the Session they started on.
- Recognition latency is the browser's, roughly a second after the pause; this is
  not full-duplex streaming STT.
- Barge-in relies on the browser's echo cancellation. On loud speakers it can
  mistake its own voice for an interruption; headphones make it reliable.
- The mode speaks every assistant reply in the Session while it is on, including
  replies triggered from the keyboard.
