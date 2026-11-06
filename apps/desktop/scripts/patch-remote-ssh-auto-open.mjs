/**
 * Keep the remote workspace panel from opening on its own.
 *
 * The shipped header action opens its dialog from `selectHost`, the function that runs when the user
 * picks a server from the session header's server menu: after resetting the view state it calls
 * `setOpen(true)`. That menu is how a host is connected, switched, or activated, so every one of
 * those gestures mounts the panel over the conversation (host header, file, terminal and changes
 * tabs, and an explorer tree with a file filter box), and closing it by hand is the only way back
 * to the session.
 *
 * This module drops that one write. `open` starts false and `selectHost` is its only writer of
 * true (`close` writes false), so removing the call leaves the dialog unmounted for the life of the
 * action. The panel markup stays where it is on purpose: the explorer-tree patch anchors inside it,
 * and the plugin's Host routes and tools are untouched.
 *
 * The authored source is rewritten first, then the plugin's own `scripts/build-client.js` runs,
 * because `client.js` embeds each source as an escaped string literal: editing the source alone
 * changes nothing the browser runs, and hand-editing the bundle would be undone by the next build.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The plugin package, relative to the tree's node_modules directory. */
const PACKAGE = 'dsh-remote-ssh-ops'

/** Authored action source; the bundle embeds it, so the source is the thing to edit. */
const WORKSPACE = join(PACKAGE, 'src', 'plugin', 'client', 'workspace.js')

/** The generated bundle the browser actually loads. */
const CLIENT = join(PACKAGE, 'src', 'plugin', 'client.js')

/** The plugin's own bundle generator; it strips `export` and re-escapes each source. */
const BUILD = join(PACKAGE, 'scripts', 'build-client.js')

/** Present in every patched file, so a re-run and a verification agree on what "patched" means. */
const MARKER = 'remoteWorkspace__keepClosed'

/** The call this patch removes; also the evidence that a bundle still opens the panel by itself. */
const AUTO_OPEN = 'setOpen(true)'

/**
 * One exact source edit: `from` must occur once, and the result must contain `MARKER`.
 * @type {readonly {file: string, from: string, to: string}[]}
 */
const EDITS = [
  {
    file: WORKSPACE,
    from: `      setView('files')
      setOpen(true)
      setMenuOpen(false)
`,
    to: `      setView('files')
      // ${MARKER}: picking a server only makes it current. Opening the panel here is what covered
      // the session on every connect, so the dialog stays unmounted; the Host routes and tools this
      // plugin registers keep working.
      setMenuOpen(false)
`,
  },
]

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
 * Regenerate `client.js` from the patched sources with the plugin's own generator.
 * @param nodeModules - the tree's `node_modules` directory.
 */
function buildClient(nodeModules) {
  const script = join(nodeModules, BUILD)
  if (!existsSync(script)) {
    throw new Error(`desktop seed: ${script} is missing; the remote workspace bundle cannot be regenerated`)
  }
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`desktop seed: regenerating ${CLIENT} failed (exit ${String(result.status)}): ${result.stderr ?? ''}`)
  }
}

/**
 * Remove the panel's self-open from an installed tree and regenerate its bundle.
 *
 * A tree where the anchor is already replaced is left alone, so applying the seed twice is safe.
 * @param nodeModules - the tree's `node_modules` directory.
 * @returns the files this call rewrote, empty when nothing needed changing.
 */
export function patchRemoteSshAutoOpen(nodeModules) {
  const workspace = join(nodeModules, WORKSPACE)
  if (!existsSync(workspace)) return []
  const sources = new Map()
  const changed = []
  for (const edit of EDITS) {
    const file = join(nodeModules, edit.file)
    if (!sources.has(file)) sources.set(file, readSource(file))
    const source = sources.get(file)
    if (source.text.includes(edit.to)) continue
    const occurrences = source.text.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`${file}: expected exactly one anchor for the auto-open patch, found ${String(occurrences)}`)
    }
    source.text = source.text.replace(edit.from, edit.to)
    if (!changed.includes(file)) changed.push(file)
  }
  if (changed.length === 0) return []
  for (const [file, source] of sources) {
    writeFileSync(file, source.crlf ? source.text.replaceAll('\n', '\r\n') : source.text, 'utf8')
  }
  buildClient(nodeModules)
  return changed
}

/**
 * Require the closed panel in a tree the seed produced.
 * @param tree - the tree's `node_modules` directory.
 * @returns the files that carry the patch.
 */
export function verifyRemoteSshAutoOpen(tree) {
  const workspace = join(tree, WORKSPACE)
  if (!existsSync(workspace)) return []
  const files = [WORKSPACE, CLIENT].map((relative) => join(tree, relative))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(MARKER)) throw new Error(`desktop seed: ${file} lost the remote-ssh auto-open patch`)
    if (text.includes(AUTO_OPEN)) throw new Error(`desktop seed: ${file} still opens the remote workspace panel when a host is picked`)
  }
  return files
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-auto-open.mjs [--check] <node_modules>')
    process.exit(2)
  }
  const workspace = join(root, WORKSPACE)
  if (!existsSync(workspace)) report('remote-ssh-auto-open', root, 'absent', WORKSPACE)
  if (check) {
    const patched = [WORKSPACE, CLIENT].every((relative) => readFileSync(join(root, relative), 'utf8').includes(MARKER))
    if (patched) report('remote-ssh-auto-open', root, 'patched', [WORKSPACE, CLIENT].join(', '))
    const source = readFileSync(workspace, 'utf8').replaceAll('\r\n', '\n')
    report('remote-ssh-auto-open', root, source.includes(EDITS[0].from) ? 'pristine' : 'drifted', workspace)
  }
  const changed = patchRemoteSshAutoOpen(root)
  verifyRemoteSshAutoOpen(root)
  console.log(`remote-ssh auto-open: ${String(changed.length)} source file(s) updated`)
}
