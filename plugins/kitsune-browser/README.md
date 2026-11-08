# @local/kitsune-browser

Live browser control for DSH: the owner's **everyday Firefox/Zen window**, through
the [Kitsune](https://github.com/junyeong-nero/kitsune) MCP server. Logged-in
profile, real accounts, the tabs the owner is reading.

This is not the Playwright sandbox. `@local/playwright-browser` drives its own
Chromium with its own profile; `@local/browser-live` streams that sandbox into the
sidebar. Neither one sees the owner's accounts, and their tabs must never be
presented as the owner's browser.

| File | Role |
| --- | --- |
| `cordis.patch.yml` | One `@deepseek-ai/dsh-mcp-client` row, `serverName: kitsune` → tools `mcp__kitsune__*` |
| `package.json` | Bundle manifest; no host code of its own |
| `icon.svg`, `locale/en.json` | Plugin-manager listing |

## Prerequisites

| Need | Check |
| --- | --- |
| `uv` / `uvx` | `/Users/typosbro/.local/bin/uvx --version` |
| Kitsune extension active in the browser | `{"active": true}` for `kitsune@junyeong-nero.github.io` in the profile's `extensions.json` |
| Bridge reachable | `lsof -nP -iTCP:47652 -sTCP:LISTEN`; the MCP server starts it |

The patch uses an **absolute** `command`. The DSH web host starts under launchd
with a PATH that has no `~/.local/bin`, so `command: uvx` fails at spawn with
ENOENT, the MCP client logs a startup error, and no tools appear. This was
verified on 2026-11-08; the same failure broke the Claude Code registration until
it was pinned to an absolute path too.

## Enable it

Opt-in, because it reaches the owner's logged-in browser. Two edits in the profile,
then one restart:

```jsonc
// ~/.dsh/profiles/web/package.json — dependencies
"@local/kitsune-browser": "link:../../plugins/kitsune-browser"

// ~/.dsh/profiles/web/package.json — dsh.profile.bundles
"@local/kitsune-browser"
```

```bash
cd ~/.dsh/profiles/web && pnpm install
```

Then restart the harness (`dsh web`). Do not restart it from inside a running
turn — the turn dies with it.

## Mode

The server's own default is `act`: every published tool, including clicks and
submits. Add an `env` block to the row to hard-cap it:

```yaml
        env:
          KITSUNE_MODE: read          # read | draft | act — needs a restart to change
          KITSUNE_CAPS: core,browse,read
```

`read` publishes eight read tools and nothing that writes. `draft` adds typing and
form fills but no click, keypress or submit. Task modes intersect with
`KITSUNE_CAPS`; setting them does not change the bridge's own policy.

## Using it

- Every tab is readable; **writes need a tab the agent owns**. `browser_tab_list`
  with `new_tab` opens a background tab and makes it current.
- Never select or navigate the tab the owner is reading; `select` does not switch
  their view, but it changes what the agent reads next.
- One interaction, then re-read the snapshot or URL. The extension answers one
  command at a time and a blind chain is how a stray click lands on the wrong page.
- A server restart starts with **no current tab**: pass `tab_id` explicitly.

## Fallback without a harness reload

`scripts/kitsune-call.py` speaks MCP stdio to the same pinned server, one call per
invocation:

```bash
scripts/kitsune-call.py tabs
scripts/kitsune-call.py call browser_snapshot '{"tab_id": 11}'
scripts/kitsune-call.py --mode draft call browser_fill_form '{...}'
```

It resolves `uvx` from PATH, then `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` (or `KITSUNE_UVX`). Use it when the plugin is not mounted yet,
when the harness needs a restart you are not allowed to perform mid-turn, or in any
agent that has a shell but no MCP client.

## Version pin

`kitsune-browser-mcp==0.7.3` appears in three places, all of which must move
together: this patch, `agent-kit/harness/claude/mcp.tsv`, and
`scripts/kitsune-call.py` (`SERVER_VERSION`). The extension version can trail the
server package.
