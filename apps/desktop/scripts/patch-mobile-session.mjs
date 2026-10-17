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

/**
 * Node stores a timer delay in a signed 32-bit integer: anything above 2147483647 ms fires after
 * 1 ms instead. A year-long session used to hit that ceiling and drop its streams immediately.
 */
const EXPIRY_TIMER_ABORT_FROM =
  '\t\tconst timer = setTimeout(abort, Math.max(1, authorization.expiresAt - Date.now()));'
const EXPIRY_TIMER_ABORT_TO = [
  '\t\t// DSH_MOBILE_EXPIRY_TIMER_CLAMP: node fires a timer above 2^31-1 ms after 1 ms instead,',
  '\t\t// so a year-long session would sever its streams at once; cap the wait below the limit.',
  '\t\tconst timer = setTimeout(abort, Math.min(Math.max(1, authorization.expiresAt - Date.now()), 2147483647));',
].join('\n')

const EXPIRY_TIMER_CLOSE_FROM =
  '\t\tconst timer = setTimeout(closeBoth, Math.max(1, authorization.expiresAt - Date.now()));'
const EXPIRY_TIMER_CLOSE_TO = [
  '\t\t// DSH_MOBILE_EXPIRY_TIMER_CLAMP: see the request timer above.',
  '\t\tconst timer = setTimeout(closeBoth, Math.min(Math.max(1, authorization.expiresAt - Date.now()), 2147483647));',
].join('\n')

/** The clamped delay text, present once per patched timer. */
const EXPIRY_TIMER_MARKER = 'expiresAt - Date.now()), 2147483647));'

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

/**
 * The mobile page installs its own transport override and throws when one already exists. On a
 * desktop install the page is served by the shell front door, which installs its own override
 * first, so the throw aborted the boot script before `__DSH_BOOT__` was assigned and the phone
 * got "Failed to load plugins" instead of the app.
 */
const TRANSPORT_OVERRIDE_FROM =
  "const MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP = `(()=>{if(window.__DSH_TRANSPORT__!==undefined)throw new Error('DSH Mobile cannot replace an existing transport override');window.__DSH_TRANSPORT__={fetch:(input,init)=>window.fetch(input,init),ownsHost:true},window.__DSH_FILE_UPLOAD__={fetch:(input,init)=>window.fetch(input,init)}})();`;"

const TRANSPORT_OVERRIDE_TO =
  "const MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP = `(()=>{if(window.__DSH_TRANSPORT__===undefined)window.__DSH_TRANSPORT__={fetch:(input,init)=>window.fetch(input,init),ownsHost:true};if(window.__DSH_FILE_UPLOAD__===undefined)window.__DSH_FILE_UPLOAD__={fetch:(input,init)=>window.fetch(input,init)}})();`; // DSH_MOBILE_TRANSPORT_BOOTSTRAP"

/**
 * The gateway proxies the app from `ctx.webServer.port`. On a desktop install that port belongs to
 * the shell's front door, which is where the page and its `/api` proxy actually live, while the
 * host's own listener answers no index. The shell exports its origin so the plugin can use it.
 */
const UPSTREAM_ANCHOR = 'function loopbackTemplate(loaded, webServerPort) {'

const UPSTREAM_HELPER = [
  '/** DSH_MOBILE_DESKTOP_UPSTREAM: the desktop shell announces the front door it serves. */',
  'function desktopShellUpstreamOrigin(webServerPort) {',
  '\tconst declared = process.env.DSH_SHELL_ORIGIN?.trim();',
  '\tif (declared !== void 0 && declared !== "") {',
  '\t\ttry {',
  '\t\t\tconst parsed = new URL(declared);',
  '\t\t\tif (parsed.protocol === "http:" && parsed.port !== "") return parsed.origin;',
  '\t\t} catch {}',
  '\t}',
  '\treturn `http://127.0.0.1:${String(webServerPort)}`;',
  '}',
  '',
].join('\n')

const UPSTREAM_ORIGIN_FROM = 'const activeUpstreamOrigin = `http://127.0.0.1:${String(webServerPort)}`;'
const UPSTREAM_ORIGIN_TO = 'const activeUpstreamOrigin = desktopShellUpstreamOrigin(webServerPort);'

/**
 * The launch-token exchange expects `303 + Set-Cookie` with a Max-Age. The desktop front door
 * answers `200` and a session cookie without Max-Age, which is still a usable cookie for the
 * proxy, so accept it and give it the exchange's own hour-long lifetime.
 */
const EXCHANGE_FROM = [
  '\t\t\tif (proxied.statusCode !== 303 || pair === void 0 || pair.length > 4096 || !UPSTREAM_COOKIE_PAIR.test(pair) || !Number.isSafeInteger(expiresAt) || maxAgeSeconds <= 0) throw new HttpError(502, "upstream_unavailable");',
  '\t\t\tthis.upstreamCookie = pair;',
  '\t\t\tthis.upstreamCookieExpiresAt = expiresAt;',
  '\t\t\treturn pair;',
].join('\n')

const EXCHANGE_TO = [
  '\t\t\t// DSH_MOBILE_DESKTOP_UPSTREAM: the front door answers 200 with a session cookie that',
  '\t\t\t// carries no Max-Age; that cookie still authenticates the proxy, so keep it for an hour.',
  '\t\t\tconst lifetime = Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds * 1e3 : 36e5;',
  '\t\t\tconst acceptedExpiry = Date.now() + lifetime;',
  '\t\t\tif ((proxied.statusCode !== 303 && proxied.statusCode !== 200) || pair === void 0 || pair.length > 4096 || !UPSTREAM_COOKIE_PAIR.test(pair) || !Number.isSafeInteger(acceptedExpiry)) throw new HttpError(502, "upstream_unavailable");',
  '\t\t\tthis.upstreamCookie = pair;',
  '\t\t\tthis.upstreamCookieExpiresAt = acceptedExpiry;',
  '\t\t\treturn pair;',
].join('\n')

/**
 * `materializeManagedSetup` re-signs the leaf certificate on every start, so a phone that trusted
 * the previous leaf meets a new "not private" warning after each restart. Keep a leaf that still
 * covers the interface address and stays valid for a week; issue only when it does not.
 */
const CERT_ANCHOR = 'async function refreshManagedServerCertificate(setup, address) {'

const CERT_HELPER = [
  '/** DSH_MOBILE_CERT_REUSE: keep an issued leaf while it still covers the address. */',
  'async function ensureServerCertificateFresh(setup, address) {',
  '\ttry {',
  '\t\tconst existing = new X509Certificate(await readFile(setup.tls.certFile, "utf8"));',
  '\t\tconst covers = existing.checkIP(address) !== void 0;',
  '\t\tconst remaining = Date.parse(existing.validTo) - Date.now();',
  '\t\tif (covers && remaining > 6048e5) return;',
  '\t} catch (error) {',
  '\t\tif (error.code !== "ENOENT") throw error;',
  '\t}',
  '\tawait refreshManagedServerCertificate(setup, address);',
  '}',
  '',
].join('\n')

const CERT_CALL_FROM = '\tawait refreshManagedServerCertificate(setup, network.address);'
const CERT_CALL_TO = '\tawait ensureServerCertificateFresh(setup, network.address);'

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
  replaceLine(EXPIRY_TIMER_ABORT_FROM, EXPIRY_TIMER_ABORT_TO)
  replaceLine(EXPIRY_TIMER_CLOSE_FROM, EXPIRY_TIMER_CLOSE_TO)
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

  let text = lines.join(newline)
  const replaceOnce = (from, to) => {
    const at = text.indexOf(from)
    if (at === -1) {
      throw new Error(`${file} has no anchor (${from.trim().slice(0, 80)}); the bundle changed shape`)
    }
    if (text.indexOf(from, at + 1) !== -1) {
      throw new Error(`${file} repeats the anchor (${from.trim().slice(0, 80)}); the patch needs a narrower one`)
    }
    text = text.slice(0, at) + to + text.slice(at + from.length)
  }
  replaceOnce(TRANSPORT_OVERRIDE_FROM, TRANSPORT_OVERRIDE_TO)
  replaceOnce(UPSTREAM_ANCHOR, `${UPSTREAM_HELPER}${newline}${UPSTREAM_ANCHOR}`)
  replaceOnce(UPSTREAM_ORIGIN_FROM, UPSTREAM_ORIGIN_TO)
  replaceOnce(EXCHANGE_FROM, EXCHANGE_TO)
  replaceOnce(CERT_ANCHOR, `${CERT_HELPER}${newline}${CERT_ANCHOR}`)
  replaceOnce(CERT_CALL_FROM, CERT_CALL_TO)
  return text
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

/** Every marker a patched module must still carry; shared by the patch and its verification. */
const REQUIRED_MARKERS = [
  MARKER,
  'renderExpiredPairingPage',
  'DSH_MOBILE_PAIR_AUTOSUBMIT',
  'DSH_MOBILE_EXPIRY_TIMER_CLAMP',
  'DSH_MOBILE_TRANSPORT_BOOTSTRAP',
  'DSH_MOBILE_DESKTOP_UPSTREAM',
  'DSH_MOBILE_CERT_REUSE',
]

export function patchMobileSession(root) {
  const file = join(root, LISTENER_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER)) {
    return { root, status: 'already', bytes: statSync(file).size }
  }
  const after = rewrite(before, file)
  for (const marker of REQUIRED_MARKERS) {
    if (!after.includes(marker)) throw new Error(`${file}: the patched source lost ${marker}`)
  }
  const clamped = after.split(EXPIRY_TIMER_MARKER).length - 1
  if (clamped !== 2) {
    throw new Error(`${file}: the patched source clamps ${String(clamped)} of 2 session timers`)
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
  for (const marker of REQUIRED_MARKERS) {
    if (!body.includes(marker)) throw new Error(`${file}: installed dsh-mobile is missing ${marker}`)
  }
  const clamped = body.split(EXPIRY_TIMER_MARKER).length - 1
  if (clamped !== 2) {
    throw new Error(`${file}: installed dsh-mobile clamps ${String(clamped)} of 2 session timers`)
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
