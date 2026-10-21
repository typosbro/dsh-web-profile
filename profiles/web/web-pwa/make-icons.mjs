#!/usr/bin/env node
/**
 * make-icons.mjs — regenerate the PWA icon PNGs from the app's own brand mark.
 *
 * Sources the whale path straight out of the served `favicon.svg`, so the
 * installed app icon cannot drift from the product mark. Rasterizes with
 * headless Chrome (already present for the harness's own screenshot tooling)
 * rather than pulling in an SVG rasterizer dependency.
 *
 * Usage: node make-icons.mjs [backgroundHex]
 * Default background is DeepSeek brand 500 (#4176e6); the mark is drawn white.
 *
 * Outputs, next to this file:
 *   icon-192.png            purpose "any"  (also the apple-touch-icon)
 *   icon-512.png            purpose "any"
 *   icon-maskable-512.png   purpose "maskable" (art kept inside the safe zone)
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAVICON =
  process.env.HOME +
  '/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg'
const CHROME =
  process.env.HOME +
  '/.cache/puppeteer/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell'

const background = process.argv[2] ?? '#4176e6'

if (!existsSync(FAVICON)) throw new Error(`cannot find the brand mark at ${FAVICON}`)
if (!existsSync(CHROME)) throw new Error(`cannot find chrome at ${CHROME}`)

/** The whale path, inlined and forced white. */
function markSvg(size) {
  const raw = readFileSync(FAVICON, 'utf8')
  // Drop the SVG's own dark-mode <style> and pin the fill, so the mark is white
  // on the brand background regardless of the renderer's color scheme.
  const body = raw
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/fill="#000"/, 'fill="#ffffff"')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50" fill="none">${body}</svg>`
}

/** Icon spec: output file, canvas edge, art edge. */
const ICONS = [
  ['icon-192.png', 192, Math.round(192 * 0.58)],
  ['icon-512.png', 512, Math.round(512 * 0.58)],
  // Maskable art must survive a circular crop, so keep it inside the safe zone.
  ['icon-maskable-512.png', 512, Math.round(512 * 0.5)],
]

const port = 9222 + Math.floor(Math.random() * 500)
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-icons-'))
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)

async function wsUrl() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error('chrome did not expose CDP')
}

class Cdp {
  #ws
  #id = 0
  #p = new Map()
  static async connect(u) {
    const c = new Cdp()
    c.#ws = new WebSocket(u)
    c.#ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id === undefined) return
      const en = c.#p.get(m.id)
      if (en === undefined) return
      c.#p.delete(m.id)
      m.error ? en.reject(new Error(m.error.message)) : en.resolve(m.result)
    })
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true })
    })
    return c
  }
  send(m, p = {}, s) {
    this.#id += 1
    const id = this.#id
    return new Promise((resolve, reject) => {
      this.#p.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }))
    })
  }
  close() {
    this.#ws.close()
  }
}

let cdp
try {
  cdp = await Cdp.connect(await wsUrl())
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (m, p) => cdp.send(m, p, sessionId)
  await call('Page.enable')

  for (const [file, canvas, art] of ICONS) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: canvas,
      height: canvas,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // data: URL keeps this hermetic: no temp HTML file, no server.
    const html =
      `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;width:${canvas}px;height:${canvas}px;` +
      `background:${background};overflow:hidden}` +
      `body{display:flex;align-items:center;justify-content:center}` +
      `svg{display:block}</style>` +
      markSvg(art)
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    await call('Page.navigate', { url })
    await sleep(350)
    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: canvas, height: canvas, scale: 1 },
      captureBeyondViewport: false,
    })
    const bytes = Buffer.from(shot.data, 'base64')
    writeFileSync(join(HERE, file), bytes)
    console.log(`${file}  ${canvas}x${canvas}  art ${art}px  ${bytes.length} bytes`)
  }
} finally {
  cdp?.close()
  chrome.kill('SIGKILL')
  rmSync(profileDir, { recursive: true, force: true })
}
