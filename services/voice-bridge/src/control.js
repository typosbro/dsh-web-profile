/**
 * Loopback control API (127.0.0.1 only).
 *
 *   GET  /state          -> bridge state snapshot
 *   POST /join           -> join the configured voice channel
 *   POST /leave          -> leave the voice channel
 *   POST /listen/start   -> arm capture (VAD) / start the debug PTT window
 *   POST /listen/stop    -> disarm capture (VAD) / flush the debug PTT window
 *   POST /say {"text":}  -> speak a line now (debug)
 *
 * Command parsing is a pure function (`dispatchControlRequest`) so tests can
 * exercise every route without opening a socket.
 */
import http from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;

export const CONTROL_ROUTES = [
  { method: 'GET', path: '/state', action: 'state' },
  { method: 'POST', path: '/join', action: 'join' },
  { method: 'POST', path: '/leave', action: 'leave' },
  { method: 'POST', path: '/listen/start', action: 'listenStart' },
  { method: 'POST', path: '/listen/stop', action: 'listenStop' },
  { method: 'POST', path: '/say', action: 'say' },
];

export class ControlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
  }
}

/**
 * Pure request dispatcher: no sockets, no timers.
 *
 * @returns {Promise<{status: number, payload: any}>}
 */
export async function dispatchControlRequest({ method, path: requestPath, body, actions }) {
  const normalizedMethod = String(method ?? 'GET').toUpperCase();
  const normalizedPath = String(requestPath ?? '/').split('?')[0].replace(/\/+$/, '') || '/';

  const route = CONTROL_ROUTES.find((candidate) => candidate.path === normalizedPath);
  if (!route) {
    return { status: 404, payload: { ok: false, error: `unknown route ${normalizedPath}` } };
  }
  if (route.method !== normalizedMethod) {
    return {
      status: 405,
      payload: { ok: false, error: `${normalizedPath} accepts ${route.method}` },
    };
  }

  try {
    if (route.action === 'say') {
      const parsed = parseJsonBody(body);
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      if (!text) throw new ControlError('body must be {"text": "<non-empty string>"}');
      const result = await callAction(actions, 'say', text);
      return { status: 200, payload: { ok: true, ...(result ?? {}) } };
    }

    if (route.action === 'state') {
      const result = callAction(actions, 'state');
      const payload = await result;
      return { status: 200, payload: { ok: true, state: payload ?? null } };
    }

    if (body && String(body).trim().length > 0) {
      // tolerate stray JSON bodies on no-payload commands
      parseJsonBody(body);
    }
    await callAction(actions, route.action);
    return { status: 200, payload: { ok: true, command: route.action } };
  } catch (error) {
    const status = error instanceof ControlError ? error.status : 500;
    return { status, payload: { ok: false, error: error.message } };
  }
}

function callAction(actions, name, ...args) {
  const action = actions?.[name];
  if (typeof action !== 'function') {
    throw new ControlError(`control action "${name}" is not available`, 503);
  }
  return action(...args);
}

export function parseJsonBody(body) {
  if (body === null || body === undefined || String(body).trim() === '') return {};
  try {
    return JSON.parse(String(body));
  } catch {
    throw new ControlError('request body is not valid JSON');
  }
}

/**
 * Starts the loopback HTTP server. `port: 0` binds an ephemeral port (useful
 * for local smoke tests); production uses config.controlPort (3090).
 */
export function createControlServer({ port = 3090, host = '127.0.0.1', actions, logger }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const { status, payload } = await dispatchControlRequest({
        method: req.method,
        path: req.url,
        body,
        actions,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      logger?.debug?.(`control ${req.method} ${req.url} -> ${status}`);
    } catch (error) {
      logger?.error?.('control server error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'internal control server error' }));
    }
  });

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server.address();
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
    get address() {
      return server.address();
    },
  };
}
