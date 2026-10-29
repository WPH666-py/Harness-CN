/**
 * Replace the remote-SSH server picker's misleading empty state.
 *
 * The plugin renders an empty host list with the text `正在加载服务器…`, so a machine with no server at
 * all looks like one that is still connecting. The text is replaced in the installed client bundles;
 * a bundle without it is left alone, so a newer plugin version is never corrupted by a patch written
 * against this one.
 *
 * The same module verifies a tree the seed produced, which is what makes the change survive every
 * profile materialized from that seed instead of living only in the tree it was applied to.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** Text the shipped bundle renders while it has no host to show. */
const FROM = '正在加载服务器…'

/** Text that says what the user is actually looking at. */
const TO = '还没有服务器：点上方「服务器」按钮，或到「设置 → 远程开发」里添加一台'

/**
 * Bundles that carry the server picker, relative to the package.
 *
 * `workspace.js` is the authored source and `client.js` is the bundle actually served; both carry
 * the string, and patching only one leaves the other to overwrite the change at runtime.
 */
const BUNDLES = [
  join('dsh-remote-ssh-ops', 'src', 'plugin', 'client', 'workspace.js'),
  join('dsh-remote-ssh-ops', 'src', 'plugin', 'client.js'),
]

/**
 * Patch every installed bundle that still carries the old text.
 * @param nodeModules - the profile's node_modules directory.
 * @returns the files that changed.
 */
export function patchRemoteSshEmptyState(nodeModules) {
  const changed = []
  for (const relative of BUNDLES) {
    const file = join(nodeModules, relative)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes(FROM)) continue
    writeFileSync(file, text.split(FROM).join(TO), 'utf8')
    changed.push(file)
  }
  return changed
}

/**
 * Require the replacement in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 * @returns the files that carry the new text.
 */
export function verifyRemoteSshEmptyState(tree) {
  const checked = []
  for (const relative of BUNDLES) {
    const file = join(tree, relative)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (text.includes(FROM)) {
      throw new Error(`desktop seed: ${file} still renders the loading text for an empty server list`)
    }
    if (!text.includes(TO)) {
      throw new Error(`desktop seed: ${file} lost the empty-state replacement`)
    }
    checked.push(file)
  }
  return checked
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-empty-state.mjs [--check] <node_modules>')
    process.exit(2)
  }
  if (check) {
    // Both bundles carry the text and `BUNDLES` lists them in loading order, so the state is the
    // union: any bundle still on the old text means the next seed build would leave the picker
    // claiming it is still connecting.
    const states = []
    for (const relative of BUNDLES) {
      const file = join(root, relative)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      if (text.includes(FROM)) states.push({ state: 'pristine', file })
      else if (text.includes(TO)) states.push({ state: 'patched', file })
      else states.push({ state: 'drifted', file })
    }
    if (states.length === 0) report('remote-ssh-empty-state', root, 'absent', BUNDLES.join(', '))
    const drifted = states.find((entry) => entry.state === 'drifted')
    if (drifted !== undefined) {
      report('remote-ssh-empty-state', root, 'drifted', `${drifted.file} carries neither the loading text nor the replacement`)
    }
    const pristine = states.find((entry) => entry.state === 'pristine')
    if (pristine !== undefined) report('remote-ssh-empty-state', root, 'pristine', pristine.file)
    report('remote-ssh-empty-state', root, 'patched', states.map((entry) => entry.file).join(', '))
  }
  const changed = patchRemoteSshEmptyState(root)
  console.log(`remote-ssh empty state: ${String(changed.length)} file(s) updated`)
}
