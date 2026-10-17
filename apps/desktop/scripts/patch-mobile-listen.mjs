// Patch dsh-mobile's LAN listener so a busy port never takes the whole app down.
//
// `dsh-mobile` opens its managed LAN gateway while the plugin tree is loading, and the
// gateway binds the port recorded in the setup file. When that port is already taken — the
// usual cause is a second DSH desktop on the same machine, or a previous instance that has
// not exited yet — `server.listen` raises EADDRINUSE, the plugin throws out of `apply`, and
// Cordis fails the whole loader entry. The user does not lose LAN access: they lose the app.
//
// Two edits, both inside `lib/index.mjs`:
//
//   1. Before the gateway config is validated, probe the configured port; when it is busy,
//      walk forward to the first free port, publish that port in `publicOrigin` (the panel,
//      the QR code and the pairing links all read the origin), and record it in the managed
//      setup file so the next launch asks for the same port instead of drifting again.
//   2. Treat EADDRINUSE like the network-selection failures the boot path already tolerates:
//      warn, leave mobile access dormant, and let DSH itself boot. A listener that cannot
//      bind is a degraded feature, not a fatal install.
//
// The published package reads no configuration that could express either rule, so the
// installed bytes are the only place to fix it. Doing it here — while prepare-seed builds the
// seed — means the archived store, the profile the first launch materializes from it, and
// every later distribution of that seed all carry the fix.
//
// Writing the file as a new file and renaming it over the old path is deliberate: pnpm
// hardlinks store entries into the profile, so editing the file in place would rewrite the
// store copy through the link while the recorded store index still describes the old bytes.
//
// Usage: node scripts/patch-mobile-listen.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The module the listener lives in, relative to a node_modules root. */
const LISTENER_PATH = join('dsh-mobile', 'lib', 'index.mjs')

/** Anchor that opens the gateway factory the managed LAN start goes through. */
const GATEWAY_ANCHOR = '\tconst startGateway = async (candidateConfig) => {'

/** Anchor that opens the boot path's tolerated-failure branch. */
const BOOT_CATCH = '\t\t\tif (!isNetworkSelectionError(error)) throw error;'

/** Marks the patched file so a second run reports `already` instead of patching twice. */
const MARKER = 'DSH_MOBILE_LISTEN_PORT_FALLBACK'

/**
 * Helpers inserted above the gateway factory. Printed with tabs to match the bundle's own
 * indentation, and written with plain concatenation so the inserted source keeps no
 * template syntax of its own.
 */
const HELPERS = [
  '\tconst probeListenPort = (host, port) => new Promise((resolveProbe) => {',
  '\t\tconst probe = createServer();',
  '\t\tconst finish = (value) => {',
  '\t\t\tprobe.close(() => resolveProbe(value));',
  '\t\t};',
  '\t\tprobe.once("error", () => finish(void 0));',
  '\t\tprobe.listen(port, host, () => {',
  '\t\t\tconst address = probe.address();',
  '\t\t\tfinish(address !== null && typeof address === "object" ? address.port : void 0);',
  '\t\t});',
  '\t});',
  '\tconst firstFreeListenPort = async (host, configured) => {',
  '\t\tfor (let offset = 0; offset < 20; offset += 1) {',
  '\t\t\tconst candidate = configured + offset;',
  '\t\t\tif (candidate > 65535) break;',
  '\t\t\tif (await probeListenPort(host, candidate) === candidate) return candidate;',
  '\t\t}',
  '\t\treturn await probeListenPort(host, 0) ?? configured;',
  '\t};',
  '\tconst pickFreeLanPort = async (candidateConfig) => {',
  '\t\tconst origin = typeof candidateConfig.publicOrigin === "string" ? new URL(candidateConfig.publicOrigin) : void 0;',
  '\t\tconst host = candidateConfig.listenHost ?? origin?.hostname;',
  '\t\tconst configured = origin === void 0 ? candidateConfig.listenPort : Number(origin.port || 443);',
  '\t\tif (typeof host !== "string" || host.length === 0) return candidateConfig;',
  '\t\tif (!Number.isSafeInteger(configured) || configured <= 0) return candidateConfig;',
  '\t\tconst free = await firstFreeListenPort(host, configured);',
  '\t\tif (free === configured) return candidateConfig;',
  '\t\tprocess.emitWarning("DSH Mobile: " + host + ":" + String(configured) + " is already in use; listening on " + host + ":" + String(free) + " instead.", { code: "' + MARKER + '" });',
  '\t\tconst next = { ...candidateConfig };',
  '\t\tif (origin === void 0) next.listenPort = free;',
  '\t\telse next.publicOrigin = origin.protocol + "//" + host + ":" + String(free);',
  '\t\tif (loaded.kind === "managed" && typeof config.setupFile === "string" && config.setupFile.length > 0) {',
  '\t\t\ttry {',
  '\t\t\t\tconst setupRecord = JSON.parse(await readFile(config.setupFile, "utf8"));',
  '\t\t\t\tif (setupRecord !== null && typeof setupRecord === "object" && setupRecord.listenPort === configured) {',
  '\t\t\t\t\tsetupRecord.listenPort = free;',
  '\t\t\t\t\tawait atomicWrite(config.setupFile, JSON.stringify(setupRecord, null, 2) + "\\n");',
  '\t\t\t\t}',
  '\t\t\t} catch (error) {',
  '\t\t\t\tlogger.warn("could not record the fallback LAN port: %s", error instanceof Error ? error.message : String(error));',
  '\t\t\t}',
  '\t\t}',
  '\t\treturn next;',
  '\t};',
]

/** The factory opens by asking for the port it is about to bind. */
const PICK_CALL = '\t\tcandidateConfig = await pickFreeLanPort(candidateConfig);'

/** Boot tolerates a listener that cannot bind, alongside a network that went away. */
const BOOT_CATCH_PATCHED =
  '\t\t\tif (!isNetworkSelectionError(error) && error?.code !== "EADDRINUSE" && error?.code !== "EADDRNOTAVAIL") throw error;'

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

/** Repair the three edits in one pass, and report the line count that moved. */
function rewrite(before, file) {
  const newline = before.includes('\r\n') ? '\r\n' : '\n'
  const normalized = before.split('\r\n').join('\n')
  const lines = normalized.split('\n')
  const anchor = lines.indexOf(GATEWAY_ANCHOR)
  if (anchor === -1) {
    throw new Error(
      `${file} has no gateway anchor (${GATEWAY_ANCHOR.trim()}); the bundle changed shape and the patch needs a new anchor`,
    )
  }
  const catchIndex = lines.indexOf(BOOT_CATCH)
  if (catchIndex === -1) {
    throw new Error(
      `${file} has no boot catch anchor (${BOOT_CATCH.trim()}); the bundle changed shape and the patch needs a new anchor`,
    )
  }
  // Splice from the bottom up so the earlier index stays valid.
  const withCatch = [...lines]
  withCatch[catchIndex] = BOOT_CATCH_PATCHED
  withCatch.splice(anchor + 1, 0, PICK_CALL)
  withCatch.splice(anchor, 0, ...HELPERS)
  return withCatch.join(newline)
}

/** Parse the patched module with Node before it is written over the installed one. */
function assertParses(file, source) {
  // A scratch file in the temp directory: the installed tree must not grow a second copy of
  // the module, and the copy is removed even when the check fails.
  const temporary = join(tmpdir(), `dsh-mobile-listen-${String(process.pid)}-${String(Date.now())}.mjs`)
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

export function patchMobileListen(root) {
  const file = join(root, LISTENER_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER)) {
    return { root, status: 'already', bytes: statSync(file).size }
  }
  const after = rewrite(before, file)
  assertParses(file, after)
  // The rename below publishes the content, so the checks above run on the exact bytes it writes.
  const temporary = `${file}.patch-tmp`
  writeFileSync(temporary, after, 'utf8')
  renameSync(temporary, file)
  const published = readFileSync(file, 'utf8')
  for (const marker of [MARKER, 'pickFreeLanPort', 'firstFreeListenPort', 'EADDRINUSE']) {
    if (!published.includes(marker)) throw new Error(`${file}: the patched file lost ${marker}`)
  }
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

/** Read the three edits back out of a tree the seed produced. */
export function verifyMobileListen(root) {
  const file = join(root, LISTENER_PATH)
  if (!existsSync(file)) return 'absent'
  const body = readFileSync(file, 'utf8')
  for (const marker of [MARKER, 'pickFreeLanPort', 'firstFreeListenPort', BOOT_CATCH_PATCHED.trim()]) {
    if (!body.includes(marker)) throw new Error(`${file}: installed dsh-mobile is missing ${marker}`)
  }
  return 'patched'
}

// Run only as a command: prepare-seed imports verifyMobileListen from this file, and an
// unguarded CLI block would end that process on this argument check instead of returning.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2)
  if (roots.length === 0) {
    process.stderr.write('patch-mobile-listen: give at least one node_modules root\n')
    process.exit(2)
  }
  for (const root of roots) {
    const result = patchMobileListen(root)
    if (result.status === 'absent') {
      process.stdout.write(`patch-mobile-listen: no dsh-mobile under ${root}; nothing to patch\n`)
    } else if (result.status === 'already') {
      process.stdout.write(
        `patch-mobile-listen: ${root} already falls back to a free LAN port (${String(result.bytes)} bytes)\n`,
      )
    } else {
      process.stdout.write(
        `patch-mobile-listen: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`,
      )
    }
  }
}
