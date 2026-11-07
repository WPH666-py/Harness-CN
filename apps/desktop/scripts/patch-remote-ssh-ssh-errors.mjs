/**
 * Keep one dropped SSH connection from ending the whole desktop host.
 *
 * `openConnection` attached its failure handler with `connection.once('error', fail)`. The first
 * error settles the promise and `fail` returns early from then on, but the listener is already gone:
 * the next error the ssh2 client emits has no listener at all, and Node turns an unhandled `'error'`
 * event on an EventEmitter into an uncaught exception. That is how a routine protocol error
 * (`level: 'protocol'`, `fatal: true` — a server dropping an idle session, a NAT timeout, a flaky
 * link) killed the Host process and left the window reporting
 * `dsh desktop host is unavailable` for every request, file tree included.
 *
 * The fix keeps a listener for the life of the connection: before the promise settles it still
 * fails the call, and after that it closes the socket and returns. Nothing above can receive a
 * second answer, and nothing throws.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The plugin package, relative to the tree's node_modules directory. */
const PACKAGE = 'dsh-remote-ssh-ops'

/** The host-side connection module; it is imported directly, so no bundle step is involved. */
const SSH_CLIENT = join(PACKAGE, 'src', 'controller', 'ssh-client.js')

/** Present in the patched file, so a re-run and a verification agree on what "patched" means. */
const MARKER = 'remoteSsh__survivesErrors'

/** The single-attempt listener this patch replaces. */
const ONCE = `    connection.once('error', fail)`

/**
 * The replacement: a lasting listener that fails the call once and then only shuts the socket.
 * `fail` itself returns early once `settled`, so the settled branch here must not call it.
 */
const LASTING = `    // ${MARKER}: 'once' cost the whole Host. The first error settled the promise, and every later
    // one arrived with no listener, which Node escalates to an uncaught exception and an exit. The
    // listener now outlives the call: before settlement it fails it, after that it closes the socket.
    connection.on('error', (error) => {
      if (settled) {
        try { connection.end() } catch { /* the socket is already gone */ }
        return
      }
      fail(error)
    })`

/**
 * Read a file as LF text and remember the line endings it had.
 * @param file - absolute path to read.
 * @returns the normalized text and whether it used CRLF.
 */
function readSource(file) {
  const text = readFileSync(file, 'utf8')
  const crlf = text.includes('\r\n')
  return { text: crlf ? text.replaceAll('\r\n', '\n') : text, crlf }
}

/**
 * Replace the single-attempt listener in an installed tree.
 * @param nodeModules - the tree's `node_modules` directory.
 * @returns the files this call rewrote, empty when nothing needed changing.
 */
export function patchRemoteSshErrors(nodeModules) {
  const file = join(nodeModules, SSH_CLIENT)
  if (!existsSync(file)) return []
  const source = readSource(file)
  if (source.text.includes(MARKER)) return []
  const occurrences = source.text.split(ONCE).length - 1
  if (occurrences !== 1) {
    throw new Error(`${file}: expected exactly one anchor for the ssh error patch, found ${String(occurrences)}`)
  }
  source.text = source.text.replace(ONCE, LASTING)
  writeFileSync(file, source.crlf ? source.text.replaceAll('\n', '\r\n') : source.text, 'utf8')
  return [file]
}

/**
 * Require the lasting listener in a tree the seed produced.
 * @param tree - the tree's `node_modules` directory.
 * @returns the files that carry the patch.
 */
export function verifyRemoteSshErrors(tree) {
  const file = join(tree, SSH_CLIENT)
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (!text.includes(MARKER)) throw new Error(`desktop seed: ${file} lost the remote-ssh error patch`)
  if (text.includes(ONCE)) {
    throw new Error(`desktop seed: ${file} still attaches the ssh error handler with once(), so a second error ends the Host`)
  }
  return [file]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-ssh-errors.mjs [--check] <node_modules>')
    process.exit(2)
  }
  const file = join(root, SSH_CLIENT)
  if (!existsSync(file)) report('remote-ssh-errors', root, 'absent', SSH_CLIENT)
  if (check) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(MARKER)) report('remote-ssh-errors', root, 'patched', SSH_CLIENT)
    report('remote-ssh-errors', root, text.includes(ONCE) ? 'pristine' : 'drifted', SSH_CLIENT)
  }
  const changed = patchRemoteSshErrors(root)
  verifyRemoteSshErrors(root)
  console.log(`remote-ssh errors: ${String(changed.length)} source file(s) updated`)
}
