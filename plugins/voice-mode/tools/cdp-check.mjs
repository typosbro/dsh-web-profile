#!/usr/bin/env node
/**
 * tools/cdp-check.mjs — headless-Chrome + CDP smoke test for the live DSH Web GUI.
 *
 * Accept gate for installing a client plugin (e.g. @local/voice-mode) into the
 * running `dsh web` profile: a client plugin that throws during browser boot can
 * take the whole UI down, so this proves the page still boots, the session
 * composer mounted, and (post-install) the plugin's marker + dock DOM are present
 * with no new uncaught page errors.
 *
 * Zero npm dependencies: Node >= 22 global `fetch` + global `WebSocket`.
 *
 * Usage:
 *   node tools/cdp-check.mjs                          # baseline smoke run
 *   node tools/cdp-check.mjs --expect-voice           # post-install accept gate
 *   node tools/cdp-check.mjs --expect-voice \
 *        --baseline /tmp/voice-mode-baseline.json     # fail on NEW errors only
 *
 * Output: exactly one JSON report on stdout (progress goes to stderr with --debug).
 * Exit: 0 = pass, 1 = fail (uncaught page error, blank page, or a failed
 *       --expect-voice / --strict check).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_URL = 'http://127.0.0.1:3080/';
const DEFAULT_SCREENSHOT = '/tmp/voice-mode-check.png';
const PLUGIN_ID = '@local/voice-mode';
const MARKER = '__DSH_VOICE_MODE__';
const DOCK_ATTR = 'data-dsh-voice-mode';

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function usage() {
  return `Usage: node tools/cdp-check.mjs [options]

Options:
  --url <url>            DSH Web GUI URL (default: ${DEFAULT_URL})
  --settle <ms>          settle wait after page load (default: 8000)
  --screenshot <path>    PNG output path (default: ${DEFAULT_SCREENSHOT})
  --json-out <path>      also write the JSON report to this path
  --baseline <path>      subtract error signatures from a previous JSON report
  --expect-voice         accept-gate mode: require ${MARKER} and [${DOCK_ATTR}] and composer
  --strict               fail on any non-noise console/log error as well
  --engine-probe         after the mount check, run the local-voice engine +
                         capture probe: GET /voice-mode/status, POST
                         /voice-mode/speak + Web Audio decode, suppressPrompts,
                         one mic click, read 0.2.0 diagnostics, click stop
  --engine-json-out <p>  write the engine-probe subtree to this JSON path
  --voice-loop-probe     after the mount check, click the composer mic once via
                         CDP, wait 5 s, read __DSH_VOICE_MODE__ diagnostics and
                         the dock state, screenshot, click again to stop, verify
                         mode returns to "off" (never types or sends anything)
  --port <n>             fixed remote-debugging port (default: ephemeral)
  --keep-chrome          do not kill Chrome on exit (debugging only)
  --debug                progress logs on stderr
  --help                 show this help`;
}

function parseArgs(argv) {
  const opts = {
    url: DEFAULT_URL,
    settleMs: 8000,
    screenshot: DEFAULT_SCREENSHOT,
    jsonOut: null,
    baselinePath: null,
    expectVoice: false,
    strict: false,
    voiceLoopProbe: false,
    engineProbe: false,
    engineJsonOut: null,
    port: 0,
    keepChrome: false,
    debug: false,
    help: false,
  };
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': opts.url = take(i, a); i++; break;
      case '--settle': opts.settleMs = Number(take(i, a)); i++; break;
      case '--screenshot': opts.screenshot = take(i, a); i++; break;
      case '--json-out': opts.jsonOut = take(i, a); i++; break;
      case '--baseline': opts.baselinePath = take(i, a); i++; break;
      case '--port': opts.port = Number(take(i, a)); i++; break;
      case '--expect-voice': opts.expectVoice = true; break;
      case '--strict': opts.strict = true; break;
      case '--voice-loop-probe': opts.voiceLoopProbe = true; break;
      case '--engine-probe': opts.engineProbe = true; break;
      case '--engine-json-out': opts.engineJsonOut = take(i, a); i++; break;
      case '--keep-chrome': opts.keepChrome = true; break;
      case '--debug': opts.debug = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(opts.settleMs) || opts.settleMs < 0) throw new Error('--settle must be >= 0');
  if (!Number.isFinite(opts.port) || opts.port < 0) throw new Error('--port must be >= 0');
  if (!/^https?:$/.test(new URL(opts.url).protocol)) throw new Error('--url must be http(s)');
  return opts;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function fetchJson(url, options = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

/* ------------------------------------------------------------------ */
/* CDP client over Node's built-in WebSocket                           */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(wsUrl, { debug = false, label = 'cdp' } = {}) {
    this.wsUrl = wsUrl;
    this.debug = debug;
    this.label = label;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.closeInfo = null;
  }

  log(...args) {
    if (this.debug) process.stderr.write(`[${this.label}] ${args.join(' ')}\n`);
  }

  async connect(timeoutMs = 15000) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener(
          'error',
          () => reject(new Error(`CDP websocket error connecting to ${this.wsUrl}`)),
          { once: true },
        );
      }),
      timeoutMs,
      'CDP websocket open',
    );
    this.log('connected');
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', (ev) => {
      this.closed = true;
      this.closeInfo = { code: ev.code, reason: ev.reason };
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP websocket closed'));
      }
      this.pending.clear();
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message} (code ${msg.error.code})`));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (const fn of this.handlers.get(msg.method) ?? []) {
      try {
        fn(msg.params ?? {});
      } catch {
        /* a listener must never break the client */
      }
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error(`CDP websocket closed (${method})`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
    return () => {
      const cur = this.handlers.get(method) ?? [];
      this.handlers.set(method, cur.filter((f) => f !== fn));
    };
  }

  waitFor(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout after ${timeoutMs}ms waiting for CDP event ${method}`));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chrome lifecycle                                                    */
/* ------------------------------------------------------------------ */

function launchChrome({ port, userDataDir, debug }) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  const child = spawn(CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = { stdout: '', stderr: '' };
  const keep = (which, chunk) => {
    logs[which] = (logs[which] + chunk.toString()).slice(-8000);
    if (debug) process.stderr.write(`[chrome:${which}] ${chunk}`);
  };
  child.stdout.on('data', (c) => keep('stdout', c));
  child.stderr.on('data', (c) => keep('stderr', c));
  child.on('error', (err) => {
    logs.stderr += `\nspawn error: ${err.message}`;
  });
  return { child, logs, args };
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await fetchJson(`${base}/json/version`, {}, 2000);
      return { base, version };
    } catch (err) {
      lastErr = err;
      await sleep(200);
    }
  }
  throw new Error(
    `Chrome DevTools endpoint did not come up on port ${port} within ${timeoutMs}ms` +
      (lastErr ? `: ${lastErr.message}` : ''),
  );
}

async function createPageTarget(base) {
  const url = `${base}/json/new?url=${encodeURIComponent('about:blank')}`;
  try {
    return await fetchJson(url, { method: 'PUT' }, 5000);
  } catch (err) {
    // Older/browser targets accept GET; keep the fallback belt-and-braces.
    if (err.status === 405 || err.status === 404) {
      return await fetchJson(url, { method: 'GET' }, 5000);
    }
    throw err;
  }
}

async function cleanupChrome({ child, userDataDir, keepChrome, debug }) {
  if (!child) {
    if (userDataDir) safeRmDir(userDataDir, debug);
    return;
  }
  if (keepChrome) {
    debug && process.stderr.write(`[chrome] --keep-chrome: leaving pid ${child.pid} alive\n`);
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const exited = await waitForExit(child, 4000);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await waitForExit(child, 2000);
  }
  // Give Chrome helpers a moment to release the profile dir, then remove it.
  await sleep(150);
  safeRmDir(userDataDir, debug);
}

function safeRmDir(dir, debug) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    debug && process.stderr.write(`[cleanup] could not remove ${dir}: ${err.message}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* Page probe (evaluated inside the page)                              */
/* ------------------------------------------------------------------ */

const PROBE_EXPR = `(() => {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const visible = (el) => { try { return !!(el && el.getClientRects && el.getClientRects().length > 0); } catch { return false; } };
  const marker = window.${MARKER};
  const markerDefined = typeof marker !== 'undefined';
  let markerInfo = null;
  if (markerDefined) {
    if (marker && typeof marker === 'object') {
      markerInfo = safe(() => ({
        keys: Object.keys(marker).slice(0, 25),
        ctor: marker.constructor ? marker.constructor.name : null,
        version: safe(() => String(marker.version ?? ''), ''),
      }), null);
    } else {
      markerInfo = { value: safe(() => String(marker), '') };
    }
  }
  const dockEls = safe(() => Array.from(document.querySelectorAll('[${DOCK_ATTR}]')), []);
  const composerRoot = document.querySelector('[data-conversation-region="composer"]');
  const composerCard = document.querySelector('[data-composer-card]');
  const composerInput = document.querySelector('[data-composer-input]');
  const anyTextbox = document.querySelector('textarea, [contenteditable="true"][role="textbox"]');
  const convContent = document.querySelector('[data-conversation-content]');
  const phaseEl = document.querySelector('[data-phase]');
  const bundleScript = document.querySelector('script[src*="plugins/"]');
  const scriptSrcs = safe(() => Array.from(document.querySelectorAll('script[src]')).map((s) => String(s.src)), []);
  const voiceScripts = scriptSrcs.filter((n) => /voice[-_]?mode/i.test(n));
  const voiceResources = safe(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /voice[-_]?mode/i.test(n)).slice(0, 10), []);
  const composerDock = document.querySelector('[data-composer-dock]');
  return {
    title: document.title,
    href: location.href,
    readyState: document.readyState,
    marker: { defined: markerDefined, type: typeof marker, info: markerInfo },
    voiceWindowKeys: safe(() => Object.keys(window).filter((k) => /voice/i.test(k)).slice(0, 20), []),
    dock: {
      count: dockEls.length,
      insideComposer: safe(() => (composerRoot ? composerRoot.querySelectorAll('[${DOCK_ATTR}]').length : 0), 0),
      sample: dockEls.slice(0, 5).map((el) => ({
        tag: el.tagName,
        visible: visible(el),
        text: safe(() => (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), ''),
        attrs: safe(() => Array.from(el.attributes).slice(0, 15).map((a) => a.name + '=' + String(a.value).slice(0, 60)), []),
      })),
    },
    composer: {
      mounted: !!(composerRoot && (composerInput || anyTextbox)),
      seat: !!composerRoot,
      card: !!composerCard,
      input: !!composerInput,
      textboxVisible: visible(composerInput || anyTextbox),
      phase: phaseEl ? phaseEl.getAttribute('data-phase') : null,
      contentPhase: convContent ? convContent.getAttribute('data-content-phase') : null,
      sessionId: convContent ? convContent.getAttribute('data-conversation-session') : null,
    },
    rootChildCount: safe(() => { const r = document.getElementById('root'); return r ? r.childElementCount : -1; }, -1),
    bodyTextLen: safe(() => (document.body && document.body.innerText ? document.body.innerText.length : 0), 0),
    bodyTextSample: safe(() => (document.body && document.body.innerText ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 240) : ''), ''),
    pluginBundle: {
      // The plugin client module is loaded through the served plugins bundle
      // (usually one script tag, with more plugin entries injected at runtime), so
      // look at every script src plus loaded resources rather than only the first.
      scriptSrcSample: bundleScript ? String(bundleScript.src).slice(0, 500) : null,
      voiceScripts: voiceScripts.slice(0, 5).map((n) => n.slice(0, 500)),
      voiceResources: voiceResources,
      scriptSrcHasVoice: voiceScripts.length > 0 || voiceResources.length > 0,
    },
    composerDock: {
      present: !!composerDock,
      childCount: composerDock ? composerDock.childElementCount : 0,
      textLen: composerDock ? (composerDock.innerText || '').length : 0,
    },
    diagnostic: {
      voiceish: safe(() => Array.from(document.querySelectorAll('[aria-label],[title],[class]'))
        .filter((e) => /voice[-_ ]?mode|speech/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + String(e.className || '')))
        .slice(0, 10)
        .map((e) => ({ tag: e.tagName, aria: e.getAttribute('aria-label'), title: e.getAttribute('title'), cls: String(e.className || '').slice(0, 80) })), []),
    },
    sessionRows: safe(() => document.querySelectorAll('[role="treeitem"][data-row-key^="session:"]').length, 0),
    selectedSessionRow: safe(() => {
      const el = document.querySelector('[role="treeitem"][aria-selected="true"]');
      return el ? el.getAttribute('data-row-key') : null;
    }, null),
  };
})()`;

async function evalJson(cdp, expression, timeoutMs = 20000) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    timeoutMs,
  );
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.exception?.value ??
      res.exceptionDetails.text ??
      'unknown evaluate error';
    throw new Error(`page evaluate failed: ${String(detail).slice(0, 500)}`);
  }
  return res.result?.value;
}

async function probePage(cdp) {
  return await evalJson(cdp, PROBE_EXPR);
}

/**
 * Probe the landing view, and when the landing view does not already prove the
 * plugin is present, also open an existing session from the sidebar (never the
 * "New Session" button, never a destructive control) and re-probe. This covers
 * a composer-slot plugin that mounts only inside an active conversation.
 *
 * A safe row is preferred: an already-rendered session row that is not currently
 * selected and whose label does not say "Running".
 */
async function probeViews(cdp, firstProbe, debug) {
  const skip = (reason) => ({ attempted: false, navigated: false, clickedRowKey: null, reason, probe: firstProbe });

  // A defined marker only proves the client factory evaluated. The dock mount can
  // be conditional on a real conversation, so require an actual dock node before
  // skipping the active-session probe.
  const alreadyProven = firstProbe.composer.mounted && firstProbe.dock.count > 0;
  if (alreadyProven) return skip('voice dock already visible on landing view');
  if (!firstProbe.composer.mounted && firstProbe.sessionRows === 0) return skip('no composer and no session rows');

  const row = await evalJson(
    cdp,
    `(() => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"][data-row-key^="session:"]'));
      const safe = rows.find((r) => r.getAttribute('aria-selected') !== 'true' && !/running/i.test(r.innerText || ''));
      const unselected = rows.find((r) => r.getAttribute('aria-selected') !== 'true');
      const el = safe || unselected || null;
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { key: el.getAttribute('data-row-key'), label: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`,
  );
  if (!row || (row.w === 0 && row.h === 0)) {
    return { attempted: true, navigated: false, clickedRowKey: null, reason: 'no safe session row found', probe: firstProbe };
  }
  debug && process.stderr.write(`[probe] selecting existing session row ${row.key} (${row.label})\n`);
  const click = { x: Math.round(row.x), y: Math.round(row.y), button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: click.x, y: click.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click });
  await sleep(3000);
  const after = await probePage(cdp);
  return {
    attempted: true,
    navigated: true,
    clickedRowKey: row.key,
    clickedRowLabel: row.label,
    reason: null,
    probe: after,
  };
}

/* ------------------------------------------------------------------ */
/* Functional voice-loop probe: click the mic, read diagnostics, stop   */
/* ------------------------------------------------------------------ */

const VOICE_STATE_EXPR = `(() => {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const m = window.${MARKER};
  let markerJson = null;
  try { markerJson = JSON.stringify(m); } catch (e) { markerJson = 'unserializable: ' + String(e); }
  const marker = m && typeof m === 'object' ? safe(() => ({
    mode: m.mode === undefined ? null : m.mode,
    recognition: m.recognition === undefined ? null : m.recognition,
    recognitionError: m.recognitionError === undefined ? null : m.recognitionError,
    follow: m.follow === undefined ? null : m.follow,
    followError: m.followError === undefined ? null : m.followError,
    frames: Array.isArray(m.frames) ? m.frames.length : (typeof m.frames === 'number' ? m.frames : null),
    prompt: m.prompt === undefined ? null : m.prompt,
    turns: m.turns === undefined ? null : m.turns,
    capture: m.capture === undefined ? null : m.capture,
    captureError: m.captureError === undefined ? null : m.captureError,
    engine: m.engine === undefined ? null : m.engine,
    ttsReady: m.ttsReady === undefined ? null : m.ttsReady,
    sttReady: m.sttReady === undefined ? null : m.sttReady,
    vad: m.vad === undefined ? null : m.vad,
    transcribe: m.transcribe === undefined ? null : m.transcribe,
    transcribeError: m.transcribeError === undefined ? null : m.transcribeError,
    suppressPrompts: m.suppressPrompts === undefined ? null : m.suppressPrompts,
    note: m.note === undefined ? null : m.note,
  }), null) : null;
  const nodes = safe(() => Array.from(document.querySelectorAll('[${DOCK_ATTR}]')).map((el) => ({
    value: el.getAttribute('${DOCK_ATTR}'),
    tag: el.tagName,
    state: el.getAttribute('data-state'),
    pressed: el.getAttribute('aria-pressed'),
    aria: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    visible: !!(el.getClientRects && el.getClientRects().length),
  })), []);
  const control = document.querySelector('[${DOCK_ATTR}="control"]');
  const dock = document.querySelector('[data-composer-dock]');
  const composerInput = document.querySelector('[data-composer-input]');
  const conv = document.querySelector('[data-conversation-scroll]') || document.querySelector('[data-conversation-content]');
  const userCounts = {};
  for (const sel of ['[data-message-role="user"]', '[data-role="user"]', '[data-message-author="user"]', '[data-message-id]']) {
    userCounts[sel] = document.querySelectorAll(sel).length;
  }
  return {
    href: location.href,
    title: document.title,
    markerJson: markerJson && markerJson.length > 30000 ? markerJson.slice(0, 30000) + '...(truncated)' : markerJson,
    marker,
    controlState: control ? control.getAttribute('data-state') : null,
    controlText: control ? (control.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    controlHTML: control ? control.outerHTML.slice(0, 1500) : null,
    dockText: dock ? (dock.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600) : null,
    nodes,
    composerInputText: composerInput ? (composerInput.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    conversationTextLen: conv ? (conv.innerText || '').length : null,
    userCounts,
  };
})()`;

const CLICK_MIC_EXPR = `(() => {
  const btn = document.querySelector('[${DOCK_ATTR}="button"]');
  if (!btn) return { clicked: false, reason: 'button not found' };
  const r = btn.getBoundingClientRect();
  const control = btn.closest('[${DOCK_ATTR}="control"]');
  const before = {
    controlState: control ? control.getAttribute('data-state') : null,
    pressed: btn.getAttribute('aria-pressed'),
    aria: btn.getAttribute('aria-label'),
    visible: !!(r.width && r.height),
  };
  btn.click();
  return { clicked: true, before };
})()`;

function summarizeVoiceMarkers(probe) {
  if (!probe) return null;
  return {
    mode: probe.marker?.mode ?? null,
    recognition: probe.marker?.recognition ?? null,
    recognitionError: probe.marker?.recognitionError ?? null,
    follow: probe.marker?.follow ?? null,
    followError: probe.marker?.followError ?? null,
    frames: probe.marker?.frames ?? null,
    prompt: probe.marker?.prompt ?? null,
    controlState: probe.controlState ?? null,
    controlText: probe.controlText ?? null,
    dockText: probe.dockText ?? null,
  };
}

/**
 * Click the plugin's mic button once in the composer dock, let the loop reach its
 * remote transport, read the plugin's own runtime diagnostics, screenshot the ON
 * state, then click the same button again to stop.
 *
 * Safety: never types, never presses Enter, never sends. If the diagnostics show
 * prompt === "accepted" or a conversation/user-message count changes, it flags a
 * safety stop, reports exactly what changed, and stops the loop immediately.
 */
async function runVoiceLoopProbe(cdp, collector, opts, debug) {
  const result = {
    enabled: true,
    blocker: null,
    safetyStop: false,
    safetyStopDetail: null,
    button: null,
    before: null,
    clicked: null,
    afterClick: null,
    clickedStop: null,
    stopped: null,
    newErrors: { uncaught: [], console: [], log: [] },
    screenshot: null,
  };
  const errSnapshot = () => ({
    uncaught: collector.uncaught.length,
    console: collector.console.length,
    log: collector.log.length,
  });
  const errorsBefore = errSnapshot();

  result.before = await evalJson(cdp, VOICE_STATE_EXPR);
  const button = await evalJson(
    cdp,
    `(() => {
      const btn = document.querySelector('[${DOCK_ATTR}="button"]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const control = btn.closest('[${DOCK_ATTR}="control"]');
      return {
        aria: btn.getAttribute('aria-label'),
        title: btn.getAttribute('title'),
        pressed: btn.getAttribute('aria-pressed'),
        controlState: control ? control.getAttribute('data-state') : null,
        visible: !!(r.width && r.height),
        text: (btn.innerText || '').trim().slice(0, 120),
      };
    })()`,
  );
  result.button = button;
  if (!button) {
    result.blocker = 'mic button [data-dsh-voice-mode="button"] not found in the composer dock';
    return result;
  }

  debug && process.stderr.write(`[voice-loop] clicking mic ON (visible=${button.visible})\n`);
  result.clicked = await evalJson(cdp, CLICK_MIC_EXPR);
  if (!result.clicked?.clicked) {
    result.blocker = `click dispatched but failed: ${result.clicked?.reason ?? 'unknown'}`;
    return result;
  }

  await sleep(5000);
  result.afterClick = await evalJson(cdp, VOICE_STATE_EXPR);

  // Safety gate: fake audio must not produce a transcript that gets auto-accepted.
  const promptAccepted = (result.afterClick?.marker?.prompt ?? null) === 'accepted';
  const beforeCounts = result.before?.userCounts ?? {};
  const afterCounts = result.afterClick?.userCounts ?? {};
  const userCountIncreased = Object.keys(beforeCounts).some((k) => (afterCounts[k] ?? 0) > (beforeCounts[k] ?? 0));
  const composerChanged = (result.before?.composerInputText ?? '') !== (result.afterClick?.composerInputText ?? '');
  result.safetyStop = promptAccepted || userCountIncreased || composerChanged;
  if (result.safetyStop) {
    result.safetyStopDetail = {
      promptAccepted,
      userCountIncreased,
      composerChanged,
      prompt: result.afterClick?.marker?.prompt ?? null,
      userCountsBefore: beforeCounts,
      userCountsAfter: afterCounts,
      composerInputBefore: result.before?.composerInputText ?? null,
      composerInputAfter: result.afterClick?.composerInputText ?? null,
    };
    debug && process.stderr.write(`[voice-loop] SAFETY STOP: ${JSON.stringify(result.safetyStopDetail)}\n`);
  }

  // Screenshot while the loop is (expected to be) on.
  try {
    if (opts.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
      writeFileSync(opts.screenshot, Buffer.from(shot.data, 'base64'));
      result.screenshot = { path: opts.screenshot, bytes: statSync(opts.screenshot).size };
    }
  } catch (err) {
    result.screenshotError = err.message;
  }

  // Stop: click the same button again (also after a safety stop, to end the loop).
  debug && process.stderr.write('[voice-loop] clicking mic OFF\n');
  result.clickedStop = await evalJson(cdp, CLICK_MIC_EXPR);
  await sleep(1000);
  result.stopped = await evalJson(cdp, VOICE_STATE_EXPR);

  const errorsAfter = errSnapshot();
  const sliceNew = (kind) => collector[kind].slice(errorsBefore[kind]).map((e) => String(e.description ?? e.text ?? '').slice(0, 500));
  result.newErrors = {
    uncaught: sliceNew('uncaught'),
    console: sliceNew('console'),
    log: sliceNew('log'),
  };
  result.summary = {
    on: summarizeVoiceMarkers(result.afterClick),
    off: summarizeVoiceMarkers(result.stopped),
  };
  if (!result.clickedStop?.clicked) {
    result.blocker = `stop click failed: ${result.clickedStop?.reason ?? 'unknown'}`;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Local-voice engine + capture probe (v0.2.0: host-local STT/TTS)      */
/* ------------------------------------------------------------------ */

const ENGINE_STATUS_EXPR = `(async () => {
  try {
    const r = await fetch('/voice-mode/status', { cache: 'no-store' });
    const body = await r.json().catch(() => null);
    return { httpStatus: r.status, ok: r.ok, body };
  } catch (e) {
    return { httpStatus: null, ok: false, error: String((e && e.message) || e) };
  }
})()`;

const ENGINE_SPEAK_EXPR = `(async () => {
  const out = { httpStatus: null, ok: false, bytes: 0, decoded: null, decodeError: null };
  try {
    const r = await fetch('/voice-mode/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Local speech probe.' }),
    });
    out.httpStatus = r.status;
    out.ok = r.ok;
    out.contentType = r.headers.get('content-type');
    const b = await r.arrayBuffer();
    out.bytes = b.byteLength;
    const ac = new AudioContext();
    try {
      const buf = await ac.decodeAudioData(b);
      out.decoded = { seconds: Math.round(buf.duration * 1000) / 1000, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, frames: buf.length };
    } catch (e) {
      out.decodeError = String((e && e.message) || e);
    }
    try { await ac.close(); } catch (e) { /* already closed */ }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
})()`;

const SUPPRESS_PROMPTS_EXPR = `(() => {
  const m = window.${MARKER};
  if (!m || typeof m !== 'object') return { set: false, reason: 'marker missing' };
  try {
    m.suppressPrompts = true;
    return { set: true, suppressPrompts: m.suppressPrompts };
  } catch (e) {
    return { set: false, error: String((e && e.message) || e) };
  }
})()`;

/**
 * Local-voice gate for plugin v0.2.0: prove the host-local engine routes are
 * reachable from the page, the browser can decode host-synthesized WAVs, and the
 * mic toggle drives capture/VAD while prompt submission is hard-suppressed (so
 * fake headless audio can never pollute the session). Clicks the mic once, waits
 * 4 s, reads diagnostics, screenshots, clicks again, then verifies clean stop.
 */
async function runLocalEngineProbe(cdp, collector, opts, debug) {
  const result = {
    enabled: true,
    blocker: null,
    safetyStop: false,
    safetyStopDetail: null,
    status: null,
    speak: null,
    suppress: null,
    before: null,
    button: null,
    clicked: null,
    afterClick: null,
    clickedStop: null,
    stopped: null,
    conversation: null,
    newErrors: { uncaught: [], console: [], log: [] },
    screenshot: null,
  };
  const errSnapshot = () => ({
    uncaught: collector.uncaught.length,
    console: collector.console.length,
    log: collector.log.length,
  });
  const errorsBefore = errSnapshot();

  debug && process.stderr.write('[engine-probe] GET /voice-mode/status\n');
  result.status = await evalJson(cdp, ENGINE_STATUS_EXPR, 20000);

  debug && process.stderr.write('[engine-probe] POST /voice-mode/speak + Web Audio decode\n');
  result.speak = await evalJson(cdp, ENGINE_SPEAK_EXPR, 30000);

  result.before = await evalJson(cdp, VOICE_STATE_EXPR);
  const button = await evalJson(
    cdp,
    `(() => {
      const btn = document.querySelector('[${DOCK_ATTR}="button"]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const control = btn.closest('[${DOCK_ATTR}="control"]');
      return {
        aria: btn.getAttribute('aria-label'),
        title: btn.getAttribute('title'),
        pressed: btn.getAttribute('aria-pressed'),
        controlState: control ? control.getAttribute('data-state') : null,
        visible: !!(r.width && r.height),
      };
    })()`,
  );
  result.button = button;
  if (!button) {
    result.blocker = 'mic button [data-dsh-voice-mode="button"] not found in the composer dock';
    return result;
  }

  debug && process.stderr.write('[engine-probe] setting suppressPrompts safety hook\n');
  result.suppress = await evalJson(cdp, SUPPRESS_PROMPTS_EXPR);

  debug && process.stderr.write('[engine-probe] clicking mic ON\n');
  result.clicked = await evalJson(cdp, CLICK_MIC_EXPR);
  if (!result.clicked?.clicked) {
    result.blocker = `click dispatched but failed: ${result.clicked?.reason ?? 'unknown'}`;
    return result;
  }

  await sleep(4000);
  result.afterClick = await evalJson(cdp, VOICE_STATE_EXPR);

  // Safety gate: suppressPrompts must prevent any transcript from being sent.
  const prompt = result.afterClick?.marker?.prompt ?? null;
  const promptAccepted = prompt === 'accepted';
  const beforeCounts = result.before?.userCounts ?? {};
  const afterCounts = result.afterClick?.userCounts ?? {};
  const userCountIncreased = Object.keys(beforeCounts).some((k) => (afterCounts[k] ?? 0) > (beforeCounts[k] ?? 0));
  const composerChanged = (result.before?.composerInputText ?? '') !== (result.afterClick?.composerInputText ?? '');
  result.safetyStop = promptAccepted || userCountIncreased || composerChanged;
  if (result.safetyStop) {
    result.safetyStopDetail = {
      promptAccepted,
      userCountIncreased,
      composerChanged,
      prompt,
      userCountsBefore: beforeCounts,
      userCountsAfter: afterCounts,
      composerInputBefore: result.before?.composerInputText ?? null,
      composerInputAfter: result.afterClick?.composerInputText ?? null,
    };
    debug && process.stderr.write(`[engine-probe] SAFETY STOP: ${JSON.stringify(result.safetyStopDetail)}\n`);
  }

  // ON-state screenshot.
  try {
    if (opts.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
      writeFileSync(opts.screenshot, Buffer.from(shot.data, 'base64'));
      result.screenshot = { path: opts.screenshot, bytes: statSync(opts.screenshot).size };
    }
  } catch (err) {
    result.screenshotError = err.message;
  }

  debug && process.stderr.write('[engine-probe] clicking mic OFF\n');
  result.clickedStop = await evalJson(cdp, CLICK_MIC_EXPR);
  await sleep(1000);
  result.stopped = await evalJson(cdp, VOICE_STATE_EXPR);

  result.conversation = {
    changed: !!(userCountIncreased || composerChanged),
    userCountsBefore: beforeCounts,
    userCountsAfter: result.stopped?.userCounts ?? afterCounts,
    composerInputBefore: result.before?.composerInputText ?? null,
    composerInputAfter: result.stopped?.composerInputText ?? null,
    conversationTextLenBefore: result.before?.conversationTextLen ?? null,
    conversationTextLenAfter: result.stopped?.conversationTextLen ?? null,
  };

  const errorsAfter = errSnapshot();
  const sliceNew = (kind) => collector[kind].slice(errorsBefore[kind]).map((e) => String(e.description ?? e.text ?? '').slice(0, 500));
  result.newErrors = {
    uncaught: sliceNew('uncaught'),
    console: sliceNew('console'),
    log: sliceNew('log'),
  };

  // Blockers: host engine unreachable / speak not playable / click failed.
  if (result.status?.body?.ok !== true) {
    result.blocker = `GET /voice-mode/status not ok (http=${result.status?.httpStatus ?? 'n/a'}, error=${result.status?.body?.error ?? result.status?.error ?? 'unknown'})`;
  } else if (!(result.speak?.ok && result.speak?.decoded)) {
    result.blocker = `POST /voice-mode/speak not playable (http=${result.speak?.httpStatus ?? 'n/a'}, bytes=${result.speak?.bytes ?? 0}, decodeError=${result.speak?.decodeError ?? result.speak?.error ?? 'n/a'})`;
  } else if (!result.clickedStop?.clicked) {
    result.blocker = `stop click failed: ${result.clickedStop?.reason ?? 'unknown'}`;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Error collection + noise classification                             */
/* ------------------------------------------------------------------ */

function createCollector() {
  return { uncaught: [], console: [], log: [] };
}

function attachCollectors(cdp, collector) {
  cdp.on('Runtime.exceptionThrown', (params) => {
    const d = params.exceptionDetails ?? {};
    const ex = d.exception ?? {};
    collector.uncaught.push({
      text: d.text ?? '',
      description: ex.description ?? (ex.value !== undefined ? String(ex.value) : ''),
      url: d.url ?? ex.className ?? '',
      line: d.lineNumber ?? null,
      column: d.columnNumber ?? null,
      stack: (d.stackTrace?.callFrames ?? []).slice(0, 5).map((f) => ({
        fn: f.functionName,
        url: f.url,
        line: f.lineNumber,
      })),
    });
  });

  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'assert') return;
    const parts = (params.args ?? []).map((a) => {
      if (a.type === 'string') return a.value;
      if (a.type === 'number' || a.type === 'boolean' || a.type === 'bigint') return String(a.value);
      if (a.type === 'undefined') return 'undefined';
      if (a.value !== undefined && a.value !== null && typeof a.value !== 'object') return String(a.value);
      if (a.preview) {
        const props = (a.preview.properties ?? [])
          .map((p) => `${p.name}: ${p.value ?? p.type}`)
          .join(', ');
        return `${a.preview.description}${props ? ` {${props}}` : ''}`;
      }
      return a.description ?? a.className ?? a.type;
    });
    const frame = params.stackTrace?.callFrames?.[0];
    collector.console.push({
      type: params.type,
      text: parts.join(' ').slice(0, 2000),
      url: frame?.url ?? '',
      line: frame?.lineNumber ?? null,
    });
  });

  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry ?? {};
    if (entry.level !== 'error') return;
    collector.log.push({
      source: entry.source ?? '',
      text: entry.text ?? '',
      url: entry.url ?? '',
      line: entry.lineNumber ?? null,
    });
  });
}

const NOISE_RULES = [
  {
    kind: 'favicon-404',
    test: (e) => /favicon/i.test(`${e.text ?? ''} ${e.url ?? ''}`),
  },
  {
    kind: 'baseline-account-console-error',
    // Present on the live app before any plugin is installed; baseline-observed 2026-11-03.
    test: (e) => /\[deepseek-account\] account read failed/.test(e.text ?? ''),
  },
  {
    kind: 'websocket-reconnect-chatter',
    test: (e) =>
      /websocket[^]{0,120}?(failed|error|closed|reconnect|refused)/i.test(e.text ?? '') ||
      /websocket connection[^]{0,60}?(failed|closed)/i.test(e.text ?? ''),
  },
  {
    kind: 'hmr-chatter',
    test: (e) => /\[(?:vite|hmr)\]|hot update|hmr (?:update|reload)|hot-reload/i.test(e.text ?? ''),
  },
];

// Bundle URLs carry a volatile build hash (`&rev=...`); a plugin install rebuilds
// the bundle, so strip it from signatures/URLs to keep baseline comparison stable.
function normalizeUrl(url) {
  if (!url) return '';
  return String(url).replace(/([?&])rev=[^&]*/g, '$1rev=*');
}

function truncate(value, max) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max)}…(${str.length} chars)` : str;
}

function signature(kind, e) {
  const url = normalizeUrl(e.url);
  if (kind === 'uncaught') return `uncaught|${e.description ?? e.text}|${url}`;
  if (kind === 'console') return `console|${e.text}|${url}`;
  return `log|${e.text}|${url}`;
}

function classify(entries, kind) {
  const errors = [];
  const warnings = [];
  const seen = new Map();
  for (const e of entries) {
    const noise = NOISE_RULES.find((r) => r.test(e));
    const sig = signature(kind, e);
    if (noise) {
      const prev = seen.get(sig);
      if (prev) prev.count += 1;
      else {
        const item = { kind: noise.kind, category: kind, sig, text: truncate(e.text ?? e.description ?? '', 400), url: truncate(normalizeUrl(e.url), 300), count: 1 };
        seen.set(sig, item);
        warnings.push(item);
      }
    } else {
      errors.push({ ...e, sig, url: truncate(normalizeUrl(e.url), 300) });
    }
  }
  const dedupe = (list) => {
    const map = new Map();
    for (const e of list) {
      const prev = map.get(e.sig);
      if (prev) prev.count = (prev.count ?? 1) + 1;
      else map.set(e.sig, { ...e, count: 1 });
    }
    return [...map.values()];
  };
  return { errors: dedupe(errors), warnings };
}

function finalize(report, opts, exitCode) {
  const writeJson = (path, value, kind) => {
    try {
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
    } catch (err) {
      report.warnings.push({ kind, category: 'harness', text: err.message, url: '', count: 1 });
    }
  };
  if (opts?.jsonOut) writeJson(opts.jsonOut, report, 'json-out-failed');
  if (opts?.engineJsonOut && report.engineProbe) {
    writeJson(opts.engineJsonOut, report.engineProbe, 'engine-json-out-failed');
  }
  return { report, exitCode };
}

function loadBaselineSignatures(path) {
  if (!path) return { signatures: new Set(), report: null, error: null };
  try {
    if (!existsSync(path)) return { signatures: new Set(), report: null, error: `baseline not found: ${path}` };
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const signatures = new Set();
    for (const kind of ['uncaught', 'console', 'log']) {
      for (const e of report?.errors?.[kind] ?? []) {
        if (e?.sig) signatures.add(e.sig);
      }
    }
    return { signatures, report, error: null };
  } catch (err) {
    return { signatures: new Set(), report: null, error: `baseline unreadable: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = nowMs();
  const report = {
    tool: 'tools/cdp-check.mjs',
    ok: false,
    mode: 'baseline',
    checkedAt: new Date().toISOString(),
    url: null,
    node: process.version,
    chrome: null,
    timing: {},
    cdp: {},
    page: null,
    probes: { initial: null, final: null, sessionNavigation: null },
    checks: {},
    errors: { uncaught: [], console: [], log: [] },
    warnings: [],
    baseline: null,
    screenshot: null,
    failures: [],
  };
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    report.failures.push(`argument error: ${err.message}`);
    report.error = String(err.message);
    return { report, exitCode: 2 };
  }
  if (opts.help) {
    process.stderr.write(usage() + '\n');
    return { report: null, exitCode: 0 };
  }
  report.mode = opts.expectVoice ? 'expect-voice' : 'baseline';
  report.url = opts.url;
  report.timing.settleMs = opts.settleMs;

  let chrome = null;
  let cdp = null;
  let userDataDir = null;
  try {
    if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found at ${CHROME_PATH} (set CHROME_PATH)`);
    userDataDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-check-'));
    opts.debug && process.stderr.write(`[setup] chrome profile: ${userDataDir}\n`);

    const port = opts.port || (await findFreePort());
    let launched = null;
    let devtools = null;
    let lastLaunchErr = null;
    for (let attempt = 1; attempt <= 3 && !devtools; attempt++) {
      if (launched) await cleanupChrome({ child: launched.child, userDataDir: null, keepChrome: false, debug: opts.debug });
      launched = launchChrome({ port, userDataDir, debug: opts.debug });
      try {
        devtools = await waitForDevtools(port, 20000);
      } catch (err) {
        lastLaunchErr = err;
        opts.debug && process.stderr.write(`[setup] devtools attempt ${attempt} failed: ${err.message}\n`);
      }
    }
    chrome = launched;
    if (!devtools) throw lastLaunchErr ?? new Error('could not start Chrome DevTools endpoint');
    report.chrome = { path: CHROME_PATH, browser: devtools.version.Browser ?? null, protocol: devtools.version['Protocol-Version'] ?? null, port };
    report.cdp.httpEndpoint = devtools.base;
    opts.debug && process.stderr.write(`[setup] ${devtools.version.Browser} on port ${port}\n`);

    const target = await createPageTarget(devtools.base);
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome /json/new returned no webSocketDebuggerUrl');
    report.cdp.webSocketDebuggerUrl = target.webSocketDebuggerUrl;
    cdp = new CDP(target.webSocketDebuggerUrl, { debug: opts.debug, label: 'cdp' });
    await cdp.connect(15000);

    const collector = createCollector();
    attachCollectors(cdp, collector);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});

    const navStart = nowMs();
    const loaded = cdp.waitFor('Page.loadEventFired', 25000).catch((err) => {
      report.warnings.push({ kind: 'load-event-timeout', category: 'navigation', text: err.message, url: opts.url, count: 1 });
      return null;
    });
    const navResult = await cdp.send('Page.navigate', { url: opts.url }, 15000);
    report.cdp.navigation = {
      errorText: navResult?.errorText ?? null,
      frameId: navResult?.frameId ?? null,
    };
    await loaded;
    report.timing.loadMs = nowMs() - navStart;
    opts.debug && process.stderr.write(`[nav] load event after ${report.timing.loadMs}ms; settling ${opts.settleMs}ms\n`);
    await sleep(opts.settleMs);
    report.timing.settledMs = nowMs() - navStart;

    const initialProbe = await probePage(cdp);
    report.probes.initial = initialProbe;
    const nav = await probeViews(cdp, initialProbe, opts.debug);
    report.probes.sessionNavigation = {
      attempted: nav.attempted,
      navigated: nav.navigated,
      clickedRowKey: nav.clickedRowKey ?? null,
      clickedRowLabel: nav.clickedRowLabel ?? null,
      reason: nav.reason ?? null,
    };
    const finalProbe = nav.probe ?? initialProbe;
    report.probes.final = finalProbe;
    const views = [initialProbe, finalProbe];
    const anyDock = Math.max(...views.map((v) => v.dock?.count ?? 0));
    const anyDockInsideComposer = Math.max(...views.map((v) => v.dock?.insideComposer ?? 0));
    const anyMarker = views.some((v) => !!v.marker?.defined);
    const anyComposer = views.some((v) => !!v.composer?.mounted);
    const anyBundle = views.some((v) => !!v.pluginBundle?.scriptSrcHasVoice);
    const anySessionView = views.some((v) => !!v.composer?.sessionId) || finalProbe.sessionRows > 0;

    // Optional functional probe: click the composer mic once, read the plugin's
    // runtime diagnostics, stop it again. Never types or sends anything.
    let clickProbe = null;
    let engineProbe = null;
    const onScreenProbe = opts.engineProbe || opts.voiceLoopProbe;
    if (opts.engineProbe) {
      if (target.id) {
        await cdp.send('Target.activateTarget', { targetId: target.id }).catch(() => {});
      }
      engineProbe = await runLocalEngineProbe(cdp, collector, opts, opts.debug);
      report.engineProbe = engineProbe;
    } else if (opts.voiceLoopProbe) {
      if (target.id) {
        await cdp.send('Target.activateTarget', { targetId: target.id }).catch(() => {});
      }
      clickProbe = await runVoiceLoopProbe(cdp, collector, opts, opts.debug);
      report.clickProbe = clickProbe;
    }

    // Screenshot after probes are done (an on-screen probe captures its own
    // ON-state screenshot, so the generic post-probe shot is skipped).
    if (!onScreenProbe) {
      try {
        if (target.id) {
          await cdp.send('Target.activateTarget', { targetId: target.id }).catch(() => {});
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
        writeFileSync(opts.screenshot, Buffer.from(shot.data, 'base64'));
        const size = statSync(opts.screenshot).size;
        report.screenshot = { path: opts.screenshot, bytes: size };
      } catch (err) {
        report.warnings.push({ kind: 'screenshot-failed', category: 'harness', text: err.message, url: '', count: 1 });
      }
    } else if (engineProbe?.screenshot) {
      report.screenshot = engineProbe.screenshot;
    } else if (clickProbe?.screenshot) {
      report.screenshot = clickProbe.screenshot;
    }

    // Classify collected errors into real errors vs known noise.
    const uncaught = classify(collector.uncaught, 'uncaught');
    const consoleErrs = classify(collector.console, 'console');
    const logErrs = classify(collector.log, 'log');
    report.errors.uncaught = uncaught.errors;
    report.errors.console = consoleErrs.errors;
    report.errors.log = logErrs.errors;
    report.warnings.push(...uncaught.warnings, ...consoleErrs.warnings, ...logErrs.warnings);

    // Optional baseline subtraction (error signatures present before install are not "new").
    const baseline = loadBaselineSignatures(opts.baselinePath);
    if (baseline.error) report.warnings.push({ kind: 'baseline-unusable', category: 'harness', text: baseline.error, url: '', count: 1 });
    const preexisting = baseline.signatures;
    const newUncaught = report.errors.uncaught.filter((e) => !preexisting.has(e.sig));
    const newConsole = report.errors.console.filter((e) => !preexisting.has(e.sig));
    const newLog = report.errors.log.filter((e) => !preexisting.has(e.sig));
    report.baseline = {
      path: opts.baselinePath,
      usable: baseline.signatures.size > 0,
      signatureCount: baseline.signatures.size,
      newUncaught: newUncaught.length,
      newConsole: newConsole.length,
      newLog: newLog.length,
    };

    const page = report.probes.final;
    const navErrorText = report.cdp.navigation?.errorText ?? null;
    const chromeErrorPage = /^chrome-error:/.test(page.href ?? '') || /(?:ERR_[A-Z_]+|can.t be reached)/.test(page.bodyTextSample ?? '');
    const navigationError = navErrorText ?? (chromeErrorPage ? 'chrome error page rendered' : null);
    const blank = !page.title && page.rootChildCount <= 0 && page.bodyTextLen < 20;
    report.page = {
      title: page.title,
      href: page.href,
      readyState: page.readyState,
      rootChildCount: page.rootChildCount,
      bodyTextLen: page.bodyTextLen,
      bodyTextSample: page.bodyTextSample,
      navigationError,
      blank,
    };
    report.checks = {
      boots: !blank && !navigationError && page.readyState !== 'loading',
      composerMounted: anyComposer,
      sessionView: anySessionView,
      voiceMarker: anyMarker,
      voiceDockElements: anyDock,
      voiceDockInsideComposer: anyDockInsideComposer,
      voiceBundleInScript: anyBundle,
      newUncaughtErrors: newUncaught.length,
      newConsoleErrors: newConsole.length,
      newLogErrors: newLog.length,
    };
    if (engineProbe) {
      const st = engineProbe.status?.body ?? {};
      const sp = engineProbe.speak ?? {};
      report.checks.localEngine = {
        statusHttp: engineProbe.status?.httpStatus ?? null,
        statusOk: st.ok === undefined ? null : st.ok,
        sttReady: st.stt?.ready === undefined ? null : st.stt.ready,
        sttProvider: st.stt?.provider ?? st.stt?.engine ?? null,
        ttsReady: st.tts?.ready === undefined ? null : st.tts.ready,
        ttsEngine: st.tts?.engine ?? st.tts?.provider ?? null,
        ttsSampleRate: st.tts?.sampleRate ?? st.tts?.sample_rate ?? null,
        speakHttp: sp.httpStatus ?? null,
        speakOk: sp.ok ?? false,
        speakBytes: sp.bytes ?? 0,
        speakSeconds: sp.decoded?.seconds ?? null,
        speakSampleRate: sp.decoded?.sampleRate ?? null,
        speakDecodeError: sp.decodeError ?? sp.error ?? null,
        suppressPromptsSet: engineProbe.suppress?.set ?? false,
        modeOn: engineProbe.afterClick?.marker?.mode ?? null,
        captureOn: engineProbe.afterClick?.marker?.capture ?? null,
        captureError: engineProbe.afterClick?.marker?.captureError ?? null,
        engineOn: engineProbe.afterClick?.marker?.engine ?? null,
        ttsReadyOn: engineProbe.afterClick?.marker?.ttsReady ?? null,
        sttReadyOn: engineProbe.afterClick?.marker?.sttReady ?? null,
        followOn: engineProbe.afterClick?.marker?.follow ?? null,
        vadOn: engineProbe.afterClick?.marker?.vad ?? null,
        transcribeOn: engineProbe.afterClick?.marker?.transcribe ?? null,
        promptOn: engineProbe.afterClick?.marker?.prompt ?? null,
        controlStateOn: engineProbe.afterClick?.controlState ?? null,
        modeOff: engineProbe.stopped?.marker?.mode ?? null,
        captureOff: engineProbe.stopped?.marker?.capture ?? null,
        controlStateOff: engineProbe.stopped?.controlState ?? null,
        conversationChanged: engineProbe.conversation?.changed ?? null,
        newUncaught: engineProbe.newErrors?.uncaught?.length ?? 0,
        newConsole: engineProbe.newErrors?.console?.length ?? 0,
        newLog: engineProbe.newErrors?.log?.length ?? 0,
      };
    }
    if (clickProbe) {
      report.checks.voiceLoop = {
        clicked: !!clickProbe.clicked?.clicked,
        stopped: !!clickProbe.clickedStop?.clicked,
        blocker: clickProbe.blocker,
        safetyStop: clickProbe.safetyStop,
        modeOn: clickProbe.afterClick?.marker?.mode ?? null,
        recognition: clickProbe.afterClick?.marker?.recognition ?? null,
        recognitionError: clickProbe.afterClick?.marker?.recognitionError ?? null,
        follow: clickProbe.afterClick?.marker?.follow ?? null,
        followError: clickProbe.afterClick?.marker?.followError ?? null,
        frames: clickProbe.afterClick?.marker?.frames ?? null,
        prompt: clickProbe.afterClick?.marker?.prompt ?? null,
        controlStateOn: clickProbe.afterClick?.controlState ?? null,
        modeOff: clickProbe.stopped?.marker?.mode ?? null,
        controlStateOff: clickProbe.stopped?.controlState ?? null,
        newUncaught: clickProbe.newErrors?.uncaught?.length ?? 0,
        newConsole: clickProbe.newErrors?.console?.length ?? 0,
        newLog: clickProbe.newErrors?.log?.length ?? 0,
      };
    }

    // Failures.
    if (navigationError) report.failures.push(`navigation failed: ${navigationError} (href=${page.href})`);
    if (blank) report.failures.push('page did not render (blank UI: no title, empty #root, no body text)');
    for (const e of newUncaught) {
      report.failures.push(`uncaught page error: ${(e.description || e.text).slice(0, 300)}`);
    }
    if (opts.expectVoice) {
      if (!anyMarker) report.failures.push(`plugin marker window.${MARKER} is not defined`);
      if (anyDock === 0) report.failures.push(`no [${DOCK_ATTR}] elements found in the DOM`);
      if (!anyComposer) report.failures.push('session composer is not mounted');
    }
    if (opts.strict) {
      for (const e of newConsole) report.failures.push(`console error: ${(e.text || '').slice(0, 300)}`);
      for (const e of newLog) report.failures.push(`log error: ${(e.text || '').slice(0, 300)}`);
    }
    if (opts.voiceLoopProbe && clickProbe) {
      if (clickProbe.blocker) report.failures.push(`voice-loop probe blocker: ${clickProbe.blocker}`);
      if (clickProbe.safetyStop) {
        report.failures.push(`voice-loop probe safety stop: ${JSON.stringify(clickProbe.safetyStopDetail)}`);
      }
    }
    if (opts.engineProbe && engineProbe) {
      if (engineProbe.blocker) report.failures.push(`engine probe blocker: ${engineProbe.blocker}`);
      if (engineProbe.safetyStop) {
        report.failures.push(`engine probe safety stop: ${JSON.stringify(engineProbe.safetyStopDetail)}`);
      }
      if (engineProbe.conversation?.changed) {
        report.failures.push('engine probe: conversation changed (a transcript leaked past suppressPrompts)');
      }
    }

    report.ok = report.failures.length === 0;
    report.timing.totalMs = nowMs() - startedAt;
    return finalize(report, opts, report.ok ? 0 : 1);
  } catch (err) {
    report.failures.push(`harness error: ${err.message}`);
    report.ok = false;
    report.timing.totalMs = nowMs() - startedAt;
    if (chrome?.logs?.stderr) {
      report.chrome = { ...(report.chrome ?? {}), stderrTail: chrome.logs.stderr.slice(-1500) };
    }
    return finalize(report, opts, 1);
  } finally {
    cdp?.close();
    await cleanupChrome({ child: chrome?.child, userDataDir, keepChrome: opts?.keepChrome ?? false, debug: opts?.debug ?? false });
  }
}

const { report, exitCode } = await main();
if (report) {
  const json = JSON.stringify(report, null, 2);
  process.stdout.write(json + '\n');
  if (report.screenshot?.path) {
    // stdout must stay pure JSON; nothing extra is printed.
  }
}
process.exitCode = exitCode;
