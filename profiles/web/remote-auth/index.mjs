/**
 * remote-auth — serve the GUI without a per-process launch token to the
 * authorities this deployment already declares trusted.
 *
 * WHY. `@deepseek-ai/dsh-client-connection` gates index.html and every `/api`
 * request behind a random per-process token exchanged for a signed cookie. The
 * cookie lives in one browser profile, so any other device — a phone on the
 * tailnet, a second browser — is bounced back to a tokenised URL that changes
 * every restart. That makes a durable phone shortcut or QR code impossible.
 *
 * WHAT THIS DOES NOT DO. It does not invent its own allow-list. It exempts
 * exactly two things:
 *   1. the loopback authority, which no other machine can present, and
 *   2. whatever the operator put in `--trusted-host` / `trustedHosts`.
 * That second set is the same list the Host/Origin fence already uses, so this
 * row widens nothing: an authority that was not trusted before is still refused
 * before authentication is ever consulted.
 *
 * The fence itself is untouched. `isTrustedApiRequest` still runs first on every
 * `/api` request, so DNS rebinding (`Host: evil.example` over a socket to
 * 127.0.0.1) and cross-site requests are still refused, and a non-loopback
 * authority that was never declared trusted still falls through to the real
 * token check.
 *
 * Only the three authentication entry points are shadowed, as own properties on
 * the live instance so every other member (`authenticateApi`, `authorizeConnect`,
 * `authenticate`, `writeUnauthorized`) keeps its prototype implementation. The
 * disposer restores the exact prior property descriptors.
 *
 * REVERT. Delete the row from `cordis.patch.yml`; the disposer restores the real
 * authentication owner in place, no restart needed.
 */
export const name = 'remote-auth'

/** `connection` owns browser authentication; `webStartup` owns trustedHosts. */
export const inject = ['connection', 'webStartup']

/** Read one header from a node:http header bag or a fetch Headers object. */
function headerOf(headers, key) {
  if (headers instanceof Headers) return headers.get(key) ?? undefined
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

/** Parse a `host[:port]` authority from a header value. */
function authorityOf(headers) {
  const host = headerOf(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`http://${host}`)
    return { hostname: url.hostname, host: url.host }
  } catch {
    return undefined
  }
}

/** True for the local loopback authority: localhost, [::1], or any 127/8 IPv4. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Mirror `isTrustedAuthority`: a port-less entry matches the hostname on any
 * port, an entry with a port matches that exact authority.
 */
function matchesTrusted(entry, authority) {
  if (typeof entry !== 'string' || entry.length === 0) return false
  let url
  try {
    url = new URL(entry.includes('://') ? entry : `http://${entry}`)
  } catch {
    return false
  }
  return url.port === ''
    ? url.hostname === authority.hostname
    : url.host === authority.host
}

export function apply(ctx) {
  const connection = ctx.connection
  const auth = connection.browserAuth
  if (auth === undefined) {
    throw new Error(
      'remote-auth: connection.browserAuth is missing; the dsh-client-connection internals changed, so this override no longer applies',
    )
  }

  const trustedHosts = () => ctx.webStartup?.trustedHosts ?? []

  /** True when this request authority may skip the browser token. */
  const exempt = (headers) => {
    const authority = authorityOf(headers)
    if (authority === undefined) return false
    if (isLoopbackHostname(authority.hostname)) return true
    return trustedHosts().some((entry) => matchesTrusted(entry, authority))
  }

  const originalIsAuthenticated = auth.isAuthenticated
  const originalAuthorizeIndex = auth.authorizeIndex
  const originalAuthenticatedUrl = auth.authenticatedUrl
  const saved = ['isAuthenticated', 'authorizeIndex', 'authenticatedUrl'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(auth, key),
  ])

  auth.isAuthenticated = function (request, secure) {
    return exempt(request.headers) || originalIsAuthenticated.call(this, request, secure)
  }
  auth.authorizeIndex = function (req, res, secure) {
    return exempt(req.headers) || originalAuthorizeIndex.call(this, req, res, secure)
  }
  auth.authenticatedUrl = function (baseUrl) {
    // Announce the clean origin for an exempt authority instead of a `?token=` URL.
    try {
      if (isLoopbackHostname(new URL(baseUrl).hostname)) return new URL(baseUrl).href
    } catch {
      /* fall through to the real owner */
    }
    return originalAuthenticatedUrl.call(this, baseUrl)
  }

  ctx.effect(
    () => () => {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete auth[key]
        else Object.defineProperty(auth, key, descriptor)
      }
    },
    'remote-auth: restore browser authentication',
  )
}
