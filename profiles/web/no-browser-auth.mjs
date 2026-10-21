/**
 * Local override for the `web` profile: no browser token on loopback.
 *
 * WHY. `@deepseek-ai/dsh-client-connection` gates index.html and every `/api`
 * request behind a per-process launch token that it exchanges for a signed,
 * authority-bound cookie. The token is random per process and the cookie lives
 * in one browser profile, so every other browser on this machine is bounced
 * back to the tokenized URL `dsh web` prints. This row removes that step for
 * loopback access: open http://127.0.0.1:<port>/ in any browser, no token.
 *
 * WHAT IS KEPT. Only the *authentication* owner is replaced, and only for
 * loopback requests and the exact public GUI hostname (which is gated by
 * Cloudflare Access in front). Everything else keeps today's behaviour byte
 * for byte:
 *
 *   - the Host/Origin fence (`isTrustedApiRequest`) still runs first on every
 *     `/api` request, so DNS rebinding (`Host: evil.example` over a socket to
 *     127.0.0.1) and cross-site requests are still refused;
 *   - index.html is served without a token only when the Host header really is
 *     loopback, which is exactly the condition rebinding cannot forge;
 *   - any non-loopback authority (an explicit `--trusted-host`, a LAN IP)
 *     still falls through to the real token/cookie check.
 *
 * Scope: loopback only. The webserver still refuses `--host 0.0.0.0`, so this
 * does not publish the harness API (which can run commands) to the network.
 *
 * REVERT. Delete the row from `cordis.patch.yml`; the disposer below restores
 * the real authentication owner in place, no restart needed. This file then
 * does nothing and can be deleted too.
 */
export const name = 'local-no-browser-auth'

/** `connection` owns the browser authentication this row wraps. */
export const inject = ['connection']

/** Read one header from either a node:http header bag or a fetch Headers. */
function headerOf(headers, key) {
  if (headers instanceof Headers) return headers.get(key) ?? undefined
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

/** Public GUI hostname served through the Cloudflare Tunnel (Access-gated). */
const PUBLIC_GUI_HOSTS = ['dsh.typosbro.me']

/** True when the Host header is exactly the public GUI hostname. */
function isPublicGuiRequest(headers) {
  const host = headerOf(headers, 'host')
  if (host === undefined) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return PUBLIC_GUI_HOSTS.includes(hostname)
}
/** True for the local loopback authority: localhost, [::1], or any 127/8 IPv4. */
function isLoopbackRequest(headers) {
  const host = headerOf(headers, 'host')
  if (host === undefined) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function apply(ctx) {
  const connection = ctx.connection
  const original = connection.browserAuth
  if (original === undefined) {
    throw new Error('local-no-browser-auth: connection.browserAuth is missing; the dsh-client-connection internals changed, so this override no longer applies')
  }

  connection.browserAuth = {
    /** Loopback and the Access-gated public hostname skip the cookie; all other authorities keep the real check. */
    isAuthenticated: (request) => isLoopbackRequest(request.headers) || isPublicGuiRequest(request.headers) || original.isAuthenticated(request),
    /** Serve index.html token-free on loopback and the public hostname; otherwise defer to the real owner (mint cookie / 401). */
    authorizeIndex: (req, res) => isLoopbackRequest(req.headers) || isPublicGuiRequest(req.headers) || original.authorizeIndex(req, res),
    /** Announce the clean origin instead of a `?token=` URL. */
    authenticatedUrl: (baseUrl) => new URL(baseUrl).href,
  }

  ctx.effect(() => () => {
    connection.browserAuth = original
  }, 'local-no-browser-auth: restore browser authentication')
}
