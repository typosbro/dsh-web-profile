/**
 * browser-live — client half (Web GUI).
 *
 * Registers a right-sidebar tab that shows the host's multipart MJPEG stream of
 * the agent's headless Chrome and forwards pointer/keyboard input to it while
 * the human holds control.
 *
 * Ownership is a human-side discipline: this pane only decides whether to send
 * input. The host accepts any input it is asked to dispatch and does not
 * arbitrate between the agent and the human — see README.md.
 */

// Client halves are NOT ES modules in this harness: the client module loader evaluates the
// file as a classic script that must register itself, which is why a top-level `export`
// fails with "Unexpected token 'export'" and takes the whole Web boot down with it.
//
// Every declaration also lives INSIDE the factory, deliberately. This module is served both
// standalone and inside the combined client bundle, and a `const` left at the file's top
// level lands in the page's global lexical scope — a second evaluation then throws
// "Identifier 'TAB_ID' has already been declared" and the whole entry fails to activate.
window.__ModuleLoader__.load({
  id: '@local/browser-live',
  factory(require) {
    const TAB_ID = 'browser-live';
    const STREAM_URL = '/browser-live/live.mjpg';
    const INPUT_URL = '/browser-live/input';
    /** Fallback CSS viewport; the host reports the measured one via getLayoutMetrics. */
    const FALLBACK_VIEWPORT = { width: 390, height: 844 };
    const MOVE_THROTTLE_MS = 60;
    const name = 'browser-live';
    const inject = ['sidebarRightTabs', 'slots', 'locale'];

const zh = {
  title: '实时浏览器',
  take: '接管',
  release: '释放',
  owned: '已接管',
  watching: '仅查看',
  note: '仅在你持有控制权时转发输入',
};
const en = {
  title: 'Live browser',
  take: 'Take control',
  release: 'Release',
  owned: 'In control',
  watching: 'View only',
  note: 'Input is forwarded only while you hold control',
};

/** Plain hyperscript; no framework imports. */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'style') node.setAttribute('style', value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** POST one input payload; failures are surfaced on the badge, never thrown. */
async function postInput(payload, onError) {
  try {
    const response = await fetch(INPUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    if (typeof onError === 'function') onError(String(error?.message ?? error));
    return false;
  }
}

/** Builds the pane's DOM subtree. Not a component: `h` here is createElement-based, not React. */
function buildPaneBody(props) {
  const info = props.tabInfo ?? {};
  const tab = info.tab ?? {};
  const signal = tab.signal;
  const t = props.t ?? ((key) => en[key] ?? key);

  const root = h('div', {
    style: 'display:flex;flex-direction:column;height:100%;min-height:0;font:12px/1.4 system-ui,sans-serif;',
  });
  const bar = h('div', {
    style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.25);flex:0 0 auto;',
  });
  const badge = h('span', {
    style: 'padding:1px 6px;border-radius:999px;font-weight:600;background:rgba(128,128,128,.18);',
    text: t('watching'),
  });
  const toggle = h('button', {
    type: 'button',
    style: 'padding:2px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;',
    text: t('take'),
  });
  const status = h('span', { style: 'margin-left:auto;opacity:.6;text-align:right;', text: t('note') });
  bar.append(badge, toggle, status);

  const stage = h('div', {
    style: 'flex:1 1 auto;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.18);',
  });
  const image = h('img', {
    src: STREAM_URL,
    fetchpriority: 'low',
    alt: t('title'),
    draggable: 'false',
    style: 'max-width:100%;max-height:100%;object-fit:contain;touch-action:none;cursor:default;user-select:none;',
  });
  stage.append(image);
  root.append(bar, stage);

  /** CSS-pixel viewport of the remote page, from the stream's response header. */
  let viewport = { ...FALLBACK_VIEWPORT };
  let controlled = false;
  let lastMoveAt = 0;
  let composing = false;

  const fail = (message) => {
    status.textContent = message;
  };

  image.addEventListener('load', () => {
    status.textContent = controlled ? t('note') : '';
  });
  image.addEventListener('error', () => {
    status.textContent = 'stream unavailable (host is not attached to Chrome)';
  });

  /** Element-local client px -> remote CSS px, using the measured viewport. */
  const mapPoint = (event) => {
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const x = ((event.clientX - rect.left) / rect.width) * viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * viewport.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return undefined;
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  };

  const onPointerDown = (event) => {
    if (!controlled) return;
    const point = mapPoint(event);
    if (point === undefined) return;
    event.preventDefault();
    if (event.button === 1) image.focus?.();
    void postInput({ type: 'click', ...point, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }, fail);
  };
  const onPointerMove = (event) => {
    if (!controlled) return;
    const now = Date.now();
    if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
    lastMoveAt = now;
    const point = mapPoint(event);
    if (point === undefined) return;
    void postInput({ type: 'move', ...point }, fail);
  };
  const onWheel = (event) => {
    if (!controlled) return;
    const point = mapPoint(event);
    if (point === undefined) return;
    event.preventDefault();
    void postInput({ type: 'scroll', ...point, deltaX: event.deltaX, deltaY: event.deltaY }, fail);
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = (event) => {
    composing = false;
    if (!controlled) return;
    if (event.data) void postInput({ type: 'text', text: event.data }, fail);
  };
  const onKeyDown = (event) => {
    if (!controlled || composing) return;
    const passthrough = event.ctrlKey || event.metaKey || event.altKey;
    event.preventDefault();
    if (event.key.length === 1 && !passthrough) return; // text arrives via beforeinput
    void postInput({ type: 'key', key: event.key, code: event.code }, fail);
  };
  const onBeforeInput = (event) => {
    if (!controlled) return;
    event.preventDefault();
    if (event.data) void postInput({ type: 'text', text: event.data }, fail);
  };
  const onContextMenu = (event) => {
    if (controlled) event.preventDefault();
  };

  const LISTENERS = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['wheel', onWheel, { passive: false }],
    ['contextmenu', onContextMenu],
    ['keydown', onKeyDown],
    ['beforeinput', onBeforeInput],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
  ];

  /** Attach forwarding listeners; called ONLY while the human holds control. */
  const attach = () => {
    for (const [type, handler, options] of LISTENERS) stage.addEventListener(type, handler, options);
    stage.tabIndex = 0;
    stage.focus?.();
  };
  /** Detach immediately on release/teardown; the stream itself keeps running. */
  const detach = () => {
    for (const [type, handler, options] of LISTENERS) stage.removeEventListener(type, handler, options);
  };

  const setControlled = (next) => {
    controlled = next;
    badge.textContent = next ? t('owned') : t('watching');
    badge.style.background = next ? 'rgba(64,180,120,.30)' : 'rgba(128,128,128,.18)';
    toggle.textContent = next ? t('release') : t('take');
    image.style.cursor = next ? 'crosshair' : 'default';
    status.textContent = next ? t('note') : '';
    if (next) attach();
    else detach();
  };

  toggle.addEventListener('click', () => setControlled(!controlled));

  // The stream response itself carries the measured viewport. Do NOT open a
  // second request for it: while the multipart stream is open, Chrome's devtools
  // HTTP endpoint serializes other connections and a HEAD would hang.
  const applyViewportHeader = (header) => {
    const [width, height] = String(header ?? '').split('x').map(Number);
    if (width > 0 && height > 0) viewport = { width, height };
  };
  if (typeof fetch === 'function') {
    fetch(STREAM_URL, { method: 'GET', cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyViewportHeader(response.headers.get('X-Browser-Live-Viewport'));
      return response.body?.cancel?.();
    }).catch(() => {
      // Fall back to whatever the <img> element can tell us; keep the default otherwise.
      const natural = { width: image.naturalWidth, height: image.naturalHeight };
      if (natural.width > 0 && natural.height > 0 && viewport === FALLBACK_VIEWPORT) {
        // JPEG pixel size is NOT the CSS viewport; only used to detect a mismatch.
        status.title = `stream ${natural.width}x${natural.height}px; assuming ${viewport.width}x${viewport.height} CSS px`;
      }
    });
  }

  if (signal !== undefined && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => {
      controlled = false;
      detach();
      image.removeAttribute('src'); // stops the MJPEG connection
      root.remove();
    }, { once: true });
  }

  setControlled(false);
  return root;
}

/**
 * The sidebar body the slot actually renders.
 *
 * The slot machinery renders a React component, and a function component may not return a
 * bare DOM node — React throws and the pane comes up empty. So this mounts the DOM subtree
 * `buildPaneBody` builds into a container element, and tears it down on unmount; the
 * subtree's own abort listener (tab.signal) handles the stream.
 */
function BrowserLiveBody(props) {
  const React = require('react');
  const host = React.useRef(null);
  React.useEffect(() => {
    const element = host.current;
    const node = buildPaneBody(props);
    if (element && node) element.appendChild(node);
    return () => {
      if (element && node && node.parentNode === element) element.removeChild(node);
    };
  }, []);
  return React.createElement('div', {
    ref: host,
    style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' },
  });
}

function apply(ctx) {
  ctx.effect(() => ctx.locale?.register?.('browser-live', { en, zh }), 'browser-live.copy');
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'browser-live',
    multiple: true,
    keepMounted: true,
    // `title` and every guide field are functions, not strings: the registry calls them at
    // render time so the tab name and the guide capsule follow the current language.
    title: () => en.title,
    guide: [{
      id: TAB_ID,
      order: 20,
      title: () => en.title,
      description: () => en.note,
    }],
  }), 'browser-live.type');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: 'browser-live',
  }, BrowserLiveBody)), 'browser-live.body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
  }, () => en.title)), 'browser-live.title');
}

    return { name, inject, apply };
  },
});
