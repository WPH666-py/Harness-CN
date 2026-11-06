/**
 * Give the remote-SSH Host a way to make this machine current again.
 *
 * The server manager can make a host current (`POST /hosts/:id/use`), but nothing
 * unsets it: once a server is current the seat keeps showing it, and the only way
 * back to the local workspace is to remove the host entirely. The server page
 * needs one gesture that leaves without forgetting the connection, so this patch
 * adds `POST /hosts/current/leave`.
 *
 * There is no bundle step on the Host side — `host-api.js` and `src/controller/**`
 * are plain ESM the Host loads directly — so the patch is only bytes in two files.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The plugin package, relative to the tree's node_modules directory. */
const PACKAGE = 'dsh-remote-ssh-ops'

/** The Host's route table and request handler. */
const API = join(PACKAGE, 'src', 'host-api.js')

/** The Host's command runner, which owns the current-host choice. */
const RUNNER = join(PACKAGE, 'src', 'controller', 'runner.js')

/** Present in every file this patch writes, so a re-run and a verification agree on "patched". */
const MARKER = 'remoteLeave__route'

/** Every file this patch is responsible for. */
const FILES = [API, RUNNER]

/**
 * One exact source edit: `from` must occur once, and the result must contain {@link MARKER}.
 */
const EDITS = [
  {
    // The route table. Ahead of the `/hosts/:id/use` matcher so `current/leave`
    // never has to rely on the id patterns failing to match it first.
    file: API,
    from: "  const use = /^\\/hosts\\/([^/]+)\\/use$/.exec(pathname)\n",
    to: `  // ${MARKER}: the server page leaves through this route.\n`
      + "  if (method === 'POST' && pathname === '/hosts/current/leave') return { name: 'leave' }\n"
      + "  const use = /^\\/hosts\\/([^/]+)\\/use$/.exec(pathname)\n",
  },
  {
    // The handler, beside the one that makes a host current.
    file: API,
    from: "      if (route.name === 'use') {\n",
    to: `      // ${MARKER}: forget the current host without forgetting the connection.\n`
      + "      if (route.name === 'leave') {\n"
      + '        await runner.leaveCurrentHost()\n'
      + '        json(res, 200, { ok: true, current_host_id: null })\n'
      + '        return\n'
      + '      }\n'
      + "      if (route.name === 'use') {\n",
  },
  {
    // The runner method the handler calls. `store.setCurrentHost(null)` is the
    // shipped way to clear the choice; it persists the projection, so the next
    // poll of `/hosts` reports no current host.
    file: RUNNER,
    from: '    getCurrentHost() {\n      return store.getCurrentHost()\n    },\n',
    to: '    getCurrentHost() {\n      return store.getCurrentHost()\n    },\n'
      + `    /** ${MARKER}: make this machine current again, keeping every host entry. */\n`
      + '    async leaveCurrentHost() {\n'
      + '      await store.setCurrentHost(null)\n'
      + '    },\n',
  },
]

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
 * Apply the leave route to an installed plugin tree.
 * @param nodeModules - the profile's node_modules directory.
 * @returns the files this call rewrote.
 * @throws When the package is installed but its source no longer contains an anchor, because that
 * means the patch would silently stop applying instead of reporting that upstream changed.
 */
export function patchRemoteSshLeave(nodeModules) {
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
      throw new Error(`${file}: expected exactly one anchor for the remote leave patch, found ${String(occurrences)}`)
    }
    source.text = source.text.replace(edit.from, edit.to)
    if (!changed.includes(file)) changed.push(file)
  }
  for (const [file, source] of sources) {
    writeFileSync(file, source.crlf ? source.text.replaceAll('\n', '\r\n') : source.text, 'utf8')
  }
  return changed
}

/**
 * Require the leave route in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 * @returns the files that carry the patch.
 * @throws When a file the route needs is missing or lost the patch.
 */
export function verifyRemoteSshLeave(tree) {
  const api = join(tree, API)
  if (!existsSync(api)) return []
  const files = FILES.map((relative) => join(tree, relative))
  for (const file of files) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(MARKER)) {
      throw new Error(`desktop seed: ${file} lost the remote leave patch`)
    }
  }
  return files
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    report({ patch: 'remote-ssh-leave', state: 'skipped', detail: 'no node_modules directory given' })
  } else if (check) {
    const files = verifyRemoteSshLeave(root)
    report({ patch: 'remote-ssh-leave', state: files.length === 0 ? 'absent' : 'patched', detail: `${String(files.length)} file(s)` })
  } else {
    const changed = patchRemoteSshLeave(root)
    report({ patch: 'remote-ssh-leave', state: 'patched', detail: `${String(changed.length)} file(s) updated` })
  }
}
