/**
 * Boot guard and fallback reader for the run log window.
 *
 * WHY THIS FILE EXISTS. Everything the window shows comes from `log-viewer.js`, a module. When that
 * module does not run — the WebView refuses it, the engine refuses its syntax, the control surface
 * refuses the read — the window still paints its own markup, and markup that says nothing reads as
 * "the run log is empty". That is the one report a diagnostic surface must never make, because it
 * points the reader at the run instead of at the window.
 *
 * It is a classic script rather than an inline one on purpose: the page's own Content-Security
 * Policy is `script-src 'self'`, which refuses inline script outright — an inline guard would be
 * blocked by the very policy it exists to compensate for, and the page would go back to failing
 * silently. It is also earlier than the module in document order, so it installs its handlers before
 * anything else can fail.
 *
 * It then paints the same lines itself when the module did not start. A viewer that can only fail
 * back to a blank box is one report short of useless.
 */

/** How long the module is given to prove it started before this reads the same endpoint. */
const FALLBACK_DELAY_MS = 2000

/** Longest the fallback waits for the control surface before it reports the wait as a failure. */
const REQUEST_TIMEOUT_MS = 8000

function element(id) {
  return document.getElementById(id)
}

/** Report a fact about this window where the reader is already looking. */
function report(text) {
  const boot = element('boot')
  if (boot === null) return
  boot.textContent = text
  boot.hidden = false
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

/** One line's arrival time, spelled the way the module spells it. */
function stamp(time) {
  const at = new Date(time)
  return `${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)}.${pad(at.getMilliseconds(), 3)}`
}

/** Paint one snapshot with the DOM alone, the way the module would. */
function paint(snapshot) {
  const list = element('entries')
  const status = element('status')
  const empty = element('empty')
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : []
  list.replaceChildren()
  for (const entry of entries) {
    const row = document.createElement('li')
    const time = document.createElement('span')
    time.className = 'log-time'
    time.textContent = stamp(entry.time)
    const source = document.createElement('span')
    source.className = 'log-source'
    source.dataset.source = entry.source
    source.textContent = entry.source
    const text = document.createElement('span')
    text.className = 'log-text'
    // Log text is untrusted process output: always written as text, never as markup.
    text.textContent = entry.text
    row.append(time, source, text)
    list.append(row)
  }
  list.scrollTop = list.scrollHeight
  const file = typeof snapshot.file === 'string' ? snapshot.file : ''
  status.textContent = `${String(entries.length)} 条记录${file === '' ? '' : `　${file}`}`
  empty.textContent = entries.length === 0 ? `暂无日志。${file === '' ? '' : `　${file}`}` : ''
  empty.hidden = entries.length !== 0
}

/** Whether the window's own module has taken over; if it has, this stays out of the way. */
function moduleIsRunning() {
  if (window.__dshLogViewerStarted === true) return true
  // `log-viewer.js` sets the title before it reads anything, so a populated title is the module's
  // own signature. A module that fetched but threw before that leaves neither signature behind,
  // which is exactly when the reader needs this fallback.
  return element('title').textContent !== ''
}

/** Read the endpoint this window exists for, and either paint it or say why it could not be read. */
async function readAndPaint() {
  if (moduleIsRunning()) return
  try {
    const response = await fetch('/shell-api/logs', {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = await response.text()
    if (!response.ok) {
      let detail = `HTTP ${String(response.status)}`
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed.error === 'string') detail = parsed.error
      } catch {
        // A body that is not JSON leaves the status as the whole explanation.
      }
      report(`日志页面脚本没有启动（模块未执行），控制面拒绝了读取：${detail}`)
      return
    }
    let snapshot
    try {
      snapshot = JSON.parse(body)
    } catch {
      report(`日志页面脚本没有启动（模块未执行），控制面返回的内容不是日志快照（HTTP ${String(response.status)}）。`)
      return
    }
    if (!Array.isArray(snapshot.entries)) {
      report(`日志页面脚本没有启动（模块未执行），控制面返回的快照没有记录字段（HTTP ${String(response.status)}）。`)
      return
    }
    report('日志页面脚本没有启动（模块未执行）；以下内容由页面内兜底读取器显示。窗口地址 ' + window.location.href)
    paint(snapshot)
    const reveal = element('reveal')
    const clear = element('clear')
    if (reveal.textContent === '') reveal.textContent = '打开日志文件位置'
    if (clear.textContent === '') clear.textContent = '清空'
    reveal.addEventListener('click', () => {
      void fetch('/shell-api/logs/reveal', { method: 'POST' }).catch(() => undefined)
    })
    clear.addEventListener('click', () => {
      void fetch('/shell-api/logs/clear', { method: 'POST' })
        .then(async () => await fetch('/shell-api/logs', { cache: 'no-store' }))
        .then(async (again) => { paint(await again.json()) })
        .catch((error) => { report(`清空失败：${error instanceof Error ? error.message : String(error)}`) })
    })
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    report(`日志页面脚本没有启动（模块未执行），且控制面无法访问：${note}　窗口地址 ${window.location.href}`)
  }
}

window.__dshLogViewerStarted = false
window.addEventListener('error', (event) => {
  const target = event.target
  if (target !== null && target !== window && target.tagName === 'SCRIPT') {
    report(`日志页面脚本加载失败：${target.src === '' ? '(inline)' : target.src}`)
    return
  }
  report(`日志页面脚本出错：${event.message === '' ? String(event.error ?? 'unknown') : event.message}`)
}, true)
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  report(`日志页面脚本出错：${reason instanceof Error ? reason.message : String(reason)}`)
})

function start() {
  window.setTimeout(() => { void readAndPaint() }, FALLBACK_DELAY_MS)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
