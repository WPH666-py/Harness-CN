/**
 * Give the remote-SSH Host a file-search route the workstation tree can call.
 *
 * The shipped plugin can list a directory and read a file, but it cannot answer "which files on this
 * server are called nginx?" without the browser walking the whole tree one request at a time. The
 * workstation tree puts a search box beside the server tree, so the Host needs one route that does
 * the walk where the filesystem is: `GET /hosts/:id/search`.
 *
 * This module rewrites the plugin's authored Host source in place. There is no bundle step on this
 * side — `host-api.js` and `src/controller/**` are plain ESM the Host loads directly — so the patch
 * is only bytes plus one new module, `src/controller/search.js`, whose source is
 * `lib/remote-ssh-search-payload.js`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The plugin package, relative to the tree's node_modules directory. */
const PACKAGE = 'dsh-remote-ssh-ops'

/** The Host's route table and request handler. */
const API = join(PACKAGE, 'src', 'host-api.js')

/** The Host's command runner, which owns every exec the plugin performs. */
const RUNNER = join(PACKAGE, 'src', 'controller', 'runner.js')

/** The search module this patch adds beside the runner. */
const SEARCH = join(PACKAGE, 'src', 'controller', 'search.js')

/** The authored source of {@link SEARCH}, read from this repository and copied verbatim. */
const PAYLOAD = new URL('./lib/remote-ssh-search-payload.js', import.meta.url)

/** Present in every file this patch writes, so a re-run and a verification agree on "patched". */
const MARKER = 'remoteSearch__route'

/**
 * One exact source edit: `from` must occur once, and the result must contain {@link MARKER}.
 */
const EDITS = [
  {
    file: API,
    from: "  if (method === 'GET' && files) return { name: 'files', hostId: decodeURIComponent(files[1]) }\n",
    to: "  if (method === 'GET' && files) return { name: 'files', hostId: decodeURIComponent(files[1]) }\n"
      + `  // ${MARKER}: the workstation tree searches a host through this route.\n`
      + '  const search = /^\\/hosts\\/([^/]+)\\/search$/.exec(pathname)\n'
      + "  if (method === 'GET' && search) return { name: 'search', hostId: decodeURIComponent(search[1]) }\n",
  },
  {
    file: API,
    from: '        json(res, 200, {\n'
      + '          host_id: result.hostId,\n'
      + '          path: result.path,\n'
      + '          entries: result.entries,\n'
      + '          ...(result.nextOffset !== undefined ? { next_offset: result.nextOffset } : {}),\n'
      + '        })\n'
      + '        return\n'
      + '      }\n',
    to: '        json(res, 200, {\n'
      + '          host_id: result.hostId,\n'
      + '          path: result.path,\n'
      + '          entries: result.entries,\n'
      + '          ...(result.nextOffset !== undefined ? { next_offset: result.nextOffset } : {}),\n'
      + '        })\n'
      + '        return\n'
      + '      }\n'
      + "      if (route.name === 'search') {\n"
      + "        const limit = pageInteger(url.searchParams, 'limit', 100, 1, 200)\n"
      + "        const result = await runner.searchFiles(route.hostId, url.searchParams.get('q') ?? '', {\n"
      + "          root: url.searchParams.get('root') || undefined,\n"
      + '          limit,\n'
      + '        })\n'
      + '        json(res, 200, {\n'
      + '          host_id: result.hostId,\n'
      + '          root: result.root,\n'
      + '          query: result.query,\n'
      + '          results: result.results,\n'
      + '          truncated: result.truncated,\n'
      + '        })\n'
      + '        return\n'
      + '      }\n',
  },
  {
    file: RUNNER,
    from: "import { readLocator as readStructuredLocator } from './locator-reader.js'\n",
    to: "import { readLocator as readStructuredLocator } from './locator-reader.js'\n"
      + `// ${MARKER}: search one host's files by name without recording a job.\n`
      + "import { buildSearchCommand, normalizeSearchOptions, parseSearchOutput } from './search.js'\n",
  },
  {
    file: RUNNER,
    from: "      return { hostId: target.hostId, path: remotePath || target.cwd || '.', entries, nextOffset: entries.nextOffset }\n"
      + '    },\n',
    to: "      return { hostId: target.hostId, path: remotePath || target.cwd || '.', entries, nextOffset: entries.nextOffset }\n"
      + '    },\n'
      + '    /**\n'
      + '     * Search one host for files whose basename contains a query.\n'
      + '     *\n'
      + '     * A search is a one-shot exec, not a job: it has no approval, no change record and no log,\n'
      + '     * so the runner talks to the client directly instead of going through the job path.\n'
      + '     * @param hostRef - host id or address.\n'
      + '     * @param query - text a file name must contain.\n'
      + '     * @param options - root path and result limit.\n'
      + '     * @returns the host id, the normalized request, and the matching files.\n'
      + '     */\n'
      + '    async searchFiles(hostRef, query, options = {}) {\n'
      + '      const target = resolveTarget(store, hostRef)\n'
      + '      const request = normalizeSearchOptions(query, options)\n'
      + "      if (String(target.os ?? '').toLowerCase().startsWith('win')) {\n"
      + "        throw codedError('SEARCH_UNSUPPORTED', '远程文件搜索暂不支持 Windows 主机')\n"
      + '      }\n'
      + '      const result = await client.exec(target, {\n'
      + '        command: buildSearchCommand(request),\n'
      + '        timeoutMs: request.timeoutMs,\n'
      + '        maxOutputBytes: request.maxOutputBytes,\n'
      + '        jobId: randomUUID(),\n'
      + '      })\n'
      + "      if (result.timedOut === true) throw codedError('SEARCH_TIMEOUT', '远程文件搜索超时')\n"
      + '      return {\n'
      + '        hostId: target.hostId,\n'
      + '        root: request.root,\n'
      + '        query: request.query,\n'
      + '        ...parseSearchOutput(result.stdout, request.limit, result.stdoutTruncated === true),\n'
      + '      }\n'
      + '    },\n',
  },
]

/** Every file this patch is responsible for. */
const FILES = [SEARCH, API, RUNNER]

/**
 * Read a source file as LF text, and report whether it used CRLF so the write can restore it.
 * @param file - absolute path.
 * @returns the normalized text and the original line ending.
 */
function readSource(file) {
  const text = readFileSync(file, 'utf8')
  const crlf = text.includes('\r\n')
  return { text: crlf ? text.replaceAll('\r\n', '\n') : text, crlf }
}

/**
 * Apply the search route to an installed plugin tree.
 * @param nodeModules - the profile's node_modules directory.
 * @returns the files this call rewrote or added.
 * @throws When the package is installed but its source no longer contains an anchor, because that
 * means the patch would silently stop applying instead of reporting that upstream changed.
 */
export function patchRemoteSshSearch(nodeModules) {
  const api = join(nodeModules, API)
  if (!existsSync(api)) return []
  if (readFileSync(api, 'utf8').includes(MARKER)) return []
  const sources = new Map()
  const changed = []
  for (const edit of EDITS) {
    const file = join(nodeModules, edit.file)
    if (!sources.has(file)) sources.set(file, readSource(file))
    const source = sources.get(file)
    const occurrences = source.text.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`${file}: expected exactly one anchor for the remote search patch, found ${String(occurrences)}`)
    }
    source.text = source.text.replace(edit.from, edit.to)
    if (!changed.includes(file)) changed.push(file)
  }
  for (const [file, source] of sources) {
    writeFileSync(file, source.crlf ? source.text.replaceAll('\n', '\r\n') : source.text, 'utf8')
  }
  const search = join(nodeModules, SEARCH)
  const payload = readFileSync(PAYLOAD, 'utf8')
  if (!existsSync(search) || readFileSync(search, 'utf8') !== payload) {
    writeFileSync(search, payload, 'utf8')
    changed.push(search)
  }
  return changed
}

/**
 * Require the patched search route in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 * @returns the files that carry the patch.
 * @throws When a file the route needs is missing or lost the patch.
 */
export function verifyRemoteSshSearch(tree) {
  const api = join(tree, API)
  if (!existsSync(api)) return []
  const files = FILES.map((relative) => join(tree, relative))
  for (const file of files) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(MARKER)) {
      throw new Error(`desktop seed: ${file} lost the remote search patch`)
    }
  }
  return files
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-search.mjs [--check] <node_modules>')
    process.exit(2)
  }
  if (!existsSync(join(root, API))) report('remote-ssh-search', root, 'absent', API)
  if (check) {
    const patched = FILES.every((relative) => {
      const file = join(root, relative)
      return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER)
    })
    if (patched) report('remote-ssh-search', root, 'patched', FILES.join(', '))
    const source = readFileSync(join(root, API), 'utf8').replaceAll('\r\n', '\n')
    const intact = EDITS.filter((edit) => edit.file === API).every((edit) => source.includes(edit.from))
    report('remote-ssh-search', root, intact ? 'pristine' : 'drifted', join(root, API))
  }
  const changed = patchRemoteSshSearch(root)
  verifyRemoteSshSearch(root)
  console.log(`remote-ssh search: ${String(changed.length)} source file(s) updated`)
}
