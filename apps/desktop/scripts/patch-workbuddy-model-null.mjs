/**
 * Patch the installed `dsh-workbuddy-connect` client bundle so a missing model selection is benign.
 *
 * WHY THIS IS NOT CONFIGURATION. The plugin registers a control in the conversation input row and
 * reads the directory's current model selection to decide which WorkBuddy card to show. That
 * snapshot is `null` before a model has been chosen, and the shipped bundle tests only for
 * `undefined`:
 *
 *     const card = selection === void 0 ? void 0 : cardVariantFor(selection.provider)
 *
 * so the first render of a session without a selection throws inside the slot, and the whole input
 * row's other controls are replaced by a crash notice. There is no setting that changes what the
 * snapshot contains; the fix belongs in the bytes the browser receives from this product's seed.
 *
 * The three sites are rewritten to `selection == null`, which covers both shapes, and the patch is
 * idempotent: a tree that already carries the guard is reported and left alone.
 *
 *   node scripts/patch-workbuddy-model-null.mjs <node_modules directory>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package that owns the crashing slot. */
const PACKAGE = 'dsh-workbuddy-connect'
/** Bundle the browser loads for that package. */
const BUNDLE = join('lib', 'client.js')

/** Original byte sequence, with the unguarded reads. */
const BEFORE = [
  '\t\t\tconst card = selection === void 0 ? void 0 : cardVariantFor(selection.provider);',
  '\t\t\tconst key = card === void 0 || selection === void 0 ? void 0 : `${card.id}:${selection.model}`;',
  '\t\t\treturn card === void 0 || selection === void 0 || key === void 0 ? null :',
].join('\n')

/** Replacement, guarded against `null` as well as `undefined`. */
const AFTER = [
  '\t\t\t// `current` is null before a model is chosen, not undefined; testing only for undefined',
  '\t\t\t// let the null through and the whole input slot crashed on `selection.provider`.',
  '\t\t\tconst card = selection == null ? void 0 : cardVariantFor(selection.provider);',
  '\t\t\tconst key = card === void 0 || selection == null ? void 0 : `${card.id}:${selection.model}`;',
  '\t\t\treturn card === void 0 || selection == null || key === void 0 ? null :',
].join('\n')

/**
 * Report whether a bundle already carries the guard.
 * @param source - bundle text.
 * @returns true when every guarded read is present.
 */
export function hasGuard(source) {
  return source.includes('selection == null ? void 0 : cardVariantFor(selection.provider)')
    && !source.includes(BEFORE)
}

/**
 * Patch one tree.
 * @param root - `node_modules` directory of an installed profile or seed.
 * @returns a line describing what happened.
 */
export function patchWorkBuddyModelNull(root) {
  const target = join(root, PACKAGE, BUNDLE)
  if (!existsSync(target)) return `patch-workbuddy-model-null: ${PACKAGE} not installed; nothing to patch`
  const source = readFileSync(target, 'utf8')
  if (hasGuard(source)) return `patch-workbuddy-model-null: ${PACKAGE} already guarded`
  if (!source.includes(BEFORE)) {
    throw new Error(`patch-workbuddy-model-null: ${target} does not contain the expected client code; the plugin changed`)
  }
  const patched = source.replace(BEFORE, AFTER)
  writeFileSync(target, patched, 'utf8')
  const digest = createHash('sha256').update(patched).digest('hex')
  return `patch-workbuddy-model-null: patched ${target} (${String(patched.length)} bytes, sha256 ${digest})`
}

/**
 * Require the guard in a tree the seed produced.
 *
 * Runs against the materialized profile, not the seed store, so a store archive that missed the
 * patch fails here instead of on a user's first render.
 * @param root - materialized profile directory (contains `node_modules`).
 */
export function verifyWorkBuddyModelNull(root) {
  const target = join(root, 'node_modules', PACKAGE, BUNDLE)
  if (!existsSync(target)) return
  const source = readFileSync(target, 'utf8')
  if (!hasGuard(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still crashes without a model selection (${target})`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: patch-workbuddy-model-null.mjs <node_modules directory>')
  console.log(patchWorkBuddyModelNull(root))
}
