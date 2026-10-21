/**
 * Adds the "plugins loading" pill, and reloads the page once the deferred plugins exist.
 *
 * A Harness-CN launch mounts the slow plugin host halves after the handshake so the conversation
 * paints first. Their client bundles are composed from the packages that are mounted at the moment
 * the page is rendered, so the first paint is missing those panels. This script closes that gap: it
 * polls the shell until the Host reports them mounted, then reloads exactly once — the shell hands
 * out that reload a single time per launch, so a second reload cannot happen.
 */
(() => {
  'use strict'

  /** Query interval while a launch is still mounting deferred plugins. */
  const POLL_MS = 900
  /** How long the pill waits before it admits the plugins are not arriving. */
  const GIVE_UP_MS = 120_000

  const started = Date.now()
  let pill = null
  let settled = false
  let interacted = false

  // A reload that lands while someone is typing, or in the middle of a streaming answer, costs more
  // than the missing panels are worth. Any input before the plugins are up turns the automatic
  // reload into a note the user can act on when they are ready.
  const noteInteraction = () => { interacted = true }
  for (const name of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
    window.addEventListener(name, noteInteraction, { capture: true, passive: true, once: true })
  }

  /** Show the pill in the corner the shell's own chrome does not use. */
  function showPill() {
    if (pill !== null || document.body === null) return
    pill = document.createElement('div')
    pill.id = 'hcn-deferred-pill'
    pill.setAttribute('role', 'status')
    pill.textContent = '插件加载中…'
    pill.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483000',
      'padding:6px 12px',
      'border-radius:999px',
      'font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif',
      'color:#374151',
      'background:rgba(255,255,255,.94)',
      'border:1px solid rgba(0,0,0,.08)',
      'box-shadow:0 4px 16px rgba(0,0,0,.12)',
      'pointer-events:none',
      'transition:opacity .3s ease',
    ].join(';')
    document.body.appendChild(pill)
  }

  /** Say the plugins arrived without taking the page away from the user. */
  function noteReady() {
    if (pill === null) return
    pill.textContent = '插件已就绪，刷新页面即可看到'
  }

  /** Remove the pill, fading it out so it does not vanish mid-blink. */
  function hidePill() {
    if (pill === null) return
    const element = pill
    pill = null
    element.style.opacity = '0'
    setTimeout(() => element.remove(), 320)
  }

  /** Ask the shell once whether the deferred plugins are mounted yet. */
  async function poll() {
    if (settled) return
    let state
    try {
      const response = await fetch('/shell-api/deferred', { cache: 'no-store' })
      if (!response.ok) return
      state = await response.json()
    } catch {
      return
    }
    if (state.ready === true) {
      settled = true
      if (state.reload === true && !interacted) {
        // The shell answers `reload` once, so this cannot become a reload loop: the next load sees
        // the same `ready`, no fresh `reload`, and only hides the pill.
        location.reload()
        return
      }
      if (state.reload === true) noteReady()
      else hidePill()
      return
    }
    if (Date.now() - started > GIVE_UP_MS) {
      settled = true
      hidePill()
      return
    }
    setTimeout(poll, POLL_MS)
  }

  function start() {
    showPill()
    setTimeout(poll, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
