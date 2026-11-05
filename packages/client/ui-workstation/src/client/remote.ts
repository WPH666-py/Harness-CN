/**
 * The remote-SSH host the workstation follows, and the same-origin calls its
 * tree and viewer make.
 *
 * The plugin's Host half serves these routes from the page's own origin, so the
 * browser reaches them with plain `fetch`. Importing the plugin's client module
 * instead would make this package depend on another feature plugin's values,
 * which the client package rules forbid.
 *
 * Nothing here throws. A host that went away between two polls is an ordinary
 * state of this tree, so every call answers an outcome and the caller decides
 * what the user sees.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The plugin's host list, the source of "which server is current". */
const HOSTS_ROUTE = '/remote-ssh-ops/v1/hosts'

/** How often the open seat asks which host is current. */
export const REMOTE_POLL_INTERVAL_MS = 2_000

/** How long one request may take before it counts as a failure. */
export const REMOTE_TIMEOUT_MS = 4_000

/** The remote tree hangs from the filesystem root; a server has no Session cwd. */
export const REMOTE_ROOT = '/'

/** Directory listings stop here, the route's own ceiling. */
const REMOTE_LIST_LIMIT = 1000

/** Searches stop here, the route's own ceiling. */
const REMOTE_SEARCH_LIMIT = 200

/** One host as the tree needs it: an id to call with, a name to draw. */
export interface RemoteHost {
  /** The plugin's stable host id. */
  readonly hostId: string
  /** The host's display name, as the server manager shows it. */
  readonly displayName: string
}

/** Which host the server manager made current, and every host it knows. */
export interface RemoteHostsView {
  /** The host the tree follows, `null` while the seat browses the local workspace. */
  readonly currentHostId: string | null
  /** Every configured host. */
  readonly hosts: readonly RemoteHost[]
}

/** Nothing current, nothing known: the seat's state before the first answer. */
export const REMOTE_HOSTS_EMPTY: RemoteHostsView = { currentHostId: null, hosts: [] }

/** One call's failure, in the route's own vocabulary. */
export interface RemoteFailure {
  /** The route's error code, or a local one for transport and parsing failures. */
  readonly code: string
  /** What happened, in the words the failure line shows. */
  readonly message: string
}

/** One call's settlement. */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RemoteFailure }

/** One directory entry, as the plugin's SFTP listing reports it. */
export interface RemoteEntry {
  /** Basename. */
  readonly name: string
  /** Absolute POSIX path on the host. */
  readonly path: string
  /** Whether the row discloses children or opens in the viewer. */
  readonly type: 'file' | 'directory'
  /** Size in bytes when the listing reported one. */
  readonly size: number | null
}

/** One directory's contents on a host. */
export interface RemoteDirectory {
  /** The directory the listing was asked for. */
  readonly path: string
  /** Its entries, in the host's order. */
  readonly entries: readonly RemoteEntry[]
  /** The listing stopped at its page size, so the directory holds more. */
  readonly truncated: boolean
}

/** One file's text and the version a write must still agree with. */
export interface RemoteFile {
  /** Absolute POSIX path on the host. */
  readonly path: string
  /** The file's complete text. */
  readonly text: string
  /** The host's content version at the read; the next write echoes it. */
  readonly version: string | null
  /** Size in bytes at the read. */
  readonly size: number
}

/** One file whose name matched a search. */
export interface RemoteSearchHit {
  /** Absolute POSIX path on the host. */
  readonly path: string
  /** The file's basename. */
  readonly name: string
}

/** One search's answer. */
export interface RemoteSearchResult {
  /** Matching files, at most the route's limit. */
  readonly results: readonly RemoteSearchHit[]
  /** The walk stopped at its limit, so more files match. */
  readonly truncated: boolean
}

/** The calls the face performs; tests replace the whole set with a script. */
export interface RemoteFiles {
  /** List one directory on a host. */
  readonly list: (hostId: string, path: string) => Promise<RemoteOutcome<RemoteDirectory>>
  /** Read one file's text from a host. */
  readonly read: (hostId: string, path: string) => Promise<RemoteOutcome<RemoteFile>>
  /** Write one file's text back, guarded by the version the read reported. */
  readonly write: (
    hostId: string,
    path: string,
    text: string,
    version: string | null,
  ) => Promise<RemoteOutcome<{ readonly version: string | null }>>
  /** Search one root on a host for files whose name contains a query. */
  readonly search: (hostId: string, query: string, root: string) => Promise<RemoteOutcome<RemoteSearchResult>>
}

/**
 * Whether a parsed JSON body is an object with named members.
 * @param value - candidate value.
 * @returns whether the value may be read by key.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a string member, or the fallback.
 * @param value - member value.
 * @param fallback - value to use when the member is not a string.
 * @returns the member or the fallback.
 */
function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a finite number member, or the fallback.
 * @param value - member value.
 * @param fallback - value to use when the member is not a number.
 * @returns the member or the fallback.
 */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Turn a failed response into the failure line's message.
 * @param body - the parsed error body, when it was JSON.
 * @param status - the HTTP status.
 * @returns the route's code and message.
 */
function failureOf(body: unknown, status: number): RemoteFailure {
  if (!isRecord(body)) return { code: 'remote/http', message: `HTTP ${String(status)}` }
  return {
    code: stringOf(body.code, 'remote/http'),
    message: stringOf(body.error, `HTTP ${String(status)}`),
  }
}

/**
 * Perform one request against the plugin's routes and parse its JSON answer.
 *
 * The timeout is per request rather than per poll: a host that stops answering
 * makes this call fail instead of holding the tree in its loading state.
 * @param route - same-origin path, query included.
 * @param init - method and body.
 * @returns the parsed body, or the failure to show.
 */
async function request(route: string, init: RequestInit = {}): Promise<RemoteOutcome<unknown>> {
  let response: Response
  try {
    response = await fetch(route, {
      ...init,
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
    })
  } catch (cause) {
    return {
      ok: false,
      failure: { code: 'remote/unreachable', message: cause instanceof Error ? cause.message : String(cause) },
    }
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    // A body that ended early leaves the failure to the status below.
  }
  let body: unknown
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  if (!response.ok) return { ok: false, failure: failureOf(body, response.status) }
  if (body === null) return { ok: false, failure: { code: 'remote/unexpected', message: '服务器返回了空响应' } }
  return { ok: true, value: body }
}

/**
 * Build one host route.
 * @param hostId - the plugin's host id.
 * @param tail - the route below the host, leading `/` included.
 * @returns the encoded path.
 */
function hostRoute(hostId: string, tail: string): string {
  return `${HOSTS_ROUTE}/${encodeURIComponent(hostId)}${tail}`
}

/**
 * Ask the plugin which host is current.
 *
 * A malformed answer is a failure rather than an empty list: an empty list would
 * silently send the seat back to the local workspace.
 * @returns the current host and every known host.
 */
export async function fetchRemoteHosts(): Promise<RemoteOutcome<RemoteHostsView>> {
  const answer = await request(HOSTS_ROUTE)
  if (!answer.ok) return answer
  if (!isRecord(answer.value) || !Array.isArray(answer.value.hosts)) {
    return { ok: false, failure: { code: 'remote/unexpected', message: '服务器列表无法识别' } }
  }
  const hosts: RemoteHost[] = []
  for (const entry of answer.value.hosts) {
    if (!isRecord(entry)) continue
    const hostId = stringOf(entry.host_id, '')
    if (hostId === '') continue
    hosts.push({ hostId, displayName: stringOf(entry.display_name, hostId) })
  }
  const current = stringOf(answer.value.current_host_id, '')
  return { ok: true, value: { currentHostId: current === '' ? null : current, hosts } }
}

/**
 * List one directory on a host.
 * @param hostId - the plugin's host id.
 * @param path - absolute POSIX directory path.
 * @returns the directory's entries.
 */
export async function listRemoteFiles(hostId: string, path: string): Promise<RemoteOutcome<RemoteDirectory>> {
  const query = `?path=${encodeURIComponent(path)}&limit=${String(REMOTE_LIST_LIMIT)}`
  const answer = await request(hostRoute(hostId, `/files${query}`))
  if (!answer.ok) return answer
  if (!isRecord(answer.value) || !Array.isArray(answer.value.entries)) {
    return { ok: false, failure: { code: 'remote/unexpected', message: '目录内容无法识别' } }
  }
  const entries: RemoteEntry[] = []
  for (const entry of answer.value.entries) {
    if (!isRecord(entry)) continue
    const name = stringOf(entry.name, '')
    if (name === '') continue
    entries.push({
      name,
      path: stringOf(entry.path, `${path === REMOTE_ROOT ? '' : path}/${name}`),
      type: entry.type === 'directory' ? 'directory' : 'file',
      size: typeof entry.size === 'number' ? entry.size : null,
    })
  }
  return {
    ok: true,
    value: {
      path: stringOf(answer.value.path, path),
      entries,
      truncated: typeof answer.value.next_offset === 'number',
    },
  }
}

/**
 * Read one file's text from a host.
 * @param hostId - the plugin's host id.
 * @param path - absolute POSIX file path.
 * @returns the text and its version.
 */
export async function readRemoteFile(hostId: string, path: string): Promise<RemoteOutcome<RemoteFile>> {
  const answer = await request(hostRoute(hostId, `/file?path=${encodeURIComponent(path)}`))
  if (!answer.ok) return answer
  if (!isRecord(answer.value) || typeof answer.value.content !== 'string') {
    return { ok: false, failure: { code: 'remote/unexpected', message: '文件内容无法识别' } }
  }
  return {
    ok: true,
    value: {
      path: stringOf(answer.value.path, path),
      text: answer.value.content,
      version: typeof answer.value.version === 'string' ? answer.value.version : null,
      size: numberOf(answer.value.size, answer.value.content.length),
    },
  }
}

/**
 * Write one file's text back to a host.
 *
 * The version the read reported travels as `expected_version`, so a file that
 * someone else changed since the read is refused instead of overwritten; the
 * answer's new version keeps the tab writable without re-reading.
 * @param hostId - the plugin's host id.
 * @param path - absolute POSIX file path.
 * @param text - the complete buffer to write.
 * @param version - the version the read reported, `null` when unknown.
 * @returns the version the host now reports.
 */
export async function writeRemoteFile(
  hostId: string,
  path: string,
  text: string,
  version: string | null,
): Promise<RemoteOutcome<{ readonly version: string | null }>> {
  const answer = await request(hostRoute(hostId, '/file'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path,
      content: text,
      ...(version === null ? {} : { expected_version: version }),
    }),
  })
  if (!answer.ok) return answer
  if (!isRecord(answer.value)) {
    return { ok: false, failure: { code: 'remote/unexpected', message: '保存结果无法识别' } }
  }
  return {
    ok: true,
    value: { version: typeof answer.value.after_version === 'string' ? answer.value.after_version : null },
  }
}

/**
 * Search one root on a host for files whose name contains a query.
 * @param hostId - the plugin's host id.
 * @param query - text a file name must contain.
 * @param root - absolute POSIX directory to walk.
 * @returns matching files and whether the walk stopped short.
 */
export async function searchRemoteFiles(
  hostId: string,
  query: string,
  root: string,
): Promise<RemoteOutcome<RemoteSearchResult>> {
  const search = `?q=${encodeURIComponent(query)}&root=${encodeURIComponent(root)}&limit=${String(REMOTE_SEARCH_LIMIT)}`
  const answer = await request(hostRoute(hostId, `/search${search}`))
  if (!answer.ok) return answer
  if (!isRecord(answer.value) || !Array.isArray(answer.value.results)) {
    return { ok: false, failure: { code: 'remote/unexpected', message: '搜索结果无法识别' } }
  }
  const results: RemoteSearchHit[] = []
  for (const entry of answer.value.results) {
    if (!isRecord(entry)) continue
    const path = stringOf(entry.path, '')
    if (path === '') continue
    results.push({ path, name: stringOf(entry.name, path.slice(path.lastIndexOf('/') + 1)) })
  }
  return { ok: true, value: { results, truncated: answer.value.truncated === true } }
}

/** The real calls, as the face's default collaborators. */
export const REMOTE_FILES: RemoteFiles = {
  list: listRemoteFiles,
  read: readRemoteFile,
  write: writeRemoteFile,
  search: searchRemoteFiles,
}

/** A snapshot source over {@link RemoteHostsView}: a hook source and a handle. */
export interface RemoteHostsSource {
  /** The latest answer; {@link REMOTE_HOSTS_EMPTY} until one arrives. */
  getSnapshot(): RemoteHostsView
  /** Subscribe to answers; polling runs while at least one listener is attached. */
  subscribe(listener: () => void): () => void
  /** Stop polling for good. */
  dispose(): void
}

/** Collaborators of one polling source. */
export interface RemoteHostsOptions {
  /** Loads the host list; defaults to {@link fetchRemoteHosts}. */
  readonly load?: () => Promise<RemoteOutcome<RemoteHostsView>>
  /** Milliseconds between polls. */
  readonly intervalMs?: number
}

/**
 * Whether two answers would draw the same tree.
 *
 * The id and the names decide it: a poll that only re-reports the same hosts
 * must not re-render the seat every two seconds.
 * @param left - the snapshot on screen.
 * @param right - the newest answer.
 * @returns whether the answer can be dropped.
 */
function sameHosts(left: RemoteHostsView, right: RemoteHostsView): boolean {
  if (left.currentHostId !== right.currentHostId) return false
  if (left.hosts.length !== right.hosts.length) return false
  return left.hosts.every((host, at) => host.hostId === right.hosts[at]?.hostId
    && host.displayName === right.hosts[at]?.displayName)
}

/**
 * Start the host poller.
 *
 * Polling is driven by subscriptions, not by the plugin's lifetime: the seat is
 * the only reader, so the first component to mount starts the timer and the last
 * one to unmount stops it.
 * @param options - the loader and the cadence.
 * @returns the source the seat renders from.
 */
export function startRemoteHosts(options: RemoteHostsOptions = {}): RemoteHostsSource {
  const { load = fetchRemoteHosts, intervalMs = REMOTE_POLL_INTERVAL_MS } = options
  const view: SnapshotStore<RemoteHostsView> = createSnapshotStore<RemoteHostsView>(REMOTE_HOSTS_EMPTY)
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let inflight = false
  let disposed = false

  /**
   * Ask once, keeping the last answer when this one fails.
   *
   * A failed poll is silent by design: the server manager window is where a host
   * that went away is dealt with, and the tree must not flash an error every two
   * seconds while that happens.
   */
  const refresh = (): void => {
    if (disposed || inflight) return
    inflight = true
    void load().then((answer) => {
      inflight = false
      if (disposed || !answer.ok) return
      if (!sameHosts(view.getSnapshot(), answer.value)) view.set(answer.value)
    }, () => {
      // A loader that throws rather than answering is the same silent failure.
      inflight = false
    })
  }

  /**
   * Stop the timer.
   */
  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    getSnapshot: view.getSnapshot,
    subscribe: (listener) => {
      const off = view.subscribe(listener)
      subscribers += 1
      if (subscribers === 1 && !disposed) {
        refresh()
        timer = setInterval(refresh, intervalMs)
      }
      return () => {
        off()
        subscribers -= 1
        if (subscribers === 0) stop()
      }
    },
    dispose: () => {
      disposed = true
      stop()
    },
  }
}
