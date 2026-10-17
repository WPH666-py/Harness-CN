// Patch the dsh-mobile panel so the desktop shows one QR code and three controls.
//
// The published panel was built for a phone-first product: it offers a "generate and copy key"
// button, a second "copy pairing link" button, a "clear every device" button, an Android promo
// row, a LAN/remote tab strip, a diagnostics view, a trusted-network editor and a plugin update
// card. The QR code it can draw is hidden behind two of those buttons, so the one thing a user
// actually needs — point the phone's camera at the screen — is the hardest thing to reach.
//
// This patch keeps the three controls the desktop user needs, in this order:
//
//   1. refresh the QR code (the panel also fills it in by itself when it opens),
//   2. start/stop LAN access,
//   3. manage paired devices — every paired row already carries a revoke button, which this
//      patch relabels "delete" in Chinese so it reads like the action it performs.
//
// Everything else stays in the bundle (the code paths keep working) but is hidden with a style
// element inside the panel, which is cheaper and less brittle than deleting construction code:
// the update/remote/diagnostics code still runs, it just has no visible entry point.
//
// The panel copies the pairing link to the clipboard as a side effect of drawing the QR code.
// That is why the refresh button uses its own request instead of the stock handler: a denied
// clipboard permission would otherwise replace the QR status line with the raw link.
//
// Writing the file as a new file and renaming it over the old path is deliberate: pnpm
// hardlinks store entries into the profile, so editing in place would rewrite the store copy
// through the link while the recorded store index still described the old bytes.
//
// Usage: node scripts/patch-mobile-panel.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The browser bundle that builds the desktop control panel, relative to a node_modules root. */
const PANEL_PATH = join('dsh-mobile', 'lib', 'client.js')

/** Marks the patched file so a second run reports `already` instead of patching twice. */
const MARKER = 'DSH_MOBILE_PANEL_SIMPLIFY'

/** The panel's own labels, in the three locales it ships. */
const LABEL_ZH_FROM = '\t\t\tgenerateCopyKey: "生成并复制密钥",\n'
const LABEL_ZH_TO = `${LABEL_ZH_FROM}\t\t\trefreshQrCode: "刷新二维码",\n`

const LABEL_EN_FROM = '\t\t\t\tgenerateCopyKey: "Generate and copy key",\n'
const LABEL_EN_TO = `${LABEL_EN_FROM}\t\t\t\trefreshQrCode: "Refresh QR code",\n`

const LABEL_IT_FROM = '\t\t\t\tgenerateCopyKey: "Genera e copia chiave",\n'
const LABEL_IT_TO = `${LABEL_IT_FROM}\t\t\t\trefreshQrCode: "Aggiorna il codice QR",\n`

/** The revoke button on a paired device row; "delete" is what the user is actually doing. */
const REVOKE_FROM = '\t\t\trevoke: "撤销",'
const REVOKE_TO = '\t\t\trevoke: "删除",'

/** The panel is mounted here; the style element and the QR helpers hang off the same insertion. */
const MOUNT_FROM = '\t\t\troot.append(panel);\n'

const STYLE_RULES = [
  '.dsh-mobile-control__switcher,',
  '.dsh-mobile-control__app-download,',
  '.dsh-mobile-control__release-notice,',
  '.dsh-mobile-control__update-card,',
  '.dsh-mobile-control__extensions,',
  '.dsh-mobile-control__details,',
  '.dsh-mobile-control__view.is-remote,',
  '.dsh-mobile-control__view.is-diagnostics{display:none!important}',
  '.dsh-mobile-control__header-actions>:not(:last-child){display:none!important}',
  '.dsh-mobile-control__actions{display:flex;flex-wrap:wrap;gap:8px}',
  '.dsh-mobile-control__actions .dsh-mobile-control__primary+.dsh-mobile-control__secondary{display:none!important}',
  '.dsh-mobile-control__manage-row{grid-template-columns:1fr}',
  '.dsh-mobile-control__manage-row .dsh-mobile-control__manage+.dsh-mobile-control__manage{display:none!important}',
  '.dsh-mobile-control__qr{display:flex;justify-content:center;padding:8px 0}',
  '.dsh-mobile-control__qr img{width:176px;height:176px}',
  '.dsh-mobile-control__device{gap:8px}',
  '.dsh-mobile-control__device-revoke{margin-left:auto}',
].join('\n')

const MOUNT_TO = [
  MOUNT_FROM.trimEnd(),
  `\t\t\t/* ${MARKER}: one QR code, three controls. Everything else stays wired but hidden. */`,
  '\t\t\tconst simplifiedStyle = element("style");',
  `\t\t\tsimplifiedStyle.textContent = ${JSON.stringify(STYLE_RULES)};`,
  '\t\t\tpanel.append(simplifiedStyle);',
  '',
].join('\n')

/** The stock shortcut that copies a secret; the QR helper below replaces it. */
const OPEN_PAIRING_ANCHOR = '\t\t\tconst openPairing = (target) => {'

const QR_HELPERS = [
  `\t\t\t/* ${MARKER}: draw the code instead of copying a secret, and refresh it on demand. */`,
  '\t\t\tlet simplifiedQrAt = 0;',
  '\t\t\tlet simplifiedQrBusy = false;',
  '\t\t\tconst simplifiedShowQr = () => {',
  '\t\t\t\tif (!running || simplifiedQrBusy) return;',
  '\t\t\t\tsimplifiedQrBusy = true;',
  '\t\t\t\tcontrolRequestJson("/api/mobile-access/lan/pairing/open", {',
  '\t\t\t\t\tmethod: "POST",',
  '\t\t\t\t\tbody: "{}"',
  '\t\t\t\t}).then((data) => {',
  '\t\t\t\t\tshowQr(typeof data.qrSvg === "string" ? data.qrSvg : "");',
  '\t\t\t\t\tif (typeof data.qrSvg === "string" && data.qrSvg !== "") simplifiedQrAt = Date.now();',
  '\t\t\t\t}, (error) => {',
  '\t\t\t\t\tstatus.textContent = t("requestFailed", { error: String(error) });',
  '\t\t\t\t}).finally(() => {',
  '\t\t\t\t\tsimplifiedQrBusy = false;',
  '\t\t\t\t\tpair.disabled = !running;',
  '\t\t\t\t});',
  '\t\t\t};',
  '\t\t\tconst simplifiedRefreshQr = () => {',
  '\t\t\t\tif (panel.hidden) return;',
  '\t\t\t\t// A pairing window lasts ten minutes; refresh a little before it lapses.',
  '\t\t\t\tif (Date.now() - simplifiedQrAt < 9 * 6e4) return;',
  '\t\t\t\tsimplifiedShowQr();',
  '\t\t\t};',
  OPEN_PAIRING_ANCHOR,
].join('\n')

/** The two secret-copying buttons; only the QR one survives, rebound to the helper above. */
const PAIR_BUTTON_FROM = [
  '\t\t\tpair.addEventListener("click", () => {',
  '\t\t\t\tpair.disabled = true;',
  '\t\t\t\topenPairing("key");',
  '\t\t\t});',
  '\t\t\tlinkPair.addEventListener("click", () => {',
  '\t\t\t\tlinkPair.disabled = true;',
  '\t\t\t\topenPairing("link");',
  '\t\t\t});',
].join('\n')

const PAIR_BUTTON_TO = [
  '\t\t\tpair.textContent = t("refreshQrCode");',
  '\t\t\tpair.addEventListener("click", () => {',
  '\t\t\t\tpair.disabled = true;',
  '\t\t\t\tsimplifiedShowQr();',
  '\t\t\t});',
  '\t\t\tlinkPair.addEventListener("click", () => {',
  '\t\t\t\tlinkPair.disabled = true;',
  '\t\t\t\topenPairing("link");',
  '\t\t\t});',
  '\t\t\t// Opening the panel draws a fresh code without a click; the timer covers the mount',
  '\t\t\t// that happens while the panel is already visible.',
  '\t\t\tnew MutationObserver(() => {',
  '\t\t\t\tsimplifiedRefreshQr();',
  '\t\t\t}).observe(panel, { attributes: true, attributeFilter: ["hidden"] });',
  '\t\t\twindow.setTimeout(() => {',
  '\t\t\t\tsimplifiedRefreshQr();',
  '\t\t\t}, 800);',
].join('\n')

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

/** Apply one literal replacement and refuse to continue when the anchor is gone or ambiguous. */
function replaceOnce(file, source, from, to) {
  const index = source.indexOf(from)
  if (index === -1) {
    throw new Error(
      `${file} has no anchor (${from.split('\n')[0].trim()}); the bundle changed shape and the patch needs a new anchor`,
    )
  }
  if (source.includes(from, index + 1)) {
    throw new Error(`${file} has more than one anchor (${from.split('\n')[0].trim()}); the patch cannot pick one`)
  }
  return `${source.slice(0, index)}${to}${source.slice(index + from.length)}`
}

/** Apply every edit, then hand back the exact bytes that get published. */
function rewrite(before, file) {
  let after = before
  after = replaceOnce(file, after, LABEL_ZH_FROM, LABEL_ZH_TO)
  after = replaceOnce(file, after, LABEL_EN_FROM, LABEL_EN_TO)
  after = replaceOnce(file, after, LABEL_IT_FROM, LABEL_IT_TO)
  after = replaceOnce(file, after, REVOKE_FROM, REVOKE_TO)
  after = replaceOnce(file, after, MOUNT_FROM, MOUNT_TO)
  after = replaceOnce(file, after, OPEN_PAIRING_ANCHOR, QR_HELPERS)
  after = replaceOnce(file, after, PAIR_BUTTON_FROM, PAIR_BUTTON_TO)
  return after
}

/** Parse the patched bundle with Node before it is written over the installed one. */
function assertParses(file, source) {
  // A scratch file in the temp directory: the installed tree must not grow a second copy of
  // the bundle, and the copy is removed even when the check fails.
  const temporary = join(tmpdir(), `dsh-mobile-panel-${String(process.pid)}-${String(Date.now())}.js`)
  try {
    writeFileSync(temporary, source, 'utf8')
    const result = spawnSync(process.execPath, ['--check', temporary], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`${file} does not parse after patching:\n${result.stderr ?? ''}`)
    }
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // The check file is temporary; failing to remove it is not a patch failure.
    }
  }
}

/** The markers every patched bundle must carry, in order of what breaks first. */
const MARKERS = [MARKER, 'refreshQrCode', 'simplifiedShowQr', 'simplifiedStyle']

export function patchMobilePanel(root) {
  const file = join(root, PANEL_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER)) {
    return { root, status: 'already', bytes: statSync(file).size }
  }
  const after = rewrite(before, file)
  for (const marker of MARKERS) {
    if (!after.includes(marker)) throw new Error(`${file}: the patched bundle lost ${marker}`)
  }
  assertParses(file, after)
  // The rename below publishes the content, so the checks above run on the exact bytes it writes.
  const temporary = `${file}.patch-tmp`
  writeFileSync(temporary, after, 'utf8')
  renameSync(temporary, file)
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

/** Read the edits back out of a tree the seed produced. */
export function verifyMobilePanel(root) {
  const file = join(root, PANEL_PATH)
  if (!existsSync(file)) return 'absent'
  const body = readFileSync(file, 'utf8')
  for (const marker of MARKERS) {
    if (!body.includes(marker)) throw new Error(`${file}: installed dsh-mobile panel is missing ${marker}`)
  }
  return 'patched'
}

// Run only as a command: prepare-seed imports verifyMobilePanel from this file, and an
// unguarded CLI block would end that process on this argument check instead of returning.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2)
  if (roots.length === 0) {
    process.stderr.write('patch-mobile-panel: give at least one node_modules root\n')
    process.exit(2)
  }
  for (const root of roots) {
    const result = patchMobilePanel(root)
    if (result.status === 'absent') {
      process.stdout.write(`patch-mobile-panel: no dsh-mobile under ${root}; nothing to patch\n`)
    } else if (result.status === 'already') {
      process.stdout.write(
        `patch-mobile-panel: ${root} already shows one QR code (${String(result.bytes)} bytes)\n`,
      )
    } else {
      process.stdout.write(
        `patch-mobile-panel: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`,
      )
    }
  }
}
