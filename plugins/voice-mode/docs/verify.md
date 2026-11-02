# Headless-Chrome verification of the live DSH Web GUI

Accept gate for installing the `@local/voice-mode` client plugin into the running
`dsh web` profile. A client plugin that throws while a browser boots can take the
whole Web UI down, so this check proves, from a **separate headless Chrome
connection**, that the page still boots, the session composer still mounts, and
(after install) the plugin's marker and dock DOM are present with no new uncaught
errors.

- Tool: [`tools/cdp-check.mjs`](../tools/cdp-check.mjs) — zero npm dependencies
  (Node 24 global `fetch` + global `WebSocket`), builds its own CDP client.
- Live target: `http://127.0.0.1:3080/` (`dsh web` on the `web` profile).
- A second client connection is harmless. The probe never sends a chat message,
  never creates/archives a session and never clicks a destructive control. It
  may select one already-rendered sidebar session row to mount the real chat view.

## Command

```bash
cd /Users/typosbro/src/dsh-web-profile/plugins/voice-mode

# Baseline (already run: passes on the app before the plugin is installed)
node tools/cdp-check.mjs \
  --screenshot /tmp/voice-mode-baseline.png \
  --json-out /tmp/voice-mode-baseline.json

# Post-install accept gate — run this after the Lead installs @local/voice-mode.
# Subtracting the baseline means only NEW errors fail the gate.
node tools/cdp-check.mjs --expect-voice \
  --baseline /tmp/voice-mode-baseline.json \
  --screenshot /tmp/voice-mode-check.png \
  --json-out /tmp/voice-mode-post-install.json
```

Prints exactly one JSON report on stdout. Exit `0` = pass, `1` = fail, `2` =
bad arguments. `--help` lists every flag (`--url`, `--settle`, `--strict`,
`--keep-chrome`, `--debug`).

## What the tool does

1. Launches `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` with
   `--headless=new`, an ephemeral `--remote-debugging-port`, a throwaway
   `--user-data-dir` (removed on exit), `--no-first-run`,
   `--no-default-browser-check`, `--disable-gpu`, fake media-stream flags
   (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`) and
   `--autoplay-policy=no-user-gesture-required` (so a future mic/TTS path is not
   blocked by permission or autoplay prompts).
2. Reads `http://127.0.0.1:<port>/json/version`, creates a page target with
   `HTTP PUT /json/new?url=about:blank`, connects the built-in `WebSocket` as a
   raw CDP client, and enables `Runtime`, `Log` and `Page`.
3. Navigates to the GUI, waits for `Page.loadEventFired`, then settles ~8 s.
4. Records, for the whole boot:
   - `Runtime.exceptionThrown` — uncaught page errors;
   - `Runtime.consoleAPICalled` `type=error|assert` — console.error calls;
   - `Log.entryAdded` `level=error` — browser log errors (e.g. resource failures).
   Known noise is classified into a separate `warnings` list (see below).
5. Evaluates a DOM probe on the landing view, then (when the plugin is not yet
   visible there) selects one existing, non-running sidebar session row and
   re-probes the active chat view, because a composer-slot plugin may mount only
   inside a real conversation. The probe reports:
   - `document.title`, `location.href`, `document.readyState`;
   - `window.__DSH_VOICE_MODE__`: defined? / type / shape and keys;
   - `document.querySelectorAll('[data-dsh-voice-mode]').length`, how many sit
     inside the composer, plus tag/visibility/text/attrs samples;
   - composer mount: `[data-conversation-region="composer"]`,
     `[data-composer-card]`, `[data-composer-input]`, its visible textbox, and
     the conversation view's `data-content-phase` (`hero`/`active`) and
     `data-conversation-session` (proves the real chat view, not the workspace
     picker);
   - plugin-bundle evidence: whether the served `plugins/??...` script URL and
     loaded resources mention `voice-mode` (proves the client module was offered
     to the browser at all);
   - `#root` child count and a body-text sample (detects a blank/broken boot).
6. Captures `Page.captureScreenshot` to the `--screenshot` path.
7. Kills Chrome (`SIGTERM`, then `SIGKILL`) and deletes the temp profile dir on
   every exit path, including failures and Ctrl-C.

### Noise filtering

These signatures are baseline-observed/expected and go to `warnings`, not
`errors` (they never fail the gate by themselves):

| kind | why |
| --- | --- |
| `baseline-account-console-error` | `[deepseek-account] account read failed {field: profile}` — present on the live app before any plugin is installed |
| `favicon-404` | the app does not serve a favicon |
| `websocket-reconnect-chatter` | HMR/relay reconnect lines during headless boot |
| `hmr-chatter` | `[vite]`/hot-update lines |

`--strict` additionally fails on any non-noise console/log error. Plain baseline
runs fail only on uncaught page errors, a blank UI or a navigation failure.

## Baseline result (pre-install) — PASS

Artifacts: `/tmp/voice-mode-baseline.json`, screenshot `/tmp/voice-mode-baseline.png`.
Run at `2026-11-02T20:36:56Z` (local 2026-11-03), Node v24.19.0, Chrome
156.0.8078.76, URL `http://127.0.0.1:3080/`.

```json
{
  "ok": true,
  "timing": { "loadMs": 561, "settledMs": 8563, "totalMs": 12644 },
  "page": {
    "title": "Interview prep workflow repositories — DeepSeek Harness",
    "href": "http://127.0.0.1:3080/",
    "blank": false,
    "navigationError": null
  },
  "checks": {
    "boots": true,
    "composerMounted": true,
    "sessionView": true,
    "voiceMarker": false,
    "voiceDockElements": 0,
    "voiceDockInsideComposer": 0,
    "voiceBundleInScript": false,
    "newUncaughtErrors": 0,
    "newConsoleErrors": 0,
    "newLogErrors": 0
  },
  "errors": { "uncaught": [], "console": [], "log": [] },
  "warnings": [
    {
      "kind": "baseline-account-console-error",
      "text": "[deepseek-account] account read failed Object {field: profile}",
      "count": 1
    }
  ],
  "failures": [],
  "screenshot": { "path": "/tmp/voice-mode-baseline.png", "bytes": 222325 }
}
```

Two-view evidence from the same run:

| view | phase | composer mounted | session id | dock count | marker |
| --- | --- | --- | --- | --- | --- |
| landing (workspace new-session hero) | `hero` | yes | `session-ffc0b5f0-…` | 0 | absent |
| selected existing session (clicked row `session:session-b3b07f9a-…`) | `active` | yes | `session-b3b07f9a-…` | 0 | absent |

Conclusion: the app boots and the chat composer mounts in both views before the
plugin is installed; the only error on the page is the known
`[deepseek-account]` console noise, filtered. `__DSH_VOICE_MODE__` and
`[data-dsh-voice-mode]` are correctly absent at baseline.

## Harness self-test (synthetic fixtures)

The tool's marker/dock/error detection was validated against a throwaway static
page served from `/tmp` (never against the live app) before the real install:

| fixture | scenario | result |
| --- | --- | --- |
| positive | page mimics the composer DOM and sets `window.__DSH_VOICE_MODE__ = { version: 'fixture-1.0.0' }` + two `[data-dsh-voice-mode]` nodes | `exit 0`, `ok: true`, `voiceMarker: true`, `voiceDockElements: 2`, composer mounted |
| negative | same but a script throws `Error: synthetic plugin boot failure` after 100 ms | `exit 1`, `newUncaughtErrors: 1`, failure names the thrown error |

This proves the accept gate can both pass a correctly mounted plugin and fail a
plugin that throws during client boot.

## Post-install success criteria

Run the accept-gate command above. It passes (exit `0`) only when all of these
hold in the JSON report:

1. `ok: true` and `failures: []`;
2. `page.blank: false`, `page.navigationError: null`, `checks.boots: true`;
3. `checks.voiceMarker: true` — `window.__DSH_VOICE_MODE__` is defined;
4. `checks.voiceDockElements >= 1` — at least one `[data-dsh-voice-mode]` node
   exists (inspected in both the landing hero view and the active session view;
   report records `probes.initial` and `probes.final`);
5. `checks.composerMounted: true` — the chat composer still mounts;
6. `checks.newUncaughtErrors == 0`, `checks.newConsoleErrors == 0`,
   `checks.newLogErrors == 0` — baseline-subtracted, so the known
   `[deepseek-account]`/favicon/HMR noise cannot mask or trip the gate;
7. screenshot written to `/tmp/voice-mode-check.png` (read it to eyeball the
   mic control inside the composer).

Useful extra signals in the report:

- `checks.voiceBundleInScript: true` / `probes.*.pluginBundle.scriptSrcHasVoice`
  — the plugin's client module was actually offered in the served
  `plugins/??…` bundle. If this is `false`, the install has not reached the
  served client bundle (e.g. a stale page build) and the browser cannot see the
  plugin yet.
- `errors.uncaught[*].description` — if the plugin throws during client boot,
  this is the accept-gate failure; `exit 1` and the message says so.

### Expected post-install deltas vs baseline

| field | baseline | expected post-install |
| --- | --- | --- |
| `checks.voiceMarker` | `false` | `true` |
| `checks.voiceDockElements` | `0` | `>= 1` |
| `checks.voiceBundleInScript` | `false` | `true` (if the plugin is in the served bundle) |
| `errors.*` | empty | empty (new errors = against the gate) |
| `warnings` | `[baseline-account-console-error]` | same, plus at most new noise kinds |
| exit code | `0` | `0` |

## Post-install result — PASS (2026-11-03)

`@local/voice-mode@0.1.0` was installed into the live `web` profile by the Lead
(`plugin_manager install_bundle` reported `applied`). The accept-gate command:

```bash
node tools/cdp-check.mjs --expect-voice --baseline /tmp/voice-mode-baseline.json \
  --screenshot /tmp/voice-mode-check.png --json-out /tmp/voice-mode-post-install.json
# exit 0
```

Report (`/tmp/voice-mode-post-install.json`, screenshot `/tmp/voice-mode-check.png`):

```json
{
  "ok": true,
  "checks": {
    "boots": true,
    "composerMounted": true,
    "sessionView": true,
    "voiceMarker": true,
    "voiceDockElements": 2,
    "voiceDockInsideComposer": 2,
    "voiceBundleInScript": true,
    "newUncaughtErrors": 0,
    "newConsoleErrors": 0,
    "newLogErrors": 0
  },
  "errors": { "uncaught": [], "console": [], "log": [] },
  "warnings": [
    { "kind": "baseline-account-console-error", "count": 1 }
  ],
  "failures": [],
  "screenshot": { "path": "/tmp/voice-mode-check.png", "bytes": 190206 }
}
```

Observed marker: `window.__DSH_VOICE_MODE__ = { plugin: "@local/voice-mode",
version: "0.1.0", startedAt: … }`.

Dock elements found (both descendants of the composer's
`[data-composer-dock]` → `data-slot="conversation.composer.dock"`), active
session view (`data-phase="active"`, session `session-47784c1b-…`):

| # | element | attributes | geometry |
| --- | --- | --- | --- |
| 1 | `DIV` | `data-dsh-voice-mode="control"`, `data-state="off"`, inline-flex 28×28 | x=1027, y=781, 28×28, visible |
| 2 | `BUTTON` | `type="button"`, `title="Start voice conversation"`, `aria-label="Start voice conversation"`, `aria-pressed="false"`, `data-dsh-voice-mode="button"` | x=1027, y=781, 28×28, visible (circular mic in the composer status dock) |

Composer rect `{x:280, y:637, w:1153, h:176}`; dock row `{x:578, y:777,
w:557, h:32}`. The button renders as the circular mic icon in the composer's
status-dock row, immediately left of the cache-usage pill.

Two probe details learned from this install (both now handled by the tool and
visible in the report):

1. **The dock mounts only inside an active conversation.** On the landing
   workspace/hero view the marker is set (client factory ran) but
   `[data-dsh-voice-mode]` count is `0` and the composer dock slot is empty. The
   tool therefore does not treat "marker defined" as proof; when the dock is
   absent it selects an existing non-running session row and re-probes the active
   chat view, where the dock is present. That is also why the accept gate requires
   `checks.voiceDockElements >= 1` rather than only the marker.
2. **The client module is delivered via a dynamically-imported bundle.** The
   served HTML lists `@local/voice-mode/client.js` inside the plugin bundle, but
   the static `script[src]` tags on the page only carry the module-loader entry;
   the voice-mode entry shows up in the loaded resources
   (`/plugins/??…@local/voice-mode/client.js&rev=…`). `voiceBundleInScript` is
   therefore computed from all script srcs plus loaded resource entries.

No new uncaught exceptions, console errors or log errors were introduced by the
plugin; the only warning remains the pre-existing filtered
`[deepseek-account]` console noise. The plugin bundle was rebuilt with a new
`&rev=` hash after install, which the tool now normalises before comparing
error signatures to the baseline.

## Functional voice-loop probe (`--voice-loop-probe`)

Mounting the dock is necessary but not sufficient: the plugin's remote-transport
call (`remote.session.follow(...)`) only runs once the mic is toggled. The tool
can exercise that loop without a real microphone and without sending anything:

```bash
node tools/cdp-check.mjs --expect-voice --voice-loop-probe \
  --baseline /tmp/voice-mode-baseline.json \
  --screenshot /tmp/voice-mode-click-probe.png \
  --json-out /tmp/voice-mode-click-probe.json
```

After the mount probe, with the composer dock present in an active session, it:

1. captures `window.__DSH_VOICE_MODE__`, the dock `data-state`, the dock text and
   the composer/message counters;
2. clicks `[data-dsh-voice-mode="button"]` once via `Runtime.evaluate` (a real DOM
   `.click()`, with a user gesture);
3. waits 5 s, then reads and reports `JSON.stringify(window.__DSH_VOICE_MODE__)`,
   the control `data-state`, every `[data-dsh-voice-mode]` node (incl. the status
   span text), and any new uncaught/console/log entries;
4. captures the ON-state screenshot;
5. clicks the same button again, waits 1 s, and reports the marker `mode`/control
   state after stop.

It never types into the composer, never presses Enter and never sends a message.
Safety gate: if the diagnostics show `prompt: "accepted"` or a conversation or
user-message/user-count change, it records `safetyStop` with exactly what
changed, stops the loop immediately and fails the run.

### 2026-11-03 (later) result — PASS after inject fix

Plugin fix: factory inject list is now `['slots', 'locale', 'remote',
'remote.session']` (the dotted `remote.session` Cordis service was the missing
declaration). Fresh artifact `rev=9b3465df7e71`. Same command, fresh headless
boot, active session, ONE mic click, 5 s wait, then stop click:

```json
{
  "ok": true,
  "checks": { "voiceMarker": true, "voiceDockElements": 2,
              "newUncaughtErrors": 0, "newConsoleErrors": 0, "newLogErrors": 0,
              "voiceLoop": { "clicked": true, "stopped": true, "blocker": null,
                             "safetyStop": false, "modeOn": "on",
                             "recognition": "started", "follow": "open",
                             "followError": null, "frames": 1, "prompt": "idle",
                             "controlStateOn": "listening",
                             "modeOff": "off", "controlStateOff": "off" } },
  "errors": { "uncaught": [], "console": [], "log": [] },
  "failures": [],
  "screenshot": { "path": "/tmp/voice-mode-click-probe.png", "bytes": 163270 }
}
```

`JSON.stringify(window.__DSH_VOICE_MODE__)` after 5 s ON:

```json
{"plugin":"@local/voice-mode","version":"0.1.0","startedAt":1793652575910,
 "mode":"on","recognition":"started","follow":"open","prompt":"idle",
 "followSessionId":"session-72abf235-…","frames":1}
```

Control `data-state="listening"`, status span text `Listening`, button
`aria-label="Stop voice conversation"`/`aria-pressed="true"` (green). After the
stop click: `mode:"off"`, `recognition:"stopped"`, control `data-state="off"`,
status span removed; no new uncaught/console/log errors. No transcript was
produced: `prompt:"idle"`, composer text empty, user-message counters unchanged,
`safetyStop:false`.

Minor diagnostic mismatch (not a gate failure): on stop, `follow` publishes
`"error"` with `followError:"signal is aborted without reason"` rather than the
intended `"closed"` — the abort is caught by the follow loop's generic catch, so
the teardown path overwrites the `closed` diag. Treating an aborted
controller/AbortError as a clean close in that catch would keep the diagnostics
as intended.

### Final artifact run — PASS (committed artifact)

Final rebuilt artifact `rev=e15c314d44a9` (this is the committed `client.js`),
same command but with `/tmp/voice-mode-click-probe-final.{json,png}`: `exit 0`,
`ok: true`, `failures: []`, zero new uncaught/console/log errors, no
transcript/safety stop. Marker after ON:

```json
{"plugin":"@local/voice-mode","version":"0.1.0","startedAt":1793652643343,
 "mode":"on","recognition":"started","follow":"open","prompt":"idle",
 "followSessionId":"session-72abf235-…","frames":1}
```

Marker after the stop click (the diagnostic mismatch above is now fixed):

```json
{"plugin":"@local/voice-mode","version":"0.1.0","startedAt":1793652643343,
 "mode":"off","recognition":"stopped","follow":"closed","prompt":"idle",
 "followSessionId":"session-72abf235-…","frames":1}
```

`follow:"closed"` with no `followError`, control `data-state` back to `"off"`,
status span removed. This is the artifact the gate signed off on.

### 2026-11-03 result — FAIL (actionable runtime bug, mount checks still pass)

Bundle `rev=85d2039f44e0` (fresh build). Click ON worked and the UI entered the
listening state, but the plugin's `pumpFollow` threw before `follow` could leave
`"idle"`:

- marker after 5 s:
  `{"plugin":"@local/voice-mode","version":"0.1.0","startedAt":…,"mode":"on","recognition":"started","follow":"idle","prompt":"idle"}`
  (`frames` absent);
- control `data-state="listening"`, status span text `Listening`, button
  `aria-label="Stop voice conversation"`, `aria-pressed="true"`;
- new uncaught error (1): `Error: cannot get property "remote.session" without
  inject`, first frame `Object.get (.../assets/index-CN7NIWNw.js:2:8854)` then
  `pumpFollow (.../@local/voice-mode/client.js&rev=85d2039f44e0:48632:62)`,
  `start (...:48866:14)`, `toggle (...:48931:72)`; no console/log errors;
- stop click returned `mode:"off"`, control `data-state="off"`; no further errors;
- no transcript was produced: `prompt:"idle"`, composer text empty, user-message
  counters unchanged, `safetyStop: false`.

Interpretation: the dock and the local listening state work, but the client
context accesses `remote.session` without declaring it in the plugin's `inject`
list, so the transport call throws and the loop never reaches `follow:"open"`.
No change was made to plugin source (out of scope). Re-run the command above
after the plugin fix; pass requires `follow:"open"` and zero new errors.

## Local-voice gate v0.2.0 (host-local STT/TTS) — PASS

`@local/voice-mode@0.2.0` removes Web Speech / `speechSynthesis`: capture is
`getUserMedia` + a local VAD in the page, STT/TTS run on the host and are reached
through host routes (`GET /voice-mode/status`, `POST /voice-mode/transcribe`,
`POST /voice-mode/speak`), and playback is Web Audio. Served client artifact
`rev=3cf0180576fc`. Two runs against the live GUI (`http://127.0.0.1:3080/`,
fresh headless boot, active session):

### Run 1 — mount/error gate (PASS)

```bash
node tools/cdp-check.mjs --expect-voice --baseline /tmp/voice-mode-baseline.json \
  --screenshot /tmp/voice-mode-local.png --json-out /tmp/voice-mode-local.json
# exit 0
```

`ok:true`, marker `{plugin:"@local/voice-mode", version:"0.2.0"}`, docks `2`
(inside composer `2`), `voiceBundleInScript:true`, new uncaught/console/log
errors `0/0/0`, taskbar button `title="Start voice conversation (local)"`,
`data-state="off"`. Screenshot `/tmp/voice-mode-local.png`.

### Run 2 — local engine + capture probe (PASS)

```bash
node tools/cdp-check.mjs --expect-voice --engine-probe \
  --engine-json-out /tmp/voice-mode-engine-probe.json \
  --baseline /tmp/voice-mode-baseline.json \
  --screenshot /tmp/voice-mode-local-engine.png \
  --json-out /tmp/voice-mode-local-run2.json
# exit 0
```

(a) In-page `fetch('/voice-mode/status')`: HTTP 200, `ok:true`,
`stt.ready:true`, `stt.provider:"sensevoice"`, `stt.location:"host-local"`,
`tts.ready:true`, `tts.engine:"kokoro"`, `tts.sampleRate:24000`,
`tts.speakerCount:54`, kokoro `available:true` / `modelPresent:true`
(`modelBytes:114202993`), `onnxruntime 1.28.2`.

(b) In-page `POST /voice-mode/speak` (`{"text":"Local speech probe."}`) then
`AudioContext.decodeAudioData`: HTTP 200, `audio/wav`, `bytes:61366`,
decoded `seconds:1.278`, `channels:1`, `frames:56339`, no decode error.
(`decodeAudioData` reports `sampleRate:44100` because Chrome resamples into the
`AudioContext` rate; the host engine's native rate is the `24000` reported by
`/status`.)

(c) Safety hook: `window.__DSH_VOICE_MODE__.suppressPrompts = true` —
`set:true`.

(d) After ONE mic click + 4 s:

```json
{"plugin":"@local/voice-mode","version":"0.2.0","startedAt":…,
 "suppressPrompts":true,"mode":"on","capture":"running","vad":"speech",
 "follow":"open","transcribe":"idle","speak":"idle","prompt":"idle",
 "bargeIn":false,"engine":"kokoro","ttsReady":true,
 "followSessionId":"session-72abf235-…","frames":1}
```

Control `data-state="hearing"`, status span text `Hearing you`, button
`aria-label="Stop voice conversation"`/`aria-pressed="true"` (green). The fake
audio device drove the local VAD to `vad:"speech"`; with `suppressPrompts:true`
no prompt was sent (`prompt:"idle"`, no transcript finalized inside 4 s).

(e) After the stop click + 1 s: `mode:"off"`, `capture:"stopped"`,
`vad:"idle"`, `follow:"closed"`, control `data-state="off"`, button back to
`Start voice conversation (local)`.

(f) New errors for the whole run: uncaught `0`, console `0`, log `0`. The
conversation was unchanged: user-message counters `0→0`, composer text `""`,
conversation text length `11406→11406`, `conversation.changed:false`. No typing,
no Enter, no session changes.

## Re-running / troubleshooting

```bash
# human-readable progress on stderr while keeping stdout pure JSON
node tools/cdp-check.mjs --expect-voice --baseline /tmp/voice-mode-baseline.json --debug > /tmp/report.json

# inspect one field
node -e 'const r=require("/tmp/report.json"); console.log(r.checks, r.failures)'

# if the baseline file is missing, regenerate it (must be done on the app
# BEFORE the plugin is installed):
node tools/cdp-check.mjs --screenshot /tmp/voice-mode-baseline.png --json-out /tmp/voice-mode-baseline.json
```

- If Chrome is not at the default path, set `CHROME_PATH`.
- If the app is not on `http://127.0.0.1:3080/`, pass `--url`.
- If the port is taken, the tool picks an ephemeral remote-debugging port; a
  fixed one can be forced with `--port`.
- `--keep-chrome` leaves the headless browser running for manual inspection
  (the temp profile dir is printed with `--debug`).
- The tool itself never installs, edits or restarts anything; it is read-only
  against the app and writes only the `--screenshot` and `--json-out` paths.
