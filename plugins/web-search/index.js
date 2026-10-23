/**
 * Keyless local web-search provider for the dsh `web` service.
 *
 * Runs entirely on this machine: one outbound HTTPS request to DuckDuckGo's
 * server-rendered HTML endpoint per search. No API key, no account, no credits.
 */

const ENDPOINT = 'https://html.duckduckgo.com/html/'
const PROVIDER_ID = 'local-duckduckgo'
const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS_CAP = 20

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function fromCodePoint(value) {
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()]
      return decoded === undefined ? whole : decoded
    })
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<encoded target>. */
function unwrapRedirect(href) {
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href, ENDPOINT)
    const target = url.searchParams.get('uddg')
    return target || url.toString()
  } catch {
    return href
  }
}

/** Collect anchors carrying a given class marker, preserving document order. */
function collectAnchors(html, classMarker) {
  const marker = new RegExp(`\\b${classMarker}\\b`)
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  const found = []
  let match
  while ((match = anchor.exec(html)) !== null) {
    const attrs = match[1]
    if (!marker.test(attrs)) continue
    const href = /\bhref="([^"]*)"/i.exec(attrs)
    found.push({ href: href ? href[1] : undefined, inner: match[2] })
  }
  return found
}

function parseSearchPage(html, limit) {
  const links = collectAnchors(html, 'result__a')
  const snippets = collectAnchors(html, 'result__snippet')
  const sources = []
  const seen = new Set()

  for (let index = 0; index < links.length && sources.length < limit; index += 1) {
    const raw = links[index].href
    if (!raw) continue
    const url = unwrapRedirect(raw)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const snippet = snippets[index] ? cleanText(snippets[index].inner) : ''
    sources.push({
      url,
      title: cleanText(links[index].inner) || url,
      ...(snippet ? { snippet } : {}),
    })
  }

  return { sources, matched: links.length }
}

async function loadSearchPage(query, signal) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
      accept: 'text/html;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,ko;q=0.8',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  })

  if (!response.ok) {
    throw new Error(`local search backend returned HTTP ${response.status}`)
  }

  return response.text()
}

function renderContent(query, sources) {
  const lines = sources.map(
    (source, index) =>
      `${index + 1}. ${source.title}\n   ${source.url}${source.snippet ? `\n   ${source.snippet}` : ''}`,
  )
  return `Local search results for "${query}":\n\n${lines.join('\n\n')}`
}

async function runSearch(query, maxResults, signal) {
  const limit =
    Number.isInteger(maxResults) && maxResults > 0
      ? Math.min(maxResults, MAX_RESULTS_CAP)
      : DEFAULT_MAX_RESULTS

  const html = await loadSearchPage(query, signal)
  const { sources, matched } = parseSearchPage(html, limit)

  if (sources.length === 0) {
    return {
      content: `No results returned for "${query}". The local search backend may be rate-limiting; retry or rephrase.`,
      sources: [],
      truncated: false,
    }
  }

  return {
    content: renderContent(query, sources),
    sources,
    truncated: matched > sources.length,
  }
}

export const name = 'web-search-local'
export const inject = ['web']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.web.registerSearchProvider({
      id: PROVIDER_ID,
      available: () => true,
      search: (request, signal) => runSearch(request.query, request.maxResults, signal),
    }),
  )
}
