import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTROL_ROUTES,
  createControlServer,
  dispatchControlRequest,
  parseJsonBody,
} from '../src/control.js';

function fakeActions(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return { handled: name };
  };
  return {
    calls,
    actions: {
      state: () => ({ connected: true }),
      join: record('join'),
      leave: record('leave'),
      listenStart: record('listenStart'),
      listenStop: record('listenStop'),
      say: (text) => {
        calls.push({ name: 'say', args: [text] });
        return { handled: 'say', text };
      },
      ...overrides,
    },
  };
}

test('GET /state returns the bridge snapshot', async () => {
  const { actions } = fakeActions();
  const response = await dispatchControlRequest({ method: 'GET', path: '/state', actions });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { ok: true, state: { connected: true } });
});

test('POST commands dispatch to the matching action', async () => {
  for (const route of CONTROL_ROUTES.filter((entry) => entry.method === 'POST' && entry.path !== '/say')) {
    const { actions, calls } = fakeActions();
    const response = await dispatchControlRequest({
      method: 'post',
      path: route.path,
      body: '',
      actions,
    });
    assert.equal(response.status, 200, route.path);
    assert.deepEqual(response.payload, { ok: true, command: route.action });
    assert.equal(calls[0].name, route.action);
  }
});

test('POST /say parses the JSON body and passes trimmed text', async () => {
  const { actions, calls } = fakeActions();
  const response = await dispatchControlRequest({
    method: 'POST',
    path: '/say',
    body: JSON.stringify({ text: '  Hello there  ' }),
    actions,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { ok: true, handled: 'say', text: 'Hello there' });
  assert.deepEqual(calls[0].args, ['Hello there']);
});

test('POST /say rejects bad bodies', async () => {
  const { actions } = fakeActions();
  for (const body of ['{not json', '{}', '{"text":""}', '{"text":42}']) {
    const response = await dispatchControlRequest({ method: 'POST', path: '/say', body, actions });
    assert.equal(response.status, 400, `body: ${body}`);
    assert.equal(response.payload.ok, false);
  }
});

test('query strings and trailing slashes normalise to a known route', async () => {
  const { actions } = fakeActions();
  const state = await dispatchControlRequest({ method: 'GET', path: '/state?verbose=1', actions });
  assert.equal(state.status, 200);

  const join = await dispatchControlRequest({ method: 'POST', path: '/join/', actions });
  assert.equal(join.status, 200);
});

test('unknown routes are 404 and wrong methods are 405', async () => {
  const { actions } = fakeActions();
  assert.equal((await dispatchControlRequest({ method: 'GET', path: '/nope', actions })).status, 404);

  const wrongMethod = await dispatchControlRequest({ method: 'GET', path: '/join', actions });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.payload.error, /accepts POST/);
});

test('action errors become 500 and stay inside the response', async () => {
  const { actions } = fakeActions({
    say: () => {
      throw new Error('Kokoro is down');
    },
  });
  const response = await dispatchControlRequest({
    method: 'POST',
    path: '/say',
    body: JSON.stringify({ text: 'hi' }),
    actions,
  });
  assert.equal(response.status, 500);
  assert.deepEqual(response.payload, { ok: false, error: 'Kokoro is down' });
});

test('missing actions answer 503 instead of crashing', async () => {
  const response = await dispatchControlRequest({
    method: 'POST',
    path: '/join',
    actions: {},
  });
  assert.equal(response.status, 503);
  assert.match(response.payload.error, /not available/);
});

test('async actions are awaited', async () => {
  const { actions } = fakeActions({
    join: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { connected: true };
    },
  });
  const response = await dispatchControlRequest({ method: 'POST', path: '/join', actions });
  assert.equal(response.status, 200);
});

test('non-empty bodies on no-payload commands must still be JSON', async () => {
  const { actions } = fakeActions();
  const bad = await dispatchControlRequest({ method: 'POST', path: '/join', body: 'x', actions });
  assert.equal(bad.status, 400);
});

test('parseJsonBody tolerates empty bodies', () => {
  assert.deepEqual(parseJsonBody(''), {});
  assert.deepEqual(parseJsonBody(undefined), {});
  assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
});

test('createControlServer builds a loopback http server without listening yet', () => {
  const { actions } = fakeActions();
  const control = createControlServer({ port: 0, actions, logger: null });
  assert.equal(control.server.listening, false);
  assert.equal(control.address, null);
  control.server.close();
});
