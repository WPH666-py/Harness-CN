/**
 * Keep the QQ console reachable from the shell's own menu.
 *
 * The shell opens the console as `/?panel=qq-console` and hides every other element on the page, then
 * calls `window.__qqbotOpenConsole()` to expand the plugin's dock panel. The shipped plugin has no
 * such entry point — its panel only opens from the floating ball — so without this patch the window is
 * a blank page: everything hidden, nothing asking the panel to open. The ball itself is hidden for the
 * same reason it is replaced: it floats over the workspace with no way to remove it.
 *
 * The patch is text-level because the plugin ships a built client bundle. A version whose anchor is
 * absent is left untouched and reported, never half-patched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Client bundle that owns the dock. */
const CLIENT = join('@zaofan', 'dsh-qqbot', 'client', 'qqbot-settings.js')

/** Line the hook is attached to. */
const ANCHOR = "ball.addEventListener('click', togglePanel)"

/** Entry point the shell's console window calls. */
const HOOK = '__qqbotOpenConsole'

/** What the anchor is replaced with. */
const REPLACEMENT = `${ANCHOR}
      // The dock ball is replaced by the shell's own menu entry: the console is opened from there,
      // and a floating ball would sit on top of the workspace with no way to remove it.
      try { ball.style.display = 'none' } catch (eHide) {}
      try { if (wrap) wrap.style.display = 'none' } catch (eWrap) {}
      window.${HOOK} = function () { if (!open) togglePanel() }`

/**
 * Patch the installed client bundle.
 * @param nodeModules - the profile's node_modules directory.
 * @returns 'patched', 'already' or 'skipped' when the anchor is absent.
 */
export function patchQqbotConsole(nodeModules) {
  const file = join(nodeModules, CLIENT)
  if (!existsSync(file)) return 'skipped'
  const text = readFileSync(file, 'utf8')
  if (text.includes(HOOK)) return 'already'
  if (!text.includes(ANCHOR)) return 'skipped'
  const patched = text.split(ANCHOR).join(REPLACEMENT).split("ball.style.display = 'block'").join("ball.style.display = 'none'")
  writeFileSync(file, patched, 'utf8')
  return 'patched'
}

/**
 * Require the entry point in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 */
export function verifyQqbotConsole(tree) {
  const file = join(tree, CLIENT)
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (!text.includes(HOOK)) {
    throw new Error(`desktop seed: ${file} has no ${HOOK}; the QQ console window would open blank`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2]
  if (root === undefined) {
    console.error('usage: patch-qqbot-console.mjs <node_modules>')
    process.exit(2)
  }
  console.log(`qqbot console: ${patchQqbotConsole(root)}`)
}
