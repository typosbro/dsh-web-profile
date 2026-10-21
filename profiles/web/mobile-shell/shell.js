/* mobile-shell — the behaviour CSS alone cannot provide for the DSH Web GUI.
 *
 * Loaded from disk on every index render, so editing this file needs only a
 * browser reload. It is injected into <head> as a classic script, i.e. it runs
 * before the app's deferred module scripts, so it must tolerate an empty
 * document and poll briefly for the shell.
 *
 * Responsibilities:
 *   1. keyboard-aware shell height (iOS; Android handles this via CSS)
 *   2. a hamburger that replaces the deleted sidebar rail
 *   3. the modal drawer contract: scrim, tap-outside, edge-swipe, Back
 *   4. Material behaviour of dismissing the drawer once an item is chosen
 */
(function () {
  'use strict'

  var root = document.documentElement

  /* -- 1. Keyboard-aware shell height --------------------------------------
   * Android honours `interactive-widget=resizes-content` and shrinks the layout
   * viewport itself, so this is a no-op there. iOS Safari overlays the keyboard
   * without changing innerHeight — the case handled here: once the visual
   * viewport is materially shorter than the layout viewport, pin the shell to
   * the visible height so the composer clears the keyboard. */
  var vv = window.visualViewport
  if (vv) {
    var raf = 0
    var syncHeight = function () {
      raf = 0
      if (window.innerHeight - vv.height > 120) {
        root.style.setProperty('--dsh-app-h', Math.round(vv.height) + 'px')
        root.setAttribute('data-dsh-kb', '')
      } else {
        root.removeAttribute('data-dsh-kb')
        root.style.removeProperty('--dsh-app-h')
      }
    }
    var schedule = function () {
      if (!raf) raf = requestAnimationFrame(syncHeight)
    }
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    window.addEventListener('orientationchange', schedule)
    syncHeight()
  }

  /* -- 2. Drawer state ------------------------------------------------------ */
  var narrow = window.matchMedia('(max-width: 979px)')
  var EDGE = 28 /* px from the left edge that counts as an edge swipe */

  var frame = null
  var scrim = null
  var burger = null
  var observer = null
  var onFrameClick = null

  function sidebarEl() {
    return frame === null ? null : frame.querySelector('[class*="sidebarCol"]')
  }

  /* The app owns expansion state; we drive the same control the rail uses, which
   * stays in the DOM (and stays clickable) even while the rail is display:none. */
  function toggleControl() {
    var sidebar = sidebarEl()
    return sidebar === null ? null : sidebar.querySelector('[class*="toggle"]')
  }

  function isOpen() {
    return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
  }

  function clickToggle() {
    var control = toggleControl()
    if (control !== null) control.click()
  }

  /* -- 3. Back-button integration ------------------------------------------
   * Only ever step back through an entry this script pushed. If the app pushed
   * its own entry after ours (session or tab navigation), `history.state` is no
   * longer our marker and stepping back would undo the user's navigation, so we
   * leave the stale entry alone instead. */
  var pushed = false
  var selfBack = false

  function pushHistory() {
    if (pushed) return
    try {
      history.pushState({ dshDrawer: 1 }, '')
      pushed = true
    } catch (e) {
      pushed = false
    }
  }

  function dropHistory() {
    if (!pushed) return
    pushed = false
    if (history.state !== null && history.state.dshDrawer === 1) {
      selfBack = true
      history.back()
    }
  }

  window.addEventListener('popstate', function () {
    if (selfBack) {
      selfBack = false
      return
    }
    if (pushed) {
      pushed = false
      if (isOpen()) clickToggle()
    }
  })

  function openDrawer() {
    if (frame === null || isOpen()) return
    pushHistory()
    clickToggle()
  }

  function closeDrawer() {
    if (frame === null || !isOpen()) return
    dropHistory()
    clickToggle()
  }

  /* -- 4. Hamburger ---------------------------------------------------------
   * Replaces the rail's own toggle. `fixed` positioning comes from the CSS, so
   * this only has to live somewhere in the document and carry the icon. */
  function makeBurger() {
    var el = document.createElement('button')
    el.type = 'button'
    el.className = 'dsh-burger'
    el.setAttribute('aria-label', 'Open sidebar')
    el.setAttribute('aria-expanded', 'false')
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>'
    el.addEventListener('click', openDrawer)
    return el
  }

  /* -- 5. Sync -------------------------------------------------------------- */
  function syncScrim() {
    if (frame === null) return
    if (scrim === null) {
      scrim = document.createElement('div')
      scrim.setAttribute('data-dsh-drawer-scrim', '')
      scrim.addEventListener('click', closeDrawer)
    }
    var open = narrow.matches && isOpen()
    if (open && scrim.parentNode !== frame) frame.insertBefore(scrim, frame.firstChild)
    else if (!open && scrim.parentNode !== null) scrim.parentNode.removeChild(scrim)
  }

  function syncBurger() {
    if (burger === null) return
    var show = narrow.matches && !isOpen()
    if (burger.parentNode === null && show) document.body.appendChild(burger)
    burger.hidden = !show
    burger.setAttribute('aria-expanded', isOpen() ? 'true' : 'false')
  }

  function sync() {
    syncBurger()
    syncScrim()
  }

  /* -- 6. Dismiss on choosing something ------------------------------------
   * A Material modal navigation drawer closes once its item is selected. The
   * controls that must NOT dismiss it are the ones that only change what the
   * drawer itself is showing: its own collapse toggle, the search field, and
   * form fields. Everything else inside the drawer counts as a selection. */
  var KEEP_OPEN = [
    '[class*="toggle"]',
    '[class*="handle"]',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[aria-label="Search sessions"]',
    '[class*="searchInput"]',
    '[class*="searchField"]',
  ].join(',')

  function handleDrawerClick(event) {
    if (!narrow.matches || !isOpen()) return
    var sidebar = sidebarEl()
    var target = event.target
    if (sidebar === null || !(target instanceof Element) || !sidebar.contains(target)) return
    if (target.closest(KEEP_OPEN) !== null) return
    /* Let the app commit the selection first, then dismiss, so the user sees
     * the tap land rather than a drawer that vanished underneath it. */
    window.setTimeout(function () {
      if (isOpen()) closeDrawer()
    }, 120)
  }

  /* -- 7. Edge swipe to open, swipe-left to close --------------------------- */
  var touch = null

  function drawerWidth() {
    var sidebar = sidebarEl()
    return sidebar === null ? 320 : sidebar.getBoundingClientRect().width
  }

  document.addEventListener(
    'touchstart',
    function (event) {
      if (!narrow.matches || event.touches.length !== 1) {
        touch = null
        return
      }
      var t = event.touches[0]
      var open = isOpen()
      touch = {
        x: t.clientX,
        y: t.clientY,
        fromEdge: t.clientX <= EDGE,
        fromDrawer: open && t.clientX <= drawerWidth(),
      }
    },
    { passive: true },
  )

  document.addEventListener(
    'touchend',
    function (event) {
      if (touch === null) return
      var t = event.changedTouches[0]
      var dx = t.clientX - touch.x
      var dy = t.clientY - touch.y
      var start = touch
      touch = null
      /* Horizontal intent only, and past a deliberate threshold. */
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return
      if (dx > 0 && start.fromEdge && !isOpen()) openDrawer()
      else if (dx < 0 && start.fromDrawer && isOpen()) closeDrawer()
    },
    { passive: true },
  )

  /* -- 8. Attach ------------------------------------------------------------ */
  function attach() {
    var found = document.querySelector('[class*="frame"]')
    if (found === null) return false
    if (burger === null) burger = makeBurger()
    if (found !== frame) {
      if (observer !== null) observer.disconnect()
      if (frame !== null && onFrameClick !== null) frame.removeEventListener('click', onFrameClick, true)
      frame = found
      onFrameClick = handleDrawerClick
      /* Capture phase, so a selection is observed before React's own handler
       * swaps the view underneath it. */
      frame.addEventListener('click', onFrameClick, true)
      /* The one attribute that changes when the drawer opens or closes. */
      observer = new MutationObserver(sync)
      observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    }
    sync()
    return true
  }

  if (narrow.addEventListener) narrow.addEventListener('change', sync)

  /* The shell is client-rendered well after this runs; poll briefly for it,
   * then stop. Not on any hot path. */
  if (!attach()) {
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      if (attach() || tries > 80) clearInterval(timer)
    }, 100)
  }
})()
