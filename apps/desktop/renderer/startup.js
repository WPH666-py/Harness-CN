/** Startup window: the looping clip, its captions, and how far the launch has come. */

const api = window.dshDesktop

// The bar follows the shell's milestones rather than a clock, so it only ever reports work
// that finished. A launch has phases far longer than a frame, so the fill eases toward each
// reported target instead of jumping to it.
const EASING_PER_FRAME = 0.09

let target = 0
let shown = 0

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.startupWindowTitle
  document.querySelector('#title').textContent = messages.startupTitle
  document.querySelector('#subtitle').textContent = messages.startupSubtitle

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

  api.startup.subscribe((state) => {
    target = Math.min(1, Math.max(target, state.progress))
  })

  // Autoplay is muted and the window is not focused while the shell boots; a rejected play
  // would otherwise leave a still frame, so the clip is nudged once it can decode.
  const clip = document.querySelector('#clip')
  clip.addEventListener('canplay', () => { void clip.play().catch(() => undefined) })
  void clip.play().catch(() => undefined)
}

void main()
