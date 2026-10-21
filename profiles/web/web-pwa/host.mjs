/**
 * web-pwa — make the DSH Web GUI installable as a real app from Chrome.
 *
 * The GUI already ships a manifest, but it is not installable as a WebAPK: it
 * declares only an SVG icon with `sizes: "any"`, and Chrome needs bitmap icons
 * at 192px and 512px before it will offer a real install instead of a bookmark
 * shortcut. It also declares `display: "fullscreen"`, which hides the phone's
 * status bar.
 *
 * Chrome dropped the service-worker requirement for menu install in 108
 * (mobile) / 112 (desktop), so this deliberately registers NO service worker:
 * the app is a live websocket client and any caching layer would risk serving
 * a stale shell.
 *
 * Nothing under node_modules is touched. Assets are served from this directory
 * through the webserver's public route API, and the head is patched through the
 * same `tapIndex` seam the mobile-shell row uses.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Public prefix for every asset this row serves. */
const PREFIX = '/dsh-pwa'
const MANIFEST_PATH = `${PREFIX}/manifest.webmanifest`

/** Everything this route is willing to serve, by extension. */
const CONTENT_TYPES = {
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
}

/**
 * Small mtime-keyed read cache, so editing the manifest or regenerating an icon
 * takes effect on the next request without restarting `dsh web`.
 */
const cache = new Map()
function readAsset(name) {
  const path = join(HERE, name)
  const { mtimeMs } = statSync(path)
  const hit = cache.get(path)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.body
  const body = readFileSync(path)
  cache.set(path, { mtimeMs, body })
  return body
}

/**
 * The injected script is read from a sibling file on every index render, for the
 * same reason mobile-shell does it: the loader does not re-import an already
 * imported row module, so code baked into this file would need a full `dsh web`
 * restart to change, while a sibling file only needs a browser reload.
 */
const scriptCache = new Map()
function readScript(file) {
  const path = join(HERE, file)
  const { mtimeMs } = statSync(path)
  const hit = scriptCache.get(path)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.body
  const body = readFileSync(path, 'utf8')
  scriptCache.set(path, { mtimeMs, body })
  return body
}

/**
 * Point the shipped manifest link at our installable manifest, and add the
 * touch/theme metadata the shipped head is missing.
 */
function withPwaHead(html) {
  let out = html

  // Rewrite the existing manifest link rather than adding a second one: two
  // manifest links make the browser's choice ambiguous.
  const manifestLink = /<link[^>]*rel=["']manifest["'][^>]*>/i
  if (manifestLink.test(out)) {
    out = out.replace(manifestLink, (tag) =>
      tag.replace(/href=["'][^"']*["']/i, `href="${MANIFEST_PATH}"`),
    )
  } else {
    out = out.replace(/<\/head>/i, `<link rel="manifest" href="${MANIFEST_PATH}">\n</head>`)
  }

  // `viewport-fit=cover` is already set by the mobile-shell row, so the splash
  // and the installed window both extend under the safe areas.
  out = out.replace(
    /<\/head>/i,
    [
      // Status-bar tint. The static value below is only the pre-JS default; the
      // script keeps it in step with whichever theme the app resolves to.
      '<meta name="theme-color" content="#151517">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="DSH">',
      `<link rel="apple-touch-icon" href="${PREFIX}/icon-192.png">`,
      `<link rel="icon" type="image/png" sizes="192x192" href="${PREFIX}/icon-192.png">`,
      '<script id="dsh-pwa-js">',
      readScript('theme-color.js'),
      '</script>',
      '</head>',
    ].join('\n'),
  )
  return out
}

export const name = 'web-pwa'
export const inject = ['webServer']

export function apply(ctx) {
  // One prefix route serves the manifest and every icon. Names are matched
  // against a strict allowlist so a crafted pathname cannot escape this dir.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler(req, res) {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const name = pathname.slice(PREFIX.length).replace(/^\/+/, '')
        const type = CONTENT_TYPES[extname(name).toLowerCase()]

        if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..') || type === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }

        let body
        try {
          body = readAsset(name)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }

        const headers = {
          'content-type': type,
          'content-length': String(body.length),
          // `no-cache` still allows a stored copy, but forces revalidation, so
          // a regenerated icon shows up on reload instead of going stale.
          'cache-control': 'no-cache',
        }
        // The worker is served from this prefix but must control the whole
        // origin, because `start_url` is `/`. That is exactly what this header
        // is for; without it the scope would be limited to /dsh-pwa/.
        if (extname(name).toLowerCase() === '.js') headers['service-worker-allowed'] = '/'
        res.writeHead(200, headers)
        res.end(body)
      },
    }),
  )

  ctx.effect(() => ctx.webServer.tapIndex((html) => withPwaHead(html)))
}
