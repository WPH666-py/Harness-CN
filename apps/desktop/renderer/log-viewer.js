const api = window.dshDesktop

// Rows kept in the DOM. Matches the main-process ring so the two never disagree about
// how far back the viewer can scroll.
const RENDER_LIMIT = 2000

let entries = []
let dropped = 0
let paused = false
let autoScroll = true
let filter = 'all'
let summaryFormat = ''
let sourceLabels = {}
let pauseLabel = ''
let resumeLabel = ''

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
  document.querySelector('#status').textContent = summaryFormat
    .replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => ({
      shown: String(shown),
      total: String(entries.length),
      dropped: String(dropped),
    })[name] ?? placeholder)
  document.querySelector('#empty').hidden = shown !== 0
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
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.logViewerTitle
  document.querySelector('#title').textContent = messages.logViewerTitle
  document.querySelector('#description').textContent = messages.logViewerDescription
  document.querySelector('#source-label').textContent = messages.logSourceLabel
  document.querySelector('#follow-label').textContent = messages.logFollow
  document.querySelector('#reveal').textContent = messages.logReveal
  document.querySelector('#clear').textContent = messages.logClear
  summaryFormat = messages.logSummary

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

  const snapshot = await api.logs.get()
  entries = []
  dropped = snapshot.dropped
  merge(snapshot.entries)
  renderAll()

  api.logs.subscribe((update) => {
    dropped = update.dropped
    applyIncoming(update.entries)
  })

  document.querySelector('#source').addEventListener('change', (event) => {
    filter = event.target.value
    renderAll()
  })
  document.querySelector('#toggle').addEventListener('click', () => { setPaused(!paused) })
  document.querySelector('#follow').addEventListener('change', (event) => {
    autoScroll = event.target.checked
    if (autoScroll) scrollIfFollowing(listElement())
  })
  document.querySelector('#reveal').addEventListener('click', () => { void api.logs.reveal() })
  document.querySelector('#clear').addEventListener('click', () => {
    void api.logs.clear().then((cleared) => {
      entries = []
      dropped = cleared.dropped
      renderAll()
    })
  })
}

void main()
