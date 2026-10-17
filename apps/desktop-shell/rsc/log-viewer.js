/** Run log viewer: the retained lines, live appends, and the actions that act on them. */

import { clearLogs, getLocale, getLogs, revealLogs, subscribeEvents } from './shell-api.js'

// Rows kept in the DOM. Matches the main-process ring so the two never disagree about
// how far back the viewer can scroll.
const RENDER_LIMIT = 2000

// How long one snapshot read may take, and how often the window tries again before it reports the
// failure. A read that never settles is the one failure the page cannot show on its own: without a
// deadline the labels appear, the list stays empty, and the window claims this run logged nothing.
const SNAPSHOT_TIMEOUT_MS = 5000
const SNAPSHOT_ATTEMPTS = 4
const SNAPSHOT_RETRY_DELAY_MS = 500

/** The snapshot the viewer last read, kept so the status line can still name the log file. */
let logFile = ''

// Failure notices above the list, kept by key so clearing a recovered retry cannot erase an
// unrelated failure that is still true.
const bootNotices = new Map()

let entries = []
let dropped = 0
let paused = false
let autoScroll = true
let filter = 'all'
let summaryFormat = ''
let sourceLabels = {}
let pauseLabel = ''
let resumeLabel = ''
let fallbackLabel = ''

function renderBootNotices() {
  const boot = document.querySelector('#boot')
  if (boot === null) return
  const text = [...bootNotices.values()].join('  ')
  boot.textContent = text
  boot.hidden = text === ''
}

/**
 * Report a failure where the user can see it.
 *
 * This page has one job — showing what the shell and the Host said — and a failure it swallows
 * looks exactly like a run that logged nothing. Every step that can fail therefore says so, in the
 * same place, instead of leaving an empty list that means the opposite of what it appears to mean.
 * @param text - what failed, with whatever detail the failure carried.
 * @param key - which notice this is, so a later recovery clears only its own.
 */
function reportBootFailure(text, key = 'boot') {
  bootNotices.set(key, text)
  renderBootNotices()
}

/**
 * Take one notice back after the step that reported it has succeeded.
 * @param key - the notice to drop, exactly as `reportBootFailure` named it.
 */
function clearBootFailure(key) {
  bootNotices.delete(key)
  renderBootNotices()
}

/** The most specific message an unknown rejection carries. */
function messageOf(reason) {
  if (reason instanceof Error) return reason.message
  const nested = reason?.cause
  if (nested instanceof Error) return nested.message
  return String(reason)
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

function stamp(time) {
  const at = new Date(time)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
}

function matches(entry) {
  return filter === 'all' || entry.source === filter
}

function rowFor(entry) {
  const row = document.createElement('li')
  const time = document.createElement('span')
  time.className = 'log-time'
  time.textContent = stamp(entry.time)
  const source = document.createElement('span')
  source.className = 'log-source'
  source.dataset.source = entry.source
  source.textContent = sourceLabels[entry.source] ?? entry.source
  const text = document.createElement('span')
  text.className = 'log-text'
  // Log text is untrusted process output: it is always written as text, never as markup.
  text.textContent = entry.text
  row.append(time, source, text)
  return row
}

function listElement() {
  return document.querySelector('#entries')
}

function trimList(list) {
  while (list.childElementCount > RENDER_LIMIT) list.removeChild(list.firstElementChild)
}

function scrollIfFollowing(list) {
  if (autoScroll) list.scrollTop = list.scrollHeight
}

function merge(incoming) {
  const newest = entries.length === 0 ? 0 : entries[entries.length - 1].seq
  let added = []
  for (const entry of incoming) {
    if (entry.seq <= newest) continue
    entries.push(entry)
    added.push(entry)
  }
  if (entries.length > RENDER_LIMIT) entries = entries.slice(-RENDER_LIMIT)
  return added
}

function updateStatus() {
  const shown = listElement().childElementCount
  const template = summaryFormat === '' ? '{shown}/{total}' : summaryFormat
  const line = template
    .replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => ({
      shown: String(shown),
      total: String(entries.length),
      dropped: String(dropped),
    })[name] ?? placeholder)
  // The file is the one place these lines survive the process, so it is worth naming even when
  // the ring is empty: a reader who sees no lines here can go and look for them there.
  document.querySelector('#status').textContent = logFile === '' ? line : `${line}  ${logFile}`
  const empty = document.querySelector('#empty')
  empty.textContent = entries.length === 0 && fallbackLabel !== '' ? `${fallbackLabel}  ${logFile}` : ''
  empty.hidden = shown !== 0
}

function renderAll() {
  const list = listElement()
  const rows = []
  for (const entry of entries) {
    if (matches(entry)) rows.push(rowFor(entry))
  }
  list.replaceChildren(...rows.slice(-RENDER_LIMIT))
  scrollIfFollowing(list)
  updateStatus()
}

function applyIncoming(incoming) {
  const added = merge(incoming)
  if (paused || added.length === 0) {
    updateStatus()
    return
  }
  const list = listElement()
  for (const entry of added) {
    if (matches(entry)) list.append(rowFor(entry))
  }
  trimList(list)
  scrollIfFollowing(list)
  updateStatus()
}

function setPaused(next) {
  paused = next
  document.querySelector('#toggle').textContent = paused ? resumeLabel : pauseLabel
  if (!paused) renderAll()
  else updateStatus()
}

/** Reject after `ms`, so a request that never answers is reported instead of pending forever. */
function timeoutAfter(ms) {
  return new Promise((_resolve, reject) => {
    setTimeout(() => { reject(new Error(`读取运行日志超时（${String(ms)} 毫秒）`)) }, ms)
  })
}

/**
 * Read the snapshot, trying again while the read fails or never settles.
 * @returns the snapshot the shell reported.
 */
async function readSnapshot() {
  let failure
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await Promise.race([getLogs(), timeoutAfter(SNAPSHOT_TIMEOUT_MS)])
    } catch (error) {
      failure = error
      if (attempt + 1 < SNAPSHOT_ATTEMPTS) {
        reportBootFailure(
          `读取运行日志失败，正在重试（已试 ${String(attempt + 1)} 次）：${messageOf(error)}`,
          'snapshot',
        )
        await new Promise((resolve) => { setTimeout(resolve, SNAPSHOT_RETRY_DELAY_MS * (attempt + 1)) })
      }
    }
  }
  throw failure
}

/**
 * Write every label the window shows from the interface text the shell answered with.
 * @param locale - the locale, with the message table the shell reported.
 */
function applyLocale(locale) {
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.logViewerTitle
  document.querySelector('#title').textContent = messages.logViewerTitle
  document.querySelector('#description').textContent = messages.logViewerDescription
  document.querySelector('#source-label').textContent = messages.logSourceLabel
  document.querySelector('#follow-label').textContent = messages.logFollow
  document.querySelector('#reveal').textContent = messages.logReveal
  document.querySelector('#clear').textContent = messages.logClear
  summaryFormat = messages.logSummary
  fallbackLabel = messages.logEmpty

  sourceLabels = {
    shell: messages.logSourceShell,
    'host-out': messages.logSourceHostOut,
    'host-err': messages.logSourceHostErr,
  }
  pauseLabel = messages.logPause
  resumeLabel = messages.logResume
  const options = {
    all: messages.logSourceAll,
    'host-out': messages.logSourceHostOut,
    'host-err': messages.logSourceHostErr,
    shell: messages.logSourceShell,
  }
  for (const option of document.querySelectorAll('#source option')) {
    option.textContent = options[option.value] ?? option.value
  }
  document.querySelector('#toggle').textContent = messages.logPause
}

/**
 * Read the interface text, with the same deadline as the snapshot.
 *
 * This read comes before everything else the window does, and the boot guard has already stood
 * down by then (the module announced itself on its first line), so a read that never settles
 * would leave the labels unwritten and the list empty with nobody left to report it. Timing out
 * keeps the page's own built-in labels and moves on to the snapshot.
 * @returns the locale, or undefined when the shell did not answer in time.
 */
async function readLocale() {
  try {
    return await Promise.race([getLocale(), timeoutAfter(SNAPSHOT_TIMEOUT_MS)])
  } catch (error) {
    reportBootFailure(`界面文字读取失败，已用页面自带的文字继续：${messageOf(error)}`, 'locale')
    return undefined
  }
}

async function main() {
  // The boot guard stops waiting the moment this runs, so a module that starts is never reported as
  // one that did not.
  window.__dshLogViewerStarted = true

  const locale = await readLocale()
  // A stalled interface-text read keeps the page's own built-in labels; the window still goes on to
  // show the log rather than nothing at all.
  if (locale !== undefined) applyLocale(locale)

  // The snapshot is read before the live stream is attached. Both are requests to the same
  // loopback origin, and a browser holds only a few connections per origin: the stream is
  // long-lived, so attaching it first can take the slot the snapshot needs and leave the window
  // showing nothing while it waits. Reading first makes the list independent of that budget, and
  // `merge` drops anything the snapshot already carried when the stream then replays it.
  const snapshot = await readSnapshot()
  entries = []
  dropped = snapshot.dropped
  logFile = snapshot.file
  merge(snapshot.entries)
  renderAll()
  // The list is on screen, so a notice about retrying the read has served its purpose.
  clearBootFailure('snapshot')

  let liveAttached = false
  try {
    subscribeEvents({
      logs: (update) => {
        dropped = update.dropped
        applyIncoming(update.entries)
      },
    })
    liveAttached = true
  } catch (error) {
    reportBootFailure(`实时日志流不可用，仅显示已读取的记录：${messageOf(error)}`)
  }
  if (!liveAttached) updateStatus()

  document.querySelector('#source').addEventListener('change', (event) => {
    filter = event.target.value
    renderAll()
  })
  document.querySelector('#toggle').addEventListener('click', () => { setPaused(!paused) })
  document.querySelector('#follow').addEventListener('change', (event) => {
    autoScroll = event.target.checked
    if (autoScroll) scrollIfFollowing(listElement())
  })
  document.querySelector('#reveal').addEventListener('click', () => { void revealLogs() })
  document.querySelector('#clear').addEventListener('click', () => {
    void clearLogs().then((cleared) => {
      entries = []
      dropped = cleared.dropped
      renderAll()
    }).catch((error) => { reportBootFailure(`清空失败：${messageOf(error)}`) })
  })
}

// Both handlers are attached before the first await: a rejection that arrives while `main` is still
// running would otherwise reach only the shell's own console, which is the window nobody has open
// when this window is the one that looks wrong.
window.addEventListener('unhandledrejection', (event) => {
  reportBootFailure(`日志页面脚本出错：${messageOf(event.reason)}`)
})
void main().catch((error) => {
  reportBootFailure(`日志页面无法读取运行日志：${messageOf(error)}`)
})
