/** Startup window: the looping clip, its captions, and how far the launch has come. */

import { getLocale, subscribeEvents } from './shell-api.js'

// The bar follows the shell's milestones rather than a clock, so it only ever reports work
// that finished. A launch has phases far longer than a frame, so the fill eases toward each
// reported target instead of jumping to it.
const EASING_PER_FRAME = 0.09

// Shown when the page cannot read the locale at all. Every other word here is owned by the
// shell's dictionary, but a shell that never answered has no dictionary to offer, and an
// empty window would leave the failure invisible.
const CONNECTION_FAILED = '无法连接桌面外壳，请重新打开窗口。'

let target = 0
let shown = 0
let captioned = false
let lastNote = ''

/** Report a locale failure only while the shell has supplied no words of its own yet. */
function reportFailure() {
  if (captioned) return
  document.querySelector('#subtitle').textContent = CONNECTION_FAILED
}

async function main() {
  const locale = await getLocale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.startupWindowTitle
  document.querySelector('#title').textContent = messages.startupTitle
  document.querySelector('#subtitle').textContent = messages.startupSubtitle
  captioned = true

  const started = Date.now()
  const elapsed = document.querySelector('#elapsed')
  const track = document.querySelector('#track')
  const bar = document.querySelector('#bar')
  const renderElapsed = () => {
    const seconds = String(Math.round((Date.now() - started) / 1000))
    elapsed.textContent = messages.startupElapsed
      .replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => (name === 'seconds' ? seconds : placeholder))
  }
  renderElapsed()
  setInterval(renderElapsed, 1000)

  const paint = () => {
    shown += (target - shown) * EASING_PER_FRAME
    if (target - shown < 0.001) shown = target
    bar.style.transform = `scaleX(${shown.toFixed(4)})`
    track.setAttribute('aria-valuenow', String(Math.round(shown * 100)))
    requestAnimationFrame(paint)
  }
  requestAnimationFrame(paint)

  // The stream replays the current status on every connection, including a reconnect, so
  // the bar needs no initial fetch of its own to know where the launch stands.
  subscribeEvents({
    status: (state) => {
      target = Math.min(1, Math.max(target, state.progress))
      // The server names what it is doing whenever a step is long enough to need saying — the
      // first launch downloads the offline package, which takes longer than the rest of the
      // launch put together. An absent note clears the line rather than leaving a stale one.
      const note = typeof state.note === 'string' ? state.note : ''
      if (note !== lastNote) {
        lastNote = note
        document.querySelector('#note').textContent = note
      }
    },
  })

  // Autoplay is muted and the window is not focused while the shell boots; a rejected play
  // would otherwise leave a still frame, so the clip is nudged once it can decode.
  const clip = document.querySelector('#clip')
  clip.addEventListener('canplay', () => { void clip.play().catch(() => undefined) })
  void clip.play().catch(() => undefined)
}

void main().catch(reportFailure)
