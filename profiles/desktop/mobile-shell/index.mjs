/**
 * mobile-shell — make the DSH Web GUI usable on a phone, and stop pull-to-refresh.
 *
 * WHY. The shipped Web shell is a desktop three-column grid with no responsive
 * layer: `AppFrame` renders `grid-template-columns: <sidebar>px minmax(0,1fr)
 * <rightbar>px` inline, and nothing in the shell CSS is media-queried. On a
 * phone that produces four concrete failures, all measured on this box at
 * 390x844:
 *
 *   1. Tapping "Open sidebar" sets the first track to 280px and leaves the
 *      conversation 110px wide (the composer collapses to 64px). The shell is
 *      `SIDEBAR_AUTO_COLLAPSE`-aware for *collapsing* below 1024px, but an
 *      expanded sidebar is still a grid track, never a drawer.
 *   2. Settings is a fixed 188px nav beside `flex:1` content inside an 800px
 *      panel capped at `100vw - 48px`. On a 390px phone the content pane gets
 *      154px, so settings text wraps one word per line and controls clip.
 *   3. Nothing sets `overscroll-behavior`, and `html`/`body` stay
 *      `overflow: visible`, so a downward drag at the top of a scroller hands
 *      the gesture to the browser: pull-to-refresh fires and you lose the page.
 *   4. The shell sizes off `height:100%` chained from `html`, i.e. the *large*
 *      viewport. On a real phone the bottom of the shell — the composer — sits
 *      behind the browser UI, and `100vh` panels run off the bottom edge.
 *
 * HOW. One plugin, one injected `<style>`, one small classic `<script>`, added
 * through the webserver's documented index-injection seam
 * (`ctx.webServer.tapIndex`) so nothing under `node_modules` is touched and a
 * `dsh` upgrade cannot silently drop the fix. The viewport meta has to be
 * *rewritten*, which no structured `webserver/index-inject` row expresses,
 * which is why this uses the raw tap.
 *
 * STYLE AND SCRIPT LIVE IN SIBLING FILES (`shell.css`, `shell.js`) AND ARE READ
 * PER INDEX RENDER. The profile reloads live, but the loader re-imports a row's
 * module through `import()`, which Node caches by URL — so editing *this* file
 * needs a restart while editing the two assets does not. Tune the CSS, reload
 * the browser, done.
 *
 * Breakpoints are derived, not guessed:
 *   - 979px for the drawer. `computeColumns` only gives the right column a
 *     track when `viewport - sidebar - 400 >= 300`. An expanded sidebar solves
 *     to 280px, so the third track is provably 0 below 980px and the drawer
 *     rule can safely zero the sidebar track without stranding the right panel.
 *   - 700px for the settings stack. The panel is `100vw - 48px` with a fixed
 *     188px nav, so stacking below 700px keeps the content pane >= 464px.
 *
 * REVERT. Delete the `mobile-shell` insert from
 * `~/.dsh/profiles/web/cordis.patch.yml` (and this directory, optionally). The
 * profile is patchReload: live, so the injected style and script disappear on
 * the next index render.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'mobile-shell'

/** `webServer` owns `tapIndex`, the raw index transform used below. */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

/** path -> { mtimeMs, text }; assets are re-read only when their mtime moves. */
const assetCache = new Map()

/**
 * Read one sibling asset, re-reading only when it changed on disk.
 * @param file - file name inside this directory.
 * @returns the asset text.
 */
function asset(file) {
  const path = join(HERE, file)
  const { mtimeMs } = statSync(path)
  const cached = assetCache.get(path)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.text
  const text = readFileSync(path, 'utf8')
  assetCache.set(path, { mtimeMs, text })
  return text
}

/** Rewrite the shipped viewport meta in place, or fall back to a new tag. */
function withViewportMeta(html) {
  const content = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content'
  const tag = `<meta name="viewport" content="${content}" />`
  const existing = /<meta\s+name="viewport"[^>]*>/i
  // Function replacements throughout: the payloads are injected verbatim and
  // must never be read as `$`-substitution patterns.
  if (existing.test(html)) return html.replace(existing, () => tag)
  return html.replace(/<head([^>]*)>/i, (_match, attrs) => `<head${attrs}>\n    ${tag}`)
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        const payload =
          `<style id="dsh-mobile-shell">${asset('shell.css')}</style>\n` +
          `<script id="dsh-mobile-shell-js">${asset('shell.js')}</script>\n</head>`
        return withViewportMeta(html).replace(/<\/head>/i, () => payload)
      }),
    'mobile-shell: inject the phone shell CSS and script',
  )
}
