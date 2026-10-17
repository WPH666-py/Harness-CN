// Patch dsh-mobile so one pairing keeps working for as long as the desktop stays installed.
//
// `dsh-mobile` pairs a phone by handing it a device cookie and, on every visit, a session
// cookie. Both were sized for a demo, not for a desktop app the user leaves running:
//
//   - the session lives 48 minutes (288e5 ms, hard-capped at 864e5 in the config schema, so
//     no setup file can raise it), and a lapsed session sends the phone through a login page;
//   - the device that renews those sessions lives 90 days;
//   - the pairing window is 2 minutes, which is short for "walk over with the phone".
//
// The user's expectation is simpler: scan once, keep the app open, stay connected. This patch
// makes the session and the device last a year (the device ceiling is already 366 days) and
// keeps the pairing window open for ten minutes, so a session never lapses mid-use and a
// lapsed one renews silently from the device cookie after a restart.
//
// It also replaces the bare 404 the pair page returned once its window closed — an expired
// link in the phone's history then explained nothing — with a short page that retries the
// silent renew and otherwise says where the QR code lives.
//
// The published package reads no configuration that could express any of this: the session
// ceiling is compiled in and the window default lives in the same parsed object. The installed
// bytes are the only place to fix it, and doing it in prepare-seed means the archived store,
// the profile the first launch materializes from it, and every later distribution of that
// seed all carry the fix.
//
// Writing the file as a new file and renaming it over the old path is deliberate: pnpm
// hardlinks store entries into the profile, so editing in place would rewrite the store copy
// through the link while the recorded store index still described the old bytes.
//
// Usage: node scripts/patch-mobile-session.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The module that owns the session, device and pairing policies, relative to a node_modules root. */
const LISTENER_PATH = join('dsh-mobile', 'lib', 'index.mjs')

/** Marks the patched file so a second run reports `already` instead of patching twice. */
const MARKER = 'DSH_MOBILE_SESSION_LONGEVITY'

/** One year in milliseconds: the session and the paired device both get it. */
const DEVICE_TTL_FROM = '\tconst deviceTtlMs = integer(value.deviceTtlMs, "deviceTtlMs", 7776e6, 6e4, 316224e5);'
const DEVICE_TTL_TO = '\tconst deviceTtlMs = integer(value.deviceTtlMs, "deviceTtlMs", 31536e6, 6e4, 316224e5);'

/** A session lives 48 minutes and the schema caps it at a day; ask for a year and raise the cap. */
const SESSION_TTL_FROM = '\tconst sessionTtlMs = integer(value.sessionTtlMs, "sessionTtlMs", 288e5, 3e4, 864e5);'
const SESSION_TTL_TO = '\tconst sessionTtlMs = integer(value.sessionTtlMs, "sessionTtlMs", 31536e6, 3e4, 316224e5);'

/** The pairing window is 2 minutes by default and 10 minutes at most; default to the ceiling. */
const PAIR_WINDOW_FROM = '\t\tpairingTtlMs: integer(value.pairingTtlMs, "pairingTtlMs", 12e4, 1e4, 6e5),'
const PAIR_WINDOW_TO = '\t\tpairingTtlMs: integer(value.pairingTtlMs, "pairingTtlMs", 6e5, 1e4, 6e5),'

/** The pair route ends with a bare 404 once its window closed. */
const PAIR_CLOSED_FROM = '\t\t\tif (!this.access.pairingStatus().open) throw new HttpError(404, "not_found");'

/** …and now ends with a page that explains the link and offers the silent renew. */
const PAIR_CLOSED_TO = [
  '\t\t\tif (!this.access.pairingStatus().open) {',
  '\t\t\t\tif (target.decodedPathname.endsWith(".js")) throw new HttpError(404, "not_found");',
  '\t\t\t\tconst languageHeader = request.headers["accept-language"];',
  '\t\t\t\tconst locale = resolveAuthPageLocale(typeof languageHeader === "string" ? languageHeader : void 0);',
  '\t\t\t\tconst expired = renderExpiredPairingPage(locale);',
  '\t\t\t\tsetSecurityHeaders(response, this.tlsEnabled);',
  '\t\t\t\tresponse.setHeader("Vary", "Accept-Language");',
  '\t\t\t\tresponse.writeHead(200, {',
  '\t\t\t\t\t"Content-Type": "text/html; charset=utf-8",',
  '\t\t\t\t\t"Content-Length": Buffer.byteLength(expired)',
  '\t\t\t\t});',
  '\t\t\t\tresponse.end(expired);',
  '\t\t\t\treturn;',
  '\t\t\t}',
].join('\n')

/** Page renderer inserted above the pairing page it replaces. */
const PAIR_PAGE_ANCHOR = 'function renderPairPage(locale) {'

/** The pair page prefills the code from the scanned fragment, then waits for a typed name. */
const PAIR_AUTOSUBMIT_FROM = '  if (supplied) token.value = supplied'

/** …and now it connects by itself: the server derives a device label when none is sent. */
const PAIR_AUTOSUBMIT_TO = [
  PAIR_AUTOSUBMIT_FROM,
  '  // DSH_MOBILE_PAIR_AUTOSUBMIT: the scanned link already carries the code and the server',
  '  // derives a device label, so the phone connects without typing a name.',
  '  if (supplied) {',
  "    label.closest('label')?.setAttribute('hidden', '')",
  "    status.value = ${JSON.stringify(copy.pairing)}",
  '    window.setTimeout(() => { form.requestSubmit() }, 400)',
  '  }',
].join('\n')

const PAGE_RENDERER = [
  '// DSH_MOBILE_SESSION_LONGEVITY: sessions and paired devices last a year, and the pairing',
  '// window stays open for ten minutes, so scanning once keeps a phone connected.',
  '/** A page instead of a bare 404 when the pairing window that served the link has closed. */',
  'function renderExpiredPairingPage(locale) {',
  '\tconst copy = {',
  '\t\ten: { lang: "en", title: "Pairing link expired", heading: "This pairing link has expired", body: "Pairing links only work for a few minutes. On the computer, open the mobile access panel, show the QR code again, and scan it with this phone.", hint: "If this phone was paired before, open the app address below and it reconnects by itself.", home: "Open DSH" },',
  '\t\tzh: { lang: "zh-CN", title: "配对链接已过期", heading: "这个配对链接已过期", body: "配对链接只在几分钟内有效。请在电脑端打开「移动访问」面板，重新显示二维码后用这台手机扫描。", hint: "如果这台手机之前配对过，直接打开下面的访问地址就会自动恢复连接。", home: "打开 DSH" },',
  '\t\tit: { lang: "it-IT", title: "Link di abbinamento scaduto", heading: "Questo link di abbinamento è scaduto", body: "I link di abbinamento durano pochi minuti. Sul computer apri il pannello accesso mobile, mostra di nuovo il codice QR e scansiona con questo telefono.", hint: "Se questo telefono era già abbinato, apri il link qui sotto: si riconnette da solo.", home: "Apri DSH" }',
  '\t};',
  '\tconst strings = copy[locale] ?? copy.en;',
  '\treturn `<!doctype html>',
  '<html lang="${strings.lang}">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>${strings.title}</title>',
  '<style>',
  ':root { color-scheme: light dark; }',
  'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; font: 16px/1.6 system-ui, sans-serif; }',
  'main { width: min(32rem, calc(100% - 3rem)); padding: 1.5rem 1.75rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; }',
  'h1 { margin: 0 0 .75rem; font-size: 1.25rem; }',
  'p { margin: 0 0 .75rem; }',
  'small { display: block; opacity: .72; }',
  'a { display: inline-block; margin-top: 1rem; padding: .55rem 1rem; border-radius: 9px; background: color-mix(in srgb, CanvasText 10%, transparent); color: inherit; text-decoration: none; }',
  '</style>',
  '</head>',
  '<body>',
  '<main>',
  '<h1>${strings.heading}</h1>',
  '<p>${strings.body}</p>',
  '<small>${strings.hint}</small>',
  '<a href="/">${strings.home}</a>',
  '</main>',
  '<script>',
  'fetch("/mobile-access/auth/renew", { method: "POST", credentials: "same-origin" }).then(function (response) { if (response.ok) location.replace("/"); }).catch(function () {});',
  '</script>',
  '</body>',
  '</html>`;',
  '}',
]

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

/** Repair the four edits in one pass, and report the shape change when an anchor no longer matches. */
function rewrite(before, file) {
  const newline = before.includes('\r\n') ? '\r\n' : '\n'
  const lines = before.split('\r\n').join('\n').split('\n')
  const replaceLine = (from, to) => {
    const index = lines.indexOf(from)
    if (index === -1) {
      throw new Error(
        `${file} has no anchor (${from.trim()}); the bundle changed shape and the patch needs a new anchor`,
      )
    }
    lines[index] = to
  }
  replaceLine(DEVICE_TTL_FROM, DEVICE_TTL_TO)
  replaceLine(SESSION_TTL_FROM, SESSION_TTL_TO)
  replaceLine(PAIR_WINDOW_FROM, PAIR_WINDOW_TO)
  replaceLine(PAIR_CLOSED_FROM, PAIR_CLOSED_TO)
  replaceLine(PAIR_AUTOSUBMIT_FROM, PAIR_AUTOSUBMIT_TO)
  const renderIndex = lines.indexOf(PAIR_PAGE_ANCHOR)
  if (renderIndex === -1) {
    throw new Error(
      `${file} has no pairing page anchor (${PAIR_PAGE_ANCHOR}); the bundle changed shape and the patch needs a new anchor`,
    )
  }
  lines.splice(renderIndex, 0, ...PAGE_RENDERER)
  return lines.join(newline)
}

/** Parse the patched module with Node before it is written over the installed one. */
function assertParses(file, source) {
  // A scratch file in the temp directory: the installed tree must not grow a second copy of
  // the module, and the copy is removed even when the check fails.
  const temporary = join(tmpdir(), `dsh-mobile-session-${String(process.pid)}-${String(Date.now())}.mjs`)
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

export function patchMobileSession(root) {
  const file = join(root, LISTENER_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER)) {
    return { root, status: 'already', bytes: statSync(file).size }
  }
  const after = rewrite(before, file)
  for (const marker of [MARKER, 'renderExpiredPairingPage', 'DSH_MOBILE_PAIR_AUTOSUBMIT', SESSION_TTL_TO.trim(), PAIR_CLOSED_TO.trim()]) {
    if (!after.includes(marker)) throw new Error(`${file}: the patched source lost ${marker}`)
  }
  assertParses(file, after)
  // The rename below publishes the content, so the checks above run on the exact bytes it writes.
  const temporary = `${file}.patch-tmp`
  writeFileSync(temporary, after, 'utf8')
  renameSync(temporary, file)
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

/** Read the edits back out of a tree the seed produced. */
export function verifyMobileSession(root) {
  const file = join(root, LISTENER_PATH)
  if (!existsSync(file)) return 'absent'
  const body = readFileSync(file, 'utf8')
  for (const marker of [MARKER, 'renderExpiredPairingPage', 'DSH_MOBILE_PAIR_AUTOSUBMIT', SESSION_TTL_TO.trim(), PAIR_CLOSED_TO.trim()]) {
    if (!body.includes(marker)) throw new Error(`${file}: installed dsh-mobile is missing ${marker}`)
  }
  return 'patched'
}

// Run only as a command: prepare-seed imports verifyMobileSession from this file, and an
// unguarded CLI block would end that process on this argument check instead of returning.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2)
  if (roots.length === 0) {
    process.stderr.write('patch-mobile-session: give at least one node_modules root\n')
    process.exit(2)
  }
  for (const root of roots) {
    const result = patchMobileSession(root)
    if (result.status === 'absent') {
      process.stdout.write(`patch-mobile-session: no dsh-mobile under ${root}; nothing to patch\n`)
    } else if (result.status === 'already') {
      process.stdout.write(
        `patch-mobile-session: ${root} already keeps paired phones signed in (${String(result.bytes)} bytes)\n`,
      )
    } else {
      process.stdout.write(
        `patch-mobile-session: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`,
      )
    }
  }
}
