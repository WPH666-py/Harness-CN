/**
 * Stop `dsh-workbuddy-connect` from announcing its own updates at launch.
 *
 * The shipped client starts a release check inside the plugin's mount effect, so every launch
 * fetches the plugin's GitHub releases and paints a 「发现新版本」 card over the workspace as soon as
 * one is newer. The card is unconditional there: its 「不再提醒」 marker lives in webview
 * localStorage, and the desktop shell serves the workspace from an OS-assigned loopback port, so
 * the origin (and with it that marker) changes on every launch.
 *
 * This patch keeps the check and the card, and moves the check behind a person's own click: the
 * mount effect no longer refreshes the store, the plugin's settings card grows a
 * 「检查更新」/「Check for updates」 row wired to the same force-refresh the card's recheck button
 * uses, and the card still appears when that check finds a newer release. Nothing is removed from
 * the feature; only the unsolicited launch-time presentation is.
 *
 * The published package carries no `scripts/build-client.js` and no source, so the installed
 * `lib/client.js` is what gets patched. Idempotent: a second run reports no changes, and a plugin
 * whose anchors moved fails loudly instead of silently dropping the suppression.
 *
 * Usage: node scripts/patch-workbuddy-update-notice.mjs <node_modules-dir> [--check]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

const PATCH = 'workbuddy-update-notice'
const PACKAGE = 'dsh-workbuddy-connect'
const BUNDLE = join('lib', 'client.js')
const PATCHED_MARKER = 't("updateCheckHeading")'

/** The mount effect's release check, with its line indentation captured for the removal. */
const MOUNT_CHECK = /\n(\t*)updater\.refresh\(\);\n/g
/** The plugin-item slot injection that has to hand the store to the card. */
const CARD_INJECT = /\n(\t*)inject: \(\) => \(\{\n(\t*)t,\n\2variant\n(\t*)\}\)/g
/** The card's signature. */
const CARD_SIGNATURE = 'function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT })'
/** The card's account heading, the anchor the update row is inserted after. */
const ACCOUNT_HEADING = /(\t+)\/\* @__PURE__ \*\/ \(0, react_jsx_runtime\.jsx\)\("h3", \{\n\1\tstyle: quotaTitleStyle,\n\1\tchildren: t\("accountHeading"\)\n\1\}\),/g
const EN_REFRESH = 'refresh: "Refresh",'
const ZH_REFRESH = 'refresh: "刷新",'
const EN_UPDATE_KEYS = ['checkUpdates: "Check for updates",', 'updateCheckHeading: "Plugin updates",']
const ZH_UPDATE_KEYS = ['checkUpdates: "检查更新",', 'updateCheckHeading: "插件更新",']

/**
 * The update row inserted into the plugin card: a heading and the button that runs the check.
 * @param pad - indentation of the sibling heading in the card body.
 */
function updateRow(pad) {
  return [
    `${pad}/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {`,
    `${pad}\tstyle: rowStyle$1,`,
    `${pad}\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {`,
    `${pad}\t\tstyle: bodyStyle$1,`,
    `${pad}\t\tchildren: t("updateCheckHeading")`,
    `${pad}\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {`,
    `${pad}\t\ttype: "button",`,
    `${pad}\t\tstyle: buttonStyle$2,`,
    `${pad}\t\tonClick: () => {`,
    `${pad}\t\t\tvoid updater?.refresh(true);`,
    `${pad}\t\t},`,
    `${pad}\t\tchildren: t("checkUpdates")`,
    `${pad}\t})]`,
    `${pad}}),`,
  ].join('\n')
}

function replaceOnce(source, pattern, replacement, what) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new Error(`desktop seed: ${what} matched ${matches.length} places in ${PACKAGE}; the plugin changed`)
  }
  return source.replace(pattern, replacement)
}

/**
 * Rewrite the installed client so the launch path checks nothing and the card owns the check.
 * @param source - `lib/client.js` contents.
 * @returns the rewritten module.
 */
export function patchClientSource(source) {
  let next = replaceOnce(source, MOUNT_CHECK, '\n', 'the mount-time release check')
  next = replaceOnce(
    next,
    CARD_INJECT,
    '\n$1inject: () => ({\n$2t,\n$2variant,\n$2updater\n$3})',
    'the plugin-card slot injection',
  )
  const signature = next.split(CARD_SIGNATURE).length - 1
  if (signature !== 1) {
    throw new Error(`desktop seed: the ${PACKAGE} card signature matched ${signature} places; the plugin changed`)
  }
  next = next.replace(CARD_SIGNATURE, 'function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT, updater })')
  next = replaceOnce(
    next,
    ACCOUNT_HEADING,
    (match, indent) => `${match}\n${updateRow(indent)}`,
    'the plugin card account heading',
  )
  const refreshed = next.split(EN_REFRESH).length - 1
  const refreshedZh = next.split(ZH_REFRESH).length - 1
  if (refreshed !== 1 || refreshedZh !== 1) {
    throw new Error(`desktop seed: the ${PACKAGE} locale dictionaries moved; the plugin changed`)
  }
  next = next.replace(EN_REFRESH, [EN_REFRESH, ...EN_UPDATE_KEYS.map((key) => `\t\t\t${key}`)].join('\n'))
  next = next.replace(ZH_REFRESH, [ZH_REFRESH, ...ZH_UPDATE_KEYS.map((key) => `\t\t\t${key}`)].join('\n'))
  return next
}

/** Whether an installed client already carries the suppression. */
export function hasUpdateNoticePatch(source) {
  return source.includes(PATCHED_MARKER)
}

/**
 * Patch the plugin inside a node_modules directory.
 * @param root - directory that contains the `dsh-workbuddy-connect` package.
 * @returns one line describing what happened.
 */
export function patchWorkBuddyUpdateNotice(root) {
  const target = join(root, PACKAGE, BUNDLE)
  if (!existsSync(target)) return `${target} is absent; nothing to patch`
  const source = readFileSync(target, 'utf8')
  if (hasUpdateNoticePatch(source)) return `already patched ${target}`
  const patched = patchClientSource(source)
  writeFileSync(target, patched)
  const digest = createHash('sha256').update(patched).digest('hex').slice(0, 16)
  return `patched ${target} (${patched.length} bytes, sha256 ${digest})`
}

/**
 * Fail when a materialized tree still announces plugin updates at launch.
 * @param root - materialized profile directory.
 */
export function verifyWorkBuddyUpdateNotice(root) {
  const target = join(root, 'node_modules', PACKAGE, BUNDLE)
  if (!existsSync(target)) {
    throw new Error(`desktop seed: ${PACKAGE} is not installed at ${target}`)
  }
  const source = readFileSync(target, 'utf8')
  if (!hasUpdateNoticePatch(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still checks for its own update at launch (${target})`)
  }
  if (/\n\t*updater\.refresh\(\);\n/.test(source)) {
    throw new Error(`desktop seed: ${PACKAGE} still refreshes its update store on mount (${target})`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2))
  const root = options.root
  if (root === undefined) {
    report(PATCH, '', 'drifted', 'usage: node scripts/patch-workbuddy-update-notice.mjs <node_modules-dir> [--check]')
  } else {
    const target = join(root, PACKAGE, BUNDLE)
    if (options.check) {
      if (!existsSync(target)) {
        report(PATCH, root, 'absent', `${target} is absent`)
      } else if (hasUpdateNoticePatch(readFileSync(target, 'utf8'))) {
        report(PATCH, root, 'patched', 'launch-time update check is suppressed')
      } else {
        report(PATCH, root, 'pristine', 'launch-time update check is still present')
      }
    } else {
      try {
        report(PATCH, root, 'patched', patchWorkBuddyUpdateNotice(root))
      } catch (error) {
        report(PATCH, root, 'drifted', error instanceof Error ? error.message : String(error))
      }
    }
  }
}
