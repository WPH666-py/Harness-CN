/** Same-origin JSON/SSE client for the desktop shell's local HTTP server. */

// Every control endpoint lives under this prefix on the origin that served the page, so
// the pages keep working under any mount prefix without knowing the bound port.
const PREFIX = '/shell-api'

/** An HTTP status the shell reported together with a message meant for the user. */
export class ShellApiError extends Error {
  /**
   * @param {string} message - localized sentence the shell sent in the error body.
   * @param {number} status - HTTP status that carried it.
   */
  constructor(message, status) {
    super(message)
    this.name = 'ShellApiError'
    this.status = status
  }
}

/**
 * Perform one shell request and decode its JSON answer.
 *
 * An error body carries a sentence the shell already localized, so it is surfaced as the
 * Error message unchanged. A status without a readable body still fails loudly rather
 * than handing a half-decoded value to the caller.
 * @param {string} path - endpoint below the shell prefix.
 * @param {object} [options] - fetch options; `json` supplies a JSON request body.
 * @returns {Promise<any>} the decoded response body.
 */
async function request(path, options = {}) {
  const { json, ...rest } = options
  const init = { ...rest }
  if (json !== undefined) {
    init.method = init.method ?? 'POST'
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(json)
  }
  const response = await fetch(`${PREFIX}${path}`, init)
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string' && body.error !== '') message = body.error
    } catch {
      // A body the shell could not encode as JSON keeps the status-derived message.
    }
    throw new ShellApiError(message, response.status)
  }
  if (response.status === 204) return undefined
  return response.json()
}

/** @returns {Promise<object>} the desktop locale, with `.id` and `.messages`. */
export function getLocale() {
  return request('/locale')
}

/** @returns {Promise<object>} how far the launch has come, as `{phase, progress, version, message?}`. */
export function getStatus() {
  return request('/status')
}

/** @returns {Promise<object>} every retained log line as a `DesktopLogSnapshot`. */
export function getLogs() {
  return request('/logs')
}

/** @returns {Promise<object>} the empty snapshot that remains after the ring is dropped. */
export function clearLogs() {
  return request('/logs/clear', { method: 'POST' })
}

/** @returns {Promise<object>} an empty object once the shell opened the log file. */
export function revealLogs() {
  return request('/logs/reveal', { method: 'POST' })
}

/** @returns {Promise<Array<object>>} the installed desktop plugins. */
export function listPlugins() {
  return request('/plugins')
}

/**
 * Install one plugin from an npm spec.
 * @param {string} spec - package spec, for example `@scope/plugin@1.2.3`.
 * @returns {Promise<object>} an empty object once the shell restarted its backend.
 */
export function addPlugin(spec) {
  return request('/plugins/add', { json: { spec } })
}

/**
 * Remove one installed plugin.
 * @param {string} name - package name to remove.
 * @returns {Promise<object>} an empty object once the shell restarted its backend.
 */
export function removePlugin(name) {
  return request('/plugins/remove', { json: { name } })
}

/**
 * Move one installed plugin to another version.
 * @param {string} name - package name to update.
 * @param {string} version - target version.
 * @returns {Promise<object>} an empty object once the shell restarted its backend.
 */
export function updatePlugin(name, version) {
  return request('/plugins/update', { json: { name, version } })
}

/** @returns {Promise<object>} the desktop release update state. */
export function getUpdateState() {
  return request('/updates')
}

/** @returns {Promise<object>} the update state after asking the release feed. */
export function checkUpdates() {
  return request('/updates/check', { method: 'POST' })
}

/** @returns {Promise<object>} the update state after the installer was handed the release. */
export function installUpdate() {
  return request('/updates/install', { method: 'POST' })
}

/**
 * Stop a download that is still running.
 *
 * The download's own request then rejects with its cancellation, so nothing is installed and the
 * partial file is removed by the shell before this answers.
 * @returns {Promise<{cancelled: boolean}>} whether a download was actually running.
 */
export function cancelUpdate() {
  return request('/updates/cancel', { method: 'POST' })
}

/**
 * Record one release the user chose not to install on this launch.
 * @param {string} version - release version being deferred.
 * @returns {Promise<object>} an empty object once the shell recorded it.
 */
export function skipUpdate(version) {
  return request('/updates/skip', { json: { version } })
}

/** @returns {Promise<object>} whether a credential is bound, as `{configured, source?}`. */
export function getApiKeyStatus() {
  return request('/api-key')
}

/**
 * Verify one key against DeepSeek and store it.
 * @param {string} key - the candidate API key.
 * @returns {Promise<object>} the credential state that resulted from the write.
 */
export function saveApiKey(key) {
  return request('/api-key', { json: { key } })
}

/** @returns {Promise<object>} an empty object once the shell recorded the deferral. */
export function deferApiKey() {
  return request('/api-key/defer', { method: 'POST' })
}

/** @returns {Promise<object>} an empty object; the shell exits before answering fully. */
export function quit() {
  return request('/quit', { method: 'POST' })
}

/**
 * Follow the shell's event stream.
 *
 * One EventSource carries all three channels. A dropped stream is reconnected by the
 * browser itself, and the server replays the current status on every connection, so the
 * handlers simply stay attached to the same source and no state is lost across a
 * reconnect. A payload that is not decodable JSON is ignored rather than thrown: an
 * exception inside a listener would otherwise leave the remaining channels silent.
 * @param {{status?: Function, logs?: Function, update?: Function}} handlers - callbacks for
 *   launch progress, appended log lines, and release update state; absent channels are skipped.
 * @returns {Function} unsubscribe, which closes the stream and detaches every handler.
 */
export function subscribeEvents(handlers) {
  const source = new EventSource(`${PREFIX}/events`)
  const { status, logs, update } = handlers
  const channels = [
    ['status', status],
    ['logs', logs],
    ['update', update],
  ]
  const listeners = []
  for (const [name, listener] of channels) {
    if (typeof listener !== 'function') continue
    const handler = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      listener(payload)
    }
    source.addEventListener(name, handler)
    listeners.push([name, handler])
  }
  return () => {
    for (const [name, handler] of listeners) source.removeEventListener(name, handler)
    listeners.length = 0
    source.close()
  }
}
