# @local/browser-live

A right-sidebar pane in the DSH Web GUI that shows a **live JPEG stream of the
agent's own headless Chrome**, with optional click / type / scroll forwarding
from the human into that page.

Two halves, one package:

| File | Half | Role |
| --- | --- | --- |
| `index.js` | Host (Cordis plugin) | Discovers the CDP endpoint, attaches the page target, runs `Page.startScreencast`, serves the two HTTP routes, dispatches input. |
| `client.js` | Web client | Registers the `browser-live` right-sidebar tab: the `<img>` stream, the ownership badge, and the input forwarding. |

## Routes

Both routes are registered with `kind: 'exact'` on the host `webServer` and both
call `ctx.connection.requestRejection(req)` **first**; a rejected request gets
that status and nothing else happens.

### `GET /browser-live/live.mjpg`

* `Content-Type: multipart/x-mixed-replace; boundary=browserliveframe`
* One JPEG part per frame, each preceded by `Content-Length` and `X-Seq` headers.
* A zero-length text part is written on connect so a client can confirm the
  stream before the first frame arrives.
* `X-Browser-Live-Viewport: <cssWidth>x<cssHeight>` reports the measured CSS
  viewport (390x844 for the default phone-sized target). **Input coordinates are
  always in these units**, never in the JPEG's decoded pixel size.
* The newest frame is written to every responder; a responder that cannot keep
  up is skipped, never queued.

### `POST /browser-live/input`

JSON body, answered `204` on success:

```json
{ "type": "click",  "x": 120, "y": 300, "button": "left" }
{ "type": "move",   "x": 120, "y": 300 }
{ "type": "text",   "text": "hello" }
{ "type": "key",    "key": "Enter", "code": "Enter" }
{ "type": "scroll", "x": 195, "y": 500, "deltaX": 0, "deltaY": 240 }
```

Mapping to CDP: `Input.dispatchMouseEvent` (click/move),
`Input.insertText` (text), `Input.dispatchKeyEvent` (key),
`Input.synthesizeScrollGesture` (scroll). `x`/`y` are clamped to the measured
viewport. Malformed JSON is `400`, a dispatch failure is `502`.

## CDP endpoint contract

Discovery is a `GET` of `http://127.0.0.1:9222/json/version`; the plugin reads
`webSocketDebuggerUrl` from that JSON and connects with Node's global
`WebSocket`. On that socket it calls, in order:

1. `Target.setDiscoverTargets { discover: true }`
2. `Target.getTargets` -> first `type: 'page'` target
3. `Target.attachToTarget { targetId, flatten: true }`
4. `Page.enable`, then `Page.getLayoutMetrics` -> `cssVisualViewport` for the
   coordinate space
5. `Page.startScreencast { format: 'jpeg', quality: 60, maxWidth: 780, maxHeight: 1688, everyNthFrame: 3 }`

Every `Page.screencastFrame` is answered with `Page.screencastFrameAck`
(`sessionId` from the frame params). Without that ack Chrome stops sending
frames, permanently. The screencast is re-armed after `Page.frameNavigated`,
`Page.navigatedWithinDocument`, `Page.loadEventFired`, `Target.attachedToTarget`,
`Target.detachedFromTarget` and `Target.targetCrashed`.

If the endpoint is absent the plugin does **not** throw: it logs one warning,
both routes answer `503` (with `Retry-After`), and discovery retries with
exponential backoff from 1 s to 15 s.

## Changing fps and quality

Every knob is plugin config; defaults match the measured configuration (about
1 frame/second and ~28 KB per JPEG on an idle-ish page):

| Key | Default | Meaning |
| --- | --- | --- |
| `maxFps` | `2` | Server-side cap on stream writes. |
| `jpegQuality` | `60` | `quality` passed to `Page.startScreencast`. |
| `everyNthFrame` | `3` | `everyNthFrame`; the cheapest way to raise or cut frame rate. |
| `captureMaxWidth` / `captureMaxHeight` | `780` / `1688` | Screencast budget; JPEG pixel size, so also the bandwidth lever. |
| `cdpHttpEndpoint` | `http://127.0.0.1:9222/json/version` | Discovery URL. |
| `rearmDelayMs` | `350` | Settle time before re-arming after navigation. |
| `retryMinMs` / `retryMaxMs` | `1000` / `15000` | Reconnect backoff bounds. |
| `probeTimeoutMs` | `1500` | Discovery probe timeout at load. |

Set them in the plugin row in your composition, for example
`{ id: browser-live, config: { maxFps: 4, jpegQuality: 45 } }`. Lower `quality`
and the capture budget first when the tunnel feels slow; raise `everyNthFrame`
downward (e.g. to `1`) only if you need smoothness more than bytes.

## Security notes (honest)

* The two routes are **not** auto-gated by the web server; they call
  `ctx.connection.requestRejection(req)` themselves and answer its status. This
  is required: the loopback GUI of this profile is deliberately
  unauthenticated, while the tunnel host is public.
* Even so, the stream is a live view of a browser that holds the agent's
  sessions, and the input route injects real events into that browser. Anything
  that can reach these routes with an accepted connection can watch and drive
  that page. Treat exposure of the GUI as exposure of the browser.
* There is no allowlist on input: `POST /browser-live/input` will dispatch
  whatever valid payload it is given, from any accepted client.
* The target browser is fixed by `cdpHttpEndpoint`, default `127.0.0.1:9222`.
  Whatever answers CDP on that port is what this pane shows and drives — if the
  agent's own production browser listens there, the pane is that browser, not a
  scratch one. Run the pane against a dedicated scratch browser on its own port
  when isolation matters.
* No frame data is written to disk, and no credentials are read by this plugin.

## Ownership (honest)

The pane has a **Take control / Release** toggle and a badge showing who is
driving. Input is forwarded only while the human holds control, and releasing
detaches the listeners immediately while the stream keeps running.

This is a **human-side discipline, not host-enforced arbitration**. The host
does not know who "holds the lock", does not queue or refuse agent input, and
does not stop the agent from clicking at the same time. If you and the agent act
on the same page simultaneously you will fight over it — release when you are
done, and do not treat the badge as a guarantee.

## Client-half loading

The Web client loader evaluates `client.js` as a classic script, so the file is
wrapped in `window.__ModuleLoader__.load({ id, factory })` rather than using
top-level `export`; a bare `export` throws `Unexpected token 'export'` and takes
the whole Web boot down with it. `inject` is
`['sidebarRightTabs', 'slots', 'locale']`.

## Layout

```
browser-live/
  package.json        # @local/browser-live, dsh.bundle.patch + dsh.client
  cordis.patch.yml    # insert { id: browser-live, name: '@local/browser-live' }
  index.js            # host: routes + CDP bridge
  client.js           # web: sidebar tab (module-loader wrapped)
  locale/en.json      # { meta: { title, description } }
  locale/zh.json
  icon.svg
  README.md
```
