/**
 * remoteSearch__route: search a remote host by file name.
 *
 * This module is the payload `patch-remote-ssh-search.mjs` writes into the remote-SSH plugin as
 * `src/controller/search.js`; it runs on the Host, not in the browser, so it must stay plain ESM
 * with no imports of its own.
 *
 * One search is one POSIX shell command. `rg --files` is the fast path when the host has ripgrep;
 * the fallback is `find -type f -name`, which every POSIX host has. Both branches match the
 * basename, so a query names a file rather than any path segment, and both stop one row past the
 * limit so the route can report truncation without walking further.
 */

/** Search roots are absolute POSIX paths; the filesystem root is the default. */
export const SEARCH_ROOT_DEFAULT = '/'

/** Most results one search may return. */
export const SEARCH_LIMIT_MAX = 200

/** Results per search when the caller does not ask for a count. */
export const SEARCH_LIMIT_DEFAULT = 100

/** Longest query accepted; a longer string cannot be one file name. */
export const SEARCH_QUERY_MAX = 200

/** A search may walk a whole filesystem, so it gets more room than a directory listing. */
export const SEARCH_TIMEOUT_MS = 15000

/** Largest stdout a search may produce: far more than the row limit needs. */
export const SEARCH_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Build a coded error the route's catch block maps to a status.
 * @param code - stable error code.
 * @param message - human readable text.
 * @returns the error.
 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Quote one value for a POSIX shell word.
 *
 * Single quotes keep every character literal; an embedded quote closes the word, adds an escaped
 * quote, and reopens it.
 * @param value - raw text.
 * @returns a single-quoted shell word.
 */
export function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

/**
 * Escape the characters `find -name` treats as pattern syntax, so the query matches literally.
 * @param text - raw query.
 * @returns the pattern body with `\`, `*`, `?` and `[` escaped.
 */
export function escapeFindName(text) {
  return String(text)
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('?', '\\?')
    .replaceAll('[', '\\[')
}

/**
 * Normalize a search root.
 *
 * A blank root is the filesystem root; a relative one is anchored at `/`; repeated and trailing
 * separators collapse. Control characters are refused because they would reach a shell word intact
 * but cannot appear in a real path.
 * @param root - requested root.
 * @returns the absolute POSIX root.
 */
export function normalizeSearchRoot(root) {
  const raw = String(root ?? '').trim()
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw codedError('SEARCH_ROOT_INVALID', '搜索根目录无效')
  const absolute = raw === '' ? SEARCH_ROOT_DEFAULT : raw.startsWith('/') ? raw : `/${raw}`
  const collapsed = absolute.replace(/\/{2,}/g, '/')
  if (collapsed.length === 1) return SEARCH_ROOT_DEFAULT
  return collapsed.replace(/\/+$/, '') || SEARCH_ROOT_DEFAULT
}

/**
 * Clamp a requested result count into the route's contract.
 * @param limit - requested count.
 * @returns an integer between 1 and {@link SEARCH_LIMIT_MAX}.
 */
export function normalizeSearchLimit(limit) {
  const value = Number(limit ?? SEARCH_LIMIT_DEFAULT)
  if (!Number.isFinite(value)) return SEARCH_LIMIT_DEFAULT
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(value)))
}

/**
 * Normalize a query: trimmed, non-empty, and free of control characters.
 *
 * A blank query is refused rather than treated as "everything": a search box that returns the whole
 * filesystem on an empty string is worse than one that returns nothing.
 * @param query - requested query.
 * @returns the trimmed query.
 */
export function normalizeSearchQuery(query) {
  const text = String(query ?? '').trim()
  if (text === '') throw codedError('SEARCH_QUERY_EMPTY', '搜索关键词不能为空')
  if (text.length > SEARCH_QUERY_MAX) throw codedError('SEARCH_QUERY_TOO_LONG', '搜索关键词过长')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw codedError('SEARCH_QUERY_INVALID', '搜索关键词无效')
  return text
}

/**
 * Normalize everything one search needs.
 * @param query - requested query.
 * @param options - requested root and limit.
 * @returns the normalized request, including the timeout and output cap the exec needs.
 */
export function normalizeSearchOptions(query, options = {}) {
  return {
    query: normalizeSearchQuery(query),
    root: normalizeSearchRoot(options.root),
    limit: normalizeSearchLimit(options.limit),
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES,
  }
}

/**
 * Build the shell command that lists matching files.
 *
 * The result is one command, not a script file: the SSH transport runs it on the host, and the
 * `rg` branch filters basenames in shell rather than with a glob so both branches answer the same
 * question.
 * @param request - normalized request.
 * @returns the command text.
 */
export function buildSearchCommand(request) {
  const limit = String(request.limit + 1)
  const query = quoteShell(request.query)
  const root = quoteShell(request.root)
  const pattern = quoteShell(`*${escapeFindName(request.query)}*`)
  return [
    `query=${query}`,
    'if command -v rg >/dev/null 2>&1; then',
    `  rg --files --hidden --no-ignore --no-messages -- ${root} 2>/dev/null | while IFS= read -r found; do`,
    '    case "${found##*/}" in',
    `      *"$query"*) printf '%s\\n' "$found" ;;`,
    '    esac',
    `  done | head -n ${limit}`,
    'else',
    `  find ${root} -type f -name ${pattern} 2>/dev/null | head -n ${limit}`,
    'fi',
  ].join('\n')
}

/**
 * Turn the command's stdout into route results.
 * @param stdout - captured output, one path per line.
 * @param limit - requested result count.
 * @param outputTruncated - the exec layer stopped capturing output.
 * @returns the results, the truncation flag, and nothing else the route does not answer.
 */
export function parseSearchOutput(stdout, limit, outputTruncated = false) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '')
  const unique = [...new Set(lines)]
  const truncated = outputTruncated || unique.length > limit
  const results = unique.slice(0, limit).map((path) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
  }))
  return { results, truncated }
}
