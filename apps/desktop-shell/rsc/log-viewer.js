/** Run log viewer: the retained lines, live appends, and the actions that act on them. */

import { clearLogs, getLocale, getLogs, revealLogs, subscribeEvents } from './shell-api.js'

// Rows kept in the DOM. Matches the main-process ring so the two never disagree about
// how far back the viewer can scroll.
const RENDER_LIMIT = 2000

/** The snapshot the viewer last read, kept so the status line can still name the log file. */
let logFile = ''

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

/**
 * Report a failure where the user can see it.
 *
 * This page has one job — showing what the shell and the Host said — and a failure it swallows
 * looks exactly like a run that logged nothing. Every step that can fail therefore says so, in the
 * same place, instead of leaving an empty list that means the opposite of what it appears to mean.
 * @param text - what failed, with whatever detail the failure carried.
 */
function reportBootFailure(text) {
  const boot = document.querySelector('#boot')
  if (boot === null) return
  boot.textContent = text
  boot.hidden = false
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

async function main() {
  // The boot guard stops waiting the moment this runs, so a module that starts is never reported as
  // one that did not.
  window.__dshLogViewerStarted = true

  const locale = await getLocale()
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

  // The snapshot is read on its own and first: it is what this window exists to show, and it has to
  // survive a live stream that cannot be opened. The stream is attached before the wiring below, so
  // a line arriving while the snapshot is read is kept — `merge` drops it by sequence number when
  // the snapshot turns out to carry it too.
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

  const snapshot = await getLogs()
  entries = []
  dropped = snapshot.dropped
  logFile = snapshot.file
  merge(snapshot.entries)
  renderAll()
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
