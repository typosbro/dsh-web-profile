/**
 * browser-live — host half.
 *
 * Pumps JPEG frames from the agent's own headless Chrome (CDP over the DevTools
 * WebSocket) to the Web GUI as a multipart/x-mixed-replace stream, and forwards
 * human pointer/keyboard input back into that page.
 *
 * Routes (both behind ctx.connection.requestRejection):
 *   GET  /browser-live/live.mjpg   multipart MJPEG stream of the attached page
 *   POST /browser-live/input       { type: 'click'|'move'|'text'|'key'|'scroll', ... } -> 204
 *
 * The CDP endpoint is discovered from http://127.0.0.1:9222/json/version and may
 * be absent entirely: nothing throws at load, both routes answer 503, and
 * discovery retries with backoff.
 */

import z from '@deepseek-ai/schemastery';

/** Cordis plugin name. */
export const name = 'browser-live';

/** Required services: the loopback Web server and the connection trust gate. */
export const inject = ['webServer', 'connection'];

export const Config = z.object({
  /** DevTools HTTP endpoint probed for `webSocketDebuggerUrl`. */
  cdpHttpEndpoint: z.string().default('http://127.0.0.1:9222/json/version'),
  /** Extra wait after navigation before re-arming the screencast, ms. */
  rearmDelayMs: z.number().step(1).min(0).default(350),
  /** Server-side stream frame cap, frames per second. */
  maxFps: z.number().min(0.1).default(2),
  /** JPEG quality passed to Page.startScreencast (1-100). */
  jpegQuality: z.number().step(1).min(1).max(100).default(60),
  /** Capture every Nth compositor frame. 3 is the measured ~1 fps idle setting. */
  everyNthFrame: z.number().step(1).min(1).default(3),
  /** Screencast viewport budget, CSS px: 780x1688 at DPR 2 is a 390x844 phone. */
  captureMaxWidth: z.number().step(1).min(1).default(780),
  captureMaxHeight: z.number().step(1).min(1).default(1688),
  /** Reconnect backoff bounds, ms. */
  retryMinMs: z.number().step(1).min(50).default(1000),
  retryMaxMs: z.number().step(1).min(100).default(15000),
  /** Discovery probe timeout during load, ms. */
  probeTimeoutMs: z.number().step(1).min(100).default(1500),
});

const LIVE_PATH = '/browser-live/live.mjpg';
const INPUT_PATH = '/browser-live/input';
const BOUNDARY = 'browserliveframe';
const DEFAULT_CSS_VIEWPORT = { width: 390, height: 844 };

/** Parse `URL` search params defensively (handler may run on a bare req). */
function searchParamsOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

/** Opt-in step tracing for local diagnosis: DSH_BROWSER_LIVE_DEBUG=1. */
function debugTrace(logger, message) {
  if (process.env.DSH_BROWSER_LIVE_DEBUG) logger.info(`browser-live[debug]: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Extension/service-worker pages are `type: 'page'` too but are not the agent's page. */
const IGNORED_TARGET_URL_PREFIXES = ['chrome-extension://', 'devtools://', 'chrome://', 'edge://', 'about:'];

/** Whether a target info describes a real, attachable, agent-visible page. */
function isAttachablePage(info) {
  if (info === undefined || info === null || info.type !== 'page') return false;
  const url = typeof info.url === 'string' ? info.url : '';
  return !IGNORED_TARGET_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Prefer the first real page; fall back to any page so a blank browser still attaches. */
function pickPageTarget(targetInfos) {
  const pages = (targetInfos ?? []).filter((info) => info?.type === 'page');
  return pages.find((info) => isAttachablePage(info)) ?? pages[0];
}

/**
 * One CDP connection to the headless browser, re-discovered and re-established
 * on drop. Owns the screencast for exactly one page target and republishes the
 * newest JPEG to registered listeners.
 */
class CdpBridge {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    /** Newest JPEG buffer, or undefined before the first frame. */
    this.frame = undefined;
    /** Monotonic counter so writers can skip repeated frames. */
    this.frameSeq = 0;
    /** CSS-pixel viewport of the attached page (NOT the JPEG's pixel size). */
    this.cssViewport = undefined;
    this.status = 'idle';
    this.socket = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = undefined;
    this.targetId = undefined;
    this.armed = false;
    this.onFrame = () => {};
    this.closed = false;
    this.retryMs = config.retryMinMs;
    this.rearmTimer = undefined;
    this.connectPromise = undefined;
  }

  /** Start discovery/connection; never rejects. */
  start() {
    debugTrace(this.logger, 'start()');
    this.connectPromise = this.#run();
    return this.connectPromise;
  }

  /** Stop retrying and close the socket. */
  dispose() {
    this.closed = true;
    if (this.rearmTimer !== undefined) {
      clearTimeout(this.rearmTimer);
      this.rearmTimer = undefined;
    }
    this.#closeSocket();
    this.status = 'disposed';
  }

  #closeSocket() {
    const socket = this.socket;
    this.socket = undefined;
    this.armed = false;
    this.sessionId = undefined;
    this.targetId = undefined;
    for (const [, entry] of this.pending) entry.reject(new Error('browser-live: CDP socket closed'));
    this.pending.clear();
    if (socket !== undefined) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
  }

  async #run() {
    while (!this.closed) {
      try {
        await this.#connectOnce();
      } catch (error) {
        if (this.closed) return;
        this.status = 'disconnected';
        this.logger.warn(`browser-live: ${String(error?.message ?? error)}; retrying in ${this.retryMs}ms`);
      }
      if (this.closed) return;
      this.#closeSocket();
      await sleep(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, this.config.retryMaxMs);
    }
  }

  /** Resolve the devtools WebSocket URL, connect, and attach the page target. */
  async #connectOnce() {
    const { cdpHttpEndpoint, probeTimeoutMs } = this.config;
    this.status = 'discovering';
    const response = await fetch(cdpHttpEndpoint, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (!response.ok) throw new Error(`CDP endpoint ${cdpHttpEndpoint} answered HTTP ${response.status}`);
    const version = await response.json();
    const url = version?.webSocketDebuggerUrl;
    if (typeof url !== 'string' || url === '') throw new Error(`CDP endpoint ${cdpHttpEndpoint} has no webSocketDebuggerUrl`);
    debugTrace(this.logger, `discovered ${url}`);

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`CDP socket to ${url} failed`));
    });
    if (this.closed) return;
    debugTrace(this.logger, 'socket open');

    // A successful connect resets the backoff and drives the socket's lifetime:
    // #sessionLoop settles only when the socket closes or dispose() runs.
    this.retryMs = this.config.retryMinMs;
    this.status = 'connected';
    const socket = this.socket;
    socket.onmessage = (event) => {
      void this.#onMessage(event.data);
    };
    socket.onclose = () => {
      debugTrace(this.logger, `socket closed at seq ${this.frameSeq}`);
      if (this.closeWaiter !== undefined) {
        const settle = this.closeWaiter;
        this.closeWaiter = undefined;
        settle();
      }
    };
    await this.#sessionLoop();
    if (!this.closed) throw new Error('CDP socket closed');
  }

  /** Enable discovery, attach the first page target, and wait for teardown. */
  async #sessionLoop() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.send('Target.getTargets');
    const page = pickPageTarget(targetInfos);
    if (page === undefined) throw new Error('no page target in the headless browser');
    this.targetId = page.targetId;
    debugTrace(this.logger, `discoverTargets ok, ${(targetInfos ?? []).length} targets, page ${page.targetId} ${page.url}`);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    debugTrace(this.logger, `attached session ${sessionId}`);
    await this.#refreshViewport();
    debugTrace(this.logger, `viewport ${JSON.stringify(this.cssViewport)}`);
    await this.#arm();
    debugTrace(this.logger, 'screencast armed');
    const closed = new Promise((resolve) => {
      this.closeWaiter = resolve;
    });
    await closed;
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        debugTrace(this.logger, `CDP error on ${entry.method}: ${message.error.message}`);
        entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
      }
      else entry.resolve(message.result ?? {});
      return;
    }
    const { method, params = {}, sessionId } = message;
    if (method === 'Page.screencastFrame') {
      // Mandatory: without the ack Chrome stops sending frames entirely.
      void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      this.#acceptFrame(params);
      return;
    }
    if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument' || method === 'Page.loadEventFired') {
      this.#scheduleRearm();
      return;
    }
    if (method === 'Target.attachedToTarget' && isAttachablePage(params.targetInfo)) {
      const previous = this.targetId;
      this.targetId = params.targetInfo.targetId;
      this.sessionId = params.sessionId;
      this.#scheduleRearm();
      if (previous !== undefined && previous !== this.targetId) {
        void this.send('Target.detachFromTarget', { sessionId: params.sessionId }).catch(() => {});
      }
      return;
    }
    if (method === 'Target.detachedFromTarget' || method === 'Target.targetCrashed') {
      this.armed = false;
      this.#scheduleRearm();
      return;
    }
  }

  #acceptFrame(params) {
    if (typeof params?.data !== 'string' || params.data === '') return;
    if (params.metadata !== undefined) {
      const w = Number(params.metadata.deviceWidth);
      const h = Number(params.metadata.deviceHeight);
      if (w > 0 && h > 0) this.cssViewport = { width: w, height: h };
    }
    this.frame = Buffer.from(params.data, 'base64');
    this.frameSeq += 1;
    if (this.frameSeq === 1) debugTrace(this.logger, `first frame ${this.frame.length}B, viewport ${JSON.stringify(this.cssViewport)}`);
    this.onFrame(this.frame, this.frameSeq);
  }

  #scheduleRearm() {
    if (this.closed || this.sessionId === undefined) return;
    if (this.rearmTimer !== undefined) clearTimeout(this.rearmTimer);
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = undefined;
      void this.#refreshViewport().catch(() => {});
      void this.#arm().catch(() => {
        this.armed = false;
        this.#scheduleRearm();
      });
    }, this.config.rearmDelayMs);
    if (typeof this.rearmTimer.unref === 'function') this.rearmTimer.unref();
  }

  /** (Re)start the screencast for the attached session. */
  async #arm() {
    if (this.closed || this.sessionId === undefined) return;
    const { jpegQuality, everyNthFrame, captureMaxWidth, captureMaxHeight } = this.config;
    // Stop only what this bridge started. Calling stop on a session that was
    // never streaming appears to leave Chrome emitting nothing at all, and
    // calling start twice answers "Screencast is already active" — so track it.
    if (this.armed) {
      await this.send('Page.stopScreencast', {}, this.sessionId).catch(() => {});
      this.armed = false;
    }
    await this.send('Page.enable', {}, this.sessionId);
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: Math.round(jpegQuality),
      maxWidth: Math.round(captureMaxWidth),
      maxHeight: Math.round(captureMaxHeight),
      everyNthFrame: Math.round(everyNthFrame),
    }, this.sessionId);
    // A restart while a screencast was already running is harmless; Chrome
    // keeps exactly one session and resumes emitting frames.
    this.armed = true;
    this.status = 'streaming';
  }

  /**
   * Cache the CSS viewport; input coordinates are always in these units.
   * Right after attach the metrics can still be 0x0, so retry briefly.
   * @returns the measured viewport, or undefined when it stays unusable.
   */
  async #refreshViewport(attempts = 3) {
    if (this.sessionId === undefined) return undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const metrics = await this.send('Page.getLayoutMetrics', {}, this.sessionId);
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      const width = Number(viewport?.clientWidth ?? viewport?.width);
      const height = Number(viewport?.clientHeight ?? viewport?.height);
      if (width > 0 && height > 0) {
        this.cssViewport = { width, height };
        return this.cssViewport;
      }
      await sleep(120);
    }
    return undefined;
  }

  /** Viewport reported to the client: measured CSS px, else the 390x844 default. */
  viewport() {
    return this.cssViewport ?? DEFAULT_CSS_VIEWPORT;
  }

  /** Send one CDP command; rejects when disconnected or on a CDP error. */
  send(method, params = {}, sessionId = undefined) {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.reject(new Error(`browser-live: CDP not connected (${method})`));
    }
    const id = this.nextId++;
    const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Map one accepted input payload onto CDP input domains. */
  async dispatch(input) {
    if (this.sessionId === undefined) throw new Error('browser-live: no attached page target');
    const session = this.sessionId;
    const viewport = this.viewport();
    const clampX = (value) => Math.max(0, Math.min(viewport.width, Number(value)));
    const clampY = (value) => Math.max(0, Math.min(viewport.height, Number(value)));
    const type = input?.type;
    if (type === 'click' || type === 'move') {
      const x = clampX(input.x);
      const y = clampY(input.y);
      if (type === 'move') {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, session);
        return;
      }
      const button = input.button === 'right' ? 'right' : input.button === 'middle' ? 'middle' : 'left';
      const clickCount = Number.isFinite(input.clickCount) ? Math.max(1, Math.round(input.clickCount)) : 1;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, session);
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons: 1 }, session);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, buttons: 0 }, session);
      return;
    }
    if (type === 'text') {
      await this.send('Input.insertText', { text: String(input.text ?? '') }, session);
      return;
    }
    if (type === 'key') {
      const key = String(input.key ?? '');
      if (key === '') throw new Error('browser-live: key input needs a "key"');
      const text = typeof input.text === 'string' ? input.text : key.length === 1 ? key : undefined;
      const base = { key, code: typeof input.code === 'string' ? input.code : undefined, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined };
      if (text !== undefined) await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text }, session);
      else await this.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, session);
      await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, session);
      return;
    }
    if (type === 'scroll') {
      const deltaY = Number(input.deltaY ?? 0);
      const deltaX = Number(input.deltaX ?? 0);
      if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX)) {
        throw new Error('browser-live: scroll input needs numeric deltaX/deltaY');
      }
      await this.send('Input.synthesizeScrollGesture', {
        x: clampX(input.x ?? viewport.width / 2),
        y: clampY(input.y ?? viewport.height / 2),
        xDistance: Math.round(-deltaX),
        yDistance: Math.round(-deltaY),
        speed: 800,
      }, session);
      return;
    }
    throw new Error(`browser-live: unsupported input type ${JSON.stringify(type)}`);
  }
}

/**
* Mount the MJPEG stream and input routes.
* @param ctx - host plugin context carrying webServer and connection.
* @param config - validated {@link Config}.
*/
export function apply(ctx, config) {
  // Fail closed at load: a broken CDP URL must not abort the plugin.
  let resolved = config;
  try {
    resolved = Config(config ?? {});
  } catch (error) {
    ctx.logger.warn(`browser-live: invalid config, using defaults: ${String(error?.message ?? error)}`);
    resolved = Config({});
  }

  const bridge = new CdpBridge(resolved, ctx.logger);
  /** Open multipart responders. */
  const responders = new Set();
  /** Serialization gate: one write loop across all responders. */
  let writing = false;
  let lastWrittenSeq = 0;
  let lastWriteAt = 0;

  const minIntervalMs = 1000 / resolved.maxFps;

  /** Push the newest frame to every responder, skipping ones already current. */
  const flush = () => {
    if (writing || responders.size === 0 || bridge.frame === undefined) return;
    const now = Date.now();
    if (now - lastWriteAt < minIntervalMs) return;
    if (bridge.frameSeq === lastWrittenSeq) return;
    const frame = bridge.frame;
    const seq = bridge.frameSeq;
    writing = true;
    lastWrittenSeq = seq;
    lastWriteAt = now;
    // Coalesce: a responder that cannot keep up is skipped, never queued.
    for (const responder of [...responders]) {
      if (responder.seq === seq) continue;
      responder.seq = seq;
      try {
        responder.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\nX-Seq: ${seq}\r\n\r\n`);
        responder.res.write(frame);
        responder.res.write('\r\n');
      } catch {
        dropResponder(responder);
      }
    }
    writing = false;
  };

  const dropResponder = (responder) => {
    if (!responders.delete(responder)) return;
    if (typeof responder.cleanup === 'function') responder.cleanup();
    try {
      responder.res.end();
    } catch {
      /* peer already gone */
    }
  };

  bridge.onFrame = () => {
    flush();
  };

  // Paced flusher: enforces the fps floor between writes. Session dwell time is
  // Chrome's business (it expires sessions itself); idle streams just stay open.
  const tick = setInterval(flush, Math.max(50, Math.round(minIntervalMs / 2)));
  if (typeof tick.unref === 'function') tick.unref();

  /** Gate every request behind the connection trust check. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  const unavailable = (res, reason) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '2');
    res.end(`browser-live: headless Chrome is not reachable (${reason})\n`);
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIVE_PATH,
    handler: (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end();
        return;
      }
      if (bridge.status === 'disposed' || !bridge.socket) {
        unavailable(res, bridge.status);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Connection', 'close');
      res.setHeader('X-Browser-Live-Viewport', `${bridge.viewport().width}x${bridge.viewport().height}`);
      // A short warm-up body lets clients confirm the stream before frame one.
      res.write(`--${BOUNDARY}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n\r\n`);
      const responder = { res, seq: 0, cleanup: undefined };
      responders.add(responder);
      const cleanup = () => {
        req.off('close', onClose);
        req.off('error', onClose);
        res.off('close', onClose);
      };
      const onClose = () => dropResponder(responder);
      responder.cleanup = cleanup;
      req.on('close', onClose);
      req.on('error', onClose);
      res.on('close', onClose);
      flush();
    },
  }), 'browser-live.stream-route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INPUT_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end();
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`browser-live: bad JSON body (${String(error?.message ?? error)})\n`);
        return;
      }
      if (!bridge.socket) {
        unavailable(res, bridge.status);
        return;
      }
      try {
        await bridge.dispatch(payload);
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`browser-live: input rejected (${String(error?.message ?? error)})\n`);
        return;
      }
      res.statusCode = 204;
      res.end();
    },
  }), 'browser-live.input-route');

  ctx.effect(() => () => {
    clearInterval(tick);
    for (const responder of [...responders]) dropResponder(responder);
    responders.clear();
    bridge.dispose();
  }, 'browser-live.dispose');

  // Non-blocking: load never waits on Chrome, and a missing endpoint only logs.
  bridge.start().then(() => {
    if (bridge.status !== 'disposed') ctx.logger.warn('browser-live: CDP bridge loop ended');
  }, (error) => {
    ctx.logger.warn(`browser-live: CDP bridge stopped: ${String(error?.message ?? error)}`);
  });
  ctx.logger.info(`browser-live: mounted ${LIVE_PATH} and ${INPUT_PATH}, probing ${resolved.cdpHttpEndpoint}`);
}

export default { name, inject, Config, apply };
