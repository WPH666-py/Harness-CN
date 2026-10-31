/**
 * Patch the installed `dsh-voice-mode` host bundle so claiming focus for a Session the Host has not
 * registered yet stops answering 403.
 *
 * WHY THIS IS NOT CONFIGURATION. The plugin's `/voice-mode/focus` route tells the voice mini-window
 * which Session is in front. Its guard rejects any id that is not live in the Host SessionStore:
 *
 *     if (sessions && !sessions.get(sessionId)) {
 *       respondJson2(res, 403, { code: "unknown_session", error: "unknown session" });
 *       return;
 *     }
 *
 * The page posts that claim on mount and again on every visibility change, with the Session it is
 * rendering. Right after a profile is materialized the page is already showing a Session the Host
 * has not opened yet, so the first claim always misses and the browser logs a failed request
 * (`/voice-mode/focus … 403 (Forbidden)`) on every start; the plugin's own client calls this
 * situation "会话表滞后" and can only warn about it. The package exposes no setting for it — the only
 * option is `allowLan`, which relaxes a different guard — so the fix belongs in the bytes this
 * product's seed ships.
 *
 * The guard is rewritten to clear the focus claim and fall through to the route's normal tail, which
 * broadcasts the (empty) focus and answers 200. Nothing is lost: a Session that is not live cannot
 * receive voice output anyway, and the next visibility change or Session switch posts again and
 * lands once the Host knows the id. Only the focus route is touched — the voice-start guard keeps
 * its 403, because starting a recording for an unknown Session is a real error.
 *
 *   node scripts/patch-voice-mode-focus.mjs <node_modules directory>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** Package that owns the focus route. */
const PACKAGE = 'dsh-voice-mode'
/** Host bundle the sidecar loads for that package. */
const BUNDLE = join('lib', 'index.js')

/** Original guard inside the focus route, with the following claim for context. */
const BEFORE = [
  '          if (validSid) {',
  '            if (sessions && !sessions.get(sessionId)) {',
  '              respondJson2(res, 403, { code: "unknown_session", error: "unknown session" });',
  '              return;',
  '            }',
  '            focusedSessionId = sessionId;',
  '            focusedTabId = tabId;',
].join('\n')

/** Replacement, which drops the claim instead of rejecting the request. */
const AFTER = [
  '          if (validSid) {',
  '            if (sessions && !sessions.get(sessionId)) {',
  '              // The page can name a Session the Host has not opened yet (its table lags the page',
  '              // right after a profile is materialized). Focus is advisory: drop the claim and',
  '              // answer 200 below, so the Client does not log a rejected request on every start.',
  '              focusedSessionId = null;',
  '              focusedTabId = null;',
  '            } else {',
  '              focusedSessionId = sessionId;',
  '              focusedTabId = tabId;',
  '            }',
].join('\n')

/** Marker that only the patched route carries. */
const MARKER = 'focusedSessionId = null;\n              focusedTabId = null;\n            } else {'

/**
 * Report whether a bundle already carries the replacement.
 * @param source - bundle text.
 * @returns true when the focus route drops an unknown claim.
 */
export function hasFocusPatch(source) {
  return source.includes(MARKER) && !source.includes(BEFORE)
}

/**
 * Patch one tree.
 * @param root - `node_modules` directory of an installed profile or seed.
 * @returns a line describing what happened.
 */
export function patchVoiceModeFocus(root) {
  const target = join(root, PACKAGE, BUNDLE)
  if (!existsSync(target)) return `patch-voice-mode-focus: ${PACKAGE} not installed; nothing to patch`
  const source = readFileSync(target, 'utf8')
  if (hasFocusPatch(source)) return `patch-voice-mode-focus: ${PACKAGE} already patched`
  if (!source.includes(BEFORE)) {
    throw new Error(`patch-voice-mode-focus: ${target} does not contain the expected focus route; the plugin changed`)
  }
  const patched = source.replace(BEFORE, AFTER)
  writeFileSync(target, patched, 'utf8')
  const digest = createHash('sha256').update(patched).digest('hex')
  return `patch-voice-mode-focus: patched ${target} (${String(patched.length)} bytes, sha256 ${digest})`
}

/**
 * Require the patch in a tree the seed produced.
 *
 * Runs against the materialized profile, not the seed store, so a store archive that missed the
 * patch fails here instead of in a user's browser console.
 * @param root - materialized profile directory (contains `node_modules`).
 */
export function verifyVoiceModeFocus(root) {
  const target = join(root, 'node_modules', PACKAGE, BUNDLE)
  if (!existsSync(target)) return
  const source = readFileSync(target, 'utf8')
  if (!hasFocusPatch(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still answers 403 for a Session it has not opened (${target})`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) throw new Error('usage: patch-voice-mode-focus.mjs [--check] <node_modules directory>')
  if (check) {
    const target = join(root, PACKAGE, BUNDLE)
    if (!existsSync(target)) report('voice-mode-focus', root, 'absent', target)
    const source = readFileSync(target, 'utf8')
    if (hasFocusPatch(source)) report('voice-mode-focus', root, 'patched', target)
    if (source.includes(BEFORE)) report('voice-mode-focus', root, 'pristine', target)
    // Neither text is present: the plugin rewrote this route and the replacement has to be re-derived.
    report('voice-mode-focus', root, 'drifted', `neither the patched nor the original focus route is in ${target}`)
  }
  console.log(patchVoiceModeFocus(root))
}
