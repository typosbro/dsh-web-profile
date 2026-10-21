# Why these rows exist

A profile patch is a list of decisions. This file is the decision log. If a row cannot justify
itself here, delete the row.

## `local-no-browser-auth`

DSH binds to loopback and mints a per-process token for the GUI. On a single-user box that token
is friction: every reload and every phone handoff needs it. The plugin wraps the connection
row's authentication owner so a loopback request skips the token, while the Host/Origin fence
that stops DNS rebinding keeps behaving exactly as shipped.

The boundary matters: this is not "authentication off". It is "loopback does not need a
per-process secret". A request from any other authority still hits the real owner.

## `mobile-shell`

The shipped shell is a desktop grid. On a 390px viewport an expanded sidebar left the
conversation about 110px wide. This module draws the sidebar as an overlay drawer, stacks the
settings nav above content, pins the shell to the dynamic viewport so the composer clears mobile
browser chrome, applies safe-area insets, and disables pull-to-refresh and document overscroll.

It contributes no service and no route: it only taps the index HTML. That is why it is safe to
keep enabled for desktop users.

## `web-pwa`

A manifest with real 192/512/maskable icons means Chrome offers a true WebAPK install instead of
a bookmark shortcut. No service worker on purpose: the client is a live websocket session, and a
cache layer would risk serving a stale shell against a newer host.

## `plugin-package-inventory-deepseek`

A marketplace surface, not a runtime dependency. It performs network calls at boot on a box that
does not browse the catalog from the GUI.

## Permission presets

Three presets, one default. The public default is `workspace-write`: the agent can edit the
workspace, and the harness asks before actions that leave it. The author's own box runs
`danger-full-access` with `approval: never`, which is a deliberate trade: fewer prompts, no
safety net.

Keep the presets even if you never switch: the access mode is visible in the composer and the
model can be told which one it is under.

## Hook bridge and the stop gate

The bridge runs a Claude Code-style hooks file at the same interception points, so an existing
repository gate is reused instead of rewritten.

`Stop` is the load-bearing hook. It runs the repository's own gate before the turn can end:

1. `scripts/agent-gate.sh` if present,
2. otherwise `package.json` `gate`,
3. otherwise `gate:fast`,
4. otherwise nothing (exit 0).

Three design choices keep it from becoming a tax:

- A clean git tree skips the gate. Nothing changed, nothing to check.
- A failure exits 2 and its stderr becomes the steering reason, so the model sees the actual
  failure instead of a generic "blocked".
- At most two blocks per session, then it stands down. A pre-existing breakage cannot trap a
  turn forever.

This is the single highest-leverage row in the profile: it converts "the model says it is done"
into "the repository says it is done".

## Browser stack

Three plugins, one job each:

- `playwright-browser` starts a pinned `@playwright/mcp` (0.0.83) server over stdio, headless
  Chrome, 390x844 viewport, and a CDP port so a second client can attach.
- `browser-pane` re-enables the shipped right-sidebar Browser tab, which the web bundle disables
  outside the `desktop` profile.
- `browser-live` adds the host routes and the client pane that attach to that CDP endpoint.

The MCP server is pinned because Playwright MCP changes its accessibility snapshot format
between minor versions, and the agent's refs (`ref_3`) are only valid within one snapshot
version.

## What was deliberately left out

- Model keys and provider accounts: `docs/models.md` shows the shape, the keys stay in
  `~/.dsh/.env` or the credential store.
- Relay/tailnet exposure: it publishes the GUI on a private network. That is a deployment
  decision, not a profile default.
- Search routing: the shipped route bills a model turn per search; `examples/` shows the
  free local alternative instead of silently changing it.
