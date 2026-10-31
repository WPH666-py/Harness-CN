/**
 * Turn the installed `dsh-course-assistant` composer dock into one button.
 *
 * WHY THIS IS NOT CONFIGURATION. The plugin registers a `conversation.composer.dock` slot whose
 * component renders a dimmed caption beside a link-styled button:
 *
 *     function Dock({ open }) {
 *       return h('div', { className: 'ca-dock' },
 *         h('span', null, '🎓 课程助手'),
 *         h('button', { onClick: open }, '打开面板 →'))
 *     }
 *
 * The caption and the button are unrelated pieces of the conversation footer, so the dock reads as
 * two broken fragments instead of one control. The package exposes no label, class or layout setting
 * — its `dsh.bundle.patch` adds composition entries, not markup — so the fix belongs in the bytes
 * this product's seed ships.
 *
 * The replacement keeps the `.ca-dock` wrapper, because the slot's own layout still applies to it,
 * drops the caption and labels the button 课程助手面板. The same bundle also carries the dock's CSS,
 * which renders that wrapper as a gapped row and the button as borderless text; both rules are
 * replaced so the wrapper no longer reserves a row and the button reads as a button. Every edit is
 * an exact string replacement against the bundle's own text, and a bundle that lost the anchors fails
 * loudly instead of shipping a half-patched dock.
 *
 *   node scripts/patch-course-assistant-dock.mjs <node_modules directory>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** Package that owns the dock. */
const PACKAGE = 'dsh-course-assistant'
/** Client bundle the Web host loads for that package. */
const BUNDLE = 'client.js'

/** Original dock component, including the caption and the bare link button. */
const BEFORE = [
  '    function Dock({ open }) {',
  '      return h(',
  "        'div',",
  "        { className: 'ca-dock' },",
  "        h('span', null, '🎓 课程助手'),",
  "        h('button', { onClick: open }, '打开面板 →'),",
  '      )',
  '    }',
].join('\n')

/** Replacement: the same wrapper around one labelled button. */
const AFTER = [
  '    function Dock({ open }) {',
  '      return h(',
  "        'div',",
  "        { className: 'ca-dock' },",
  "        h('button', { className: 'ca-dock-button', onClick: open }, '课程助手面板'),",
  '      )',
  '    }',
].join('\n')

/** Marker that only the patched dock carries. */
const MARKER = "h('button', { className: 'ca-dock-button', onClick: open }, '课程助手面板'),"

/** Original dock CSS: a gapped row with a borderless text button in it. */
const CSS_BEFORE = [
  '    .ca-dock{display:flex;align-items:center;gap:8px;font-size:11.5px;opacity:.9;padding:2px 0}',
  '    .ca-dock button{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11.5px;padding:0 4px}',
].join('\n')

/** Replacement CSS: the wrapper collapses to its one child, and the child is a bordered pill. */
const CSS_AFTER = [
  '    .ca-dock{display:inline-flex;align-items:center;gap:0;padding:0;background:none;border:0}',
  '    .ca-dock-button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);cursor:pointer;font-family:inherit;font-size:11.5px;line-height:1.4;padding:3px 10px;border-radius:999px}',
  '    .ca-dock-button:hover{background:var(--dsw-alias-bg-layer-2)}',
].join('\n')

/**
 * Report whether a bundle already carries the replacement.
 * @param source - bundle text.
 * @returns true when the dock is one labelled button and no stale dock CSS remains.
 */
export function hasCourseAssistantDockPatch(source) {
  return source.includes(MARKER) && !source.includes(BEFORE) && !source.includes(CSS_BEFORE)
}

/**
 * Patch one tree.
 * @param root - `node_modules` directory of an installed profile or seed.
 * @returns a line describing what happened.
 */
export function patchCourseAssistantDock(root) {
  const target = join(root, PACKAGE, BUNDLE)
  if (!existsSync(target)) return `patch-course-assistant-dock: ${PACKAGE} not installed; nothing to patch`
  const source = readFileSync(target, 'utf8')
  if (hasCourseAssistantDockPatch(source)) return `patch-course-assistant-dock: ${PACKAGE} already patched`
  // The bundle carries both halves of the dock, and an upgrade can rewrite either one. Refuse a tree
  // where neither half is recognisable: patching what is left would leave the caption behind.
  const hasDock = source.includes(BEFORE) || source.includes(MARKER)
  const hasCss = source.includes(CSS_BEFORE)
  if (!hasDock && !hasCss) {
    throw new Error(`patch-course-assistant-dock: ${target} does not contain the expected composer dock; the plugin changed`)
  }
  if (!hasDock) {
    throw new Error(`patch-course-assistant-dock: ${target} has dock CSS but no dock component; the plugin changed`)
  }
  const patched = source.replace(BEFORE, AFTER).replace(CSS_BEFORE, CSS_AFTER)
  writeFileSync(target, patched, 'utf8')
  const digest = createHash('sha256').update(patched).digest('hex')
  // The dock's own text is not ASCII, so report the size of the file written, not the length of the
  // string in UTF-16 code units.
  return `patch-course-assistant-dock: patched ${target} (${String(Buffer.byteLength(patched, 'utf8'))} bytes, sha256 ${digest})`
}

/**
 * Require the patch in a tree the seed produced.
 *
 * Runs against the materialized profile, not the seed store, so a store archive that missed the
 * patch fails here instead of in a user's conversation footer.
 * @param root - materialized profile directory (contains `node_modules`).
 */
export function verifyCourseAssistantDock(root) {
  const target = join(root, 'node_modules', PACKAGE, BUNDLE)
  if (!existsSync(target)) return
  const source = readFileSync(target, 'utf8')
  if (!hasCourseAssistantDockPatch(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still renders its dock as a caption beside a link (${target})`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) throw new Error('usage: patch-course-assistant-dock.mjs [--check] <node_modules directory>')
  if (check) {
    const target = join(root, PACKAGE, BUNDLE)
    if (!existsSync(target)) report('course-assistant-dock', root, 'absent', target)
    const source = readFileSync(target, 'utf8')
    if (hasCourseAssistantDockPatch(source)) report('course-assistant-dock', root, 'patched', target)
    // The component anchor is what decides whether the patch can apply at all: a bundle that kept the
    // dock CSS but rewrote the component is the case `patchCourseAssistantDock` refuses, so it must
    // not report `pristine` here.
    if (source.includes(BEFORE) || source.includes(MARKER)) report('course-assistant-dock', root, 'pristine', target)
    // Neither the component nor its CSS is recognisable: the plugin rewrote the dock and both
    // replacements have to be re-derived.
    report('course-assistant-dock', root, 'drifted', `neither the patched nor the original dock is in ${target}`)
  }
  console.log(patchCourseAssistantDock(root))
}
