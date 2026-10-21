/* web-pwa — the client half of the installable app.
 *
 * Two jobs, both of which must run from an inline <head> script:
 *   1. keep <meta name="theme-color"> in step with the resolved app theme
 *   2. register the service worker that Chrome requires before it will install
 *
 * (The filename predates the second job. It is kept because the Cordis loader
 * caches row modules by URL, so renaming the reference in host.mjs would cost a
 * `dsh web` restart — and this file is read from disk on every index render, so
 * edits here need only a browser reload.)
 */
;(function () {
  'use strict'

  function start() {
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta === null || document.body === null) return

    var attempts = 0

    function sync() {
      // The mobile-shell layer paints body from --dsw-alias-bg-base, so the
      // resolved background here is the real shell colour in either theme.
      var bg = getComputedStyle(document.body).backgroundColor
      if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)') {
        meta.setAttribute('content', bg)
        return
      }
      // Transparent means the app has not painted <body> yet. In dark mode the
      // mutation below rescues us, but a light theme sets no <body> attribute
      // at all, so nothing would ever fire and the static dark default would
      // stick with a dark status bar over a white app. Retry on a budget.
      attempts += 1
      if (attempts < 40) window.setTimeout(sync, 100)
    }

    sync()
    // The app flips data-ds-dark-theme on <body> when the theme changes.
    new MutationObserver(sync).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    })
  }

  if (document.body === null) document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  // Chrome refuses to install an origin with no service worker, so this is what
  // makes the app installable at all. It caches nothing — see sw.js for why.
  // Registration failure is deliberately swallowed: the GUI works without it,
  // it just cannot be installed.
  if ('serviceWorker' in navigator) {
    // Registered immediately rather than on `load`: a `load` listener would
    // never fire if this script ever ran after the event, which would silently
    // cost installability with no visible symptom.
    navigator.serviceWorker.register('/dsh-pwa/sw.js', { scope: '/' }).catch(function () {})
  }
})()
