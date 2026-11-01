/**
 * Give the installed `dsh-course-assistant` panel a close button.
 *
 * WHY THIS IS NOT CONFIGURATION. The plugin registers itself as a `main` global panel whose header
 * renders 「课程助手」, a subtitle, and then 「历史」「清空」 — no control returns to the Conversation.
 * The plugin does own a close path: its dock opens the panel with the layout store
 * (`layout.selectPanel('course-assistant')`), and `selectPanel(null)` selects the Conversation again.
 * Nothing in the header reaches that, so a user who opens the panel can only leave it by navigating
 * to a session. The package exposes no slot, label, or header option — its `dsh.bundle.patch` adds
 * composition entries, not markup — so the fix belongs in the bytes this product's seed ships.
 *
 * The bundle is one factory, and `Panel` is declared ABOVE the `apply` that captures `ctx.layout`,
 * so the component cannot reach the service from where it is written. The `main` slot also hands its
 * components no props (`renderSlot('main', {})`), so the patch threads the callback through the
 * panel's own props instead: `apply` wraps the registration with the close callback it builds next
 * to `open`, and the header button calls the callback it receives. Every edit is an exact string
 * replacement against the bundle's own text, and a bundle that lost an anchor fails loudly instead
 * of shipping a header that still has no way out.
 *
 * The button carries its styling inline. The panel does inject its own `<style>` inside `ca-root`,
 * so `ca-btn` rules do reach this row — but inline declarations survive a host that drops the sheet,
 * and the dock patch established that class-only styling is not something to rely on here.
 *
 *   node scripts/patch-course-assistant-panel.mjs <node_modules directory>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** Package that owns the panel. */
const PACKAGE = 'dsh-course-assistant'
/** Client bundle the Web host loads for that package. */
const BUNDLE = 'client.js'

/**
 * `Panel`'s signature, which has to accept the close callback.
 *
 * The slot passes no props today, so the new parameter only ever holds what this patch threads in.
 */
const SIGNATURE_BEFORE = '    function Panel() {'
const SIGNATURE_AFTER = '    function Panel({ onClose }) {'

/** Last control of the header row: the 「清空」 button. */
const HEADER_BEFORE = "          h('button', { className: 'ca-btn small', onClick: reset, disabled: busy }, '清空'),"

/**
 * Replacement: 「清空」 followed by the close button.
 *
 * Inline style for the same reason the dock patch styles its button inline; the accessible name
 * carries the panel's own name because a bare 「×」 says nothing to a screen reader.
 */
const HEADER_AFTER = [
  HEADER_BEFORE,
  "          h('button', { 'aria-label': '关闭课程助手面板', title: '关闭', style: { alignItems: 'center', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1,#d9dee7)', borderRadius: '999px', color: 'var(--dsw-alias-label-secondary,#6b7280)', cursor: 'pointer', display: 'inline-flex', fontFamily: 'inherit', fontSize: '15px', height: '22px', justifyContent: 'center', lineHeight: '1', padding: '0', width: '22px' }, onClick: onClose }, '×'),",
].join('\n')

/** The `main` registration, which has to hand `Panel` the close callback. */
const ENTRIES_BEFORE = [
  '        const open = () => {',
  '          try {',
  "            layout?.selectPanel?.('course-assistant')",
  '          } catch {}',
  '        }',
  '        try {',
  "          off.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'course-assistant' }, Panel)))",
  '        } catch {}',
].join('\n')

/**
 * Replacement: the same open closure, the close closure beside it, and a registration that passes it.
 *
 * `selectPanel(null)` is the plugin's own exit — the symmetric call to the one that opened the panel
 * — and a re-applied plugin rebuilds both closures, so neither can outlive the layout it captured.
 */
const ENTRIES_AFTER = [
  '        const open = () => {',
  '          try {',
  "            layout?.selectPanel?.('course-assistant')",
  '          } catch {}',
  '        }',
  '        const close = () => {',
  '          try {',
  '            layout?.selectPanel?.(null)',
  '          } catch {}',
  '        }',
  '        try {',
  "          off.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'course-assistant' }, (props) => h(Panel, { ...props, onClose: close }))))",
  '        } catch {}',
].join('\n')

/** The complete patch: every replacement is an exact string against the shipped bundle. */
const EDITS = [
  { before: SIGNATURE_BEFORE, after: SIGNATURE_AFTER },
  { before: HEADER_BEFORE, after: HEADER_AFTER },
  { before: ENTRIES_BEFORE, after: ENTRIES_AFTER },
]

/**
 * Report whether a bundle already carries the replacement.
 * @param source - bundle text.
 * @returns true when the panel takes the close callback and the header renders the close button.
 */
export function hasCourseAssistantPanelPatch(source) {
  return EDITS.every((edit) => source.includes(edit.after))
}

/**
 * Patch one tree.
 * @param root - `node_modules` directory of an installed profile or seed.
 * @returns a line describing what happened.
 * @throws When the tree holds the plugin but one of the panel anchors is missing.
 */
export function patchCourseAssistantPanel(root) {
  const target = join(root, PACKAGE, BUNDLE)
  if (!existsSync(target)) return `patch-course-assistant-panel: ${PACKAGE} not installed; nothing to patch`
  const source = readFileSync(target, 'utf8')
  if (hasCourseAssistantPanelPatch(source)) return `patch-course-assistant-panel: ${PACKAGE} already patched`
  // Every anchor is required. An upgrade that kept the header but rewrote the registration would
  // otherwise leave a close button pointing at nothing, so check them all before writing.
  for (const edit of EDITS) {
    if (!source.includes(edit.before)) {
      throw new Error(`patch-course-assistant-panel: ${target} does not contain ${JSON.stringify(edit.before.trim())}; the plugin changed`)
    }
  }
  const patched = EDITS.reduce((text, edit) => text.replace(edit.before, edit.after), source)
  writeFileSync(target, patched, 'utf8')
  const digest = createHash('sha256').update(patched).digest('hex')
  // The panel's own text is not ASCII, so report the size of the file written, not the length of the
  // string in UTF-16 code units.
  return `patch-course-assistant-panel: patched ${target} (${String(Buffer.byteLength(patched, 'utf8'))} bytes, sha256 ${digest})`
}

/**
 * Require the close button in a tree the seed produced.
 *
 * Runs against the materialized profile, not the seed store, so a store archive that missed the
 * patch fails here instead of in a user's panel header.
 * @param root - materialized profile directory (contains `node_modules`).
 */
export function verifyCourseAssistantPanel(root) {
  const target = join(root, 'node_modules', PACKAGE, BUNDLE)
  if (!existsSync(target)) return
  const source = readFileSync(target, 'utf8')
  if (!hasCourseAssistantPanelPatch(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still renders its panel without a close button (${target})`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) throw new Error('usage: patch-course-assistant-panel.mjs [--check] <node_modules directory>')
  if (check) {
    const target = join(root, PACKAGE, BUNDLE)
    if (!existsSync(target)) report('course-assistant-panel', root, 'absent', target)
    const source = readFileSync(target, 'utf8')
    if (hasCourseAssistantPanelPatch(source)) report('course-assistant-panel', root, 'patched', target)
    // `pristine` means every anchor is intact. A tree that kept some of them is `drifted`, because
    // `patchCourseAssistantPanel` refuses that tree rather than applying the edits it happens to find.
    if (EDITS.every((edit) => source.includes(edit.before))) report('course-assistant-panel', root, 'pristine', target)
    report('course-assistant-panel', root, 'drifted', `neither the patched nor the original panel is in ${target}`)
  }
  console.log(patchCourseAssistantPanel(root))
}
