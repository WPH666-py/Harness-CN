/**
 * Provision the scientific runtime ladder the HarScience edition installs on first launch.
 *
 * The shell ships no interpreter, no compiler, and no statistics engine: a portable CPython with a
 * base scientific layer, a MinGW-w64 toolchain, and R. Together they are several hundred megabytes
 * that change on their own cadence, so they are downloaded after the window opens rather than
 * bundled or awaited on the launch path.
 *
 * Each component is optional and lands atomically: the download and every unpack step write into
 * `<home>/runtimes/<component>.partial-<stamp>`, and only a complete tree is renamed to
 * `<home>/runtimes/<component>`. A half download therefore never looks provisioned, a failure
 * leaves no marker behind, and the next launch resumes at the first missing component. Components
 * run one at a time because three concurrent transfers would starve each other on a domestic link.
 *
 * Sources are ordered China mirrors first and the canonical upstream last, and each is logged as it
 * is tried, because a launch machine behind the mainland network reaches the upstream host far
 * slower than a domestic mirror while everyone else still needs the upstream as a backstop.
 *
 * The archive readers are local to this module. The desktop package holds `extract-zip` and `tar`
 * only as build-time development dependencies, so a packaged shell would fail to resolve them; the
 * ZIP reader here reads the central directory and inflates only stored and deflate entries, and the
 * tar reader only pulls the 512-byte headers and the GNU long-name and PAX path records that
 * python-build-standalone emits. Zip64, encryption, and tar's base-256 numbers are rejected with a
 * named failure instead of being unpacked wrongly.
 *
 * R is the exception: CRAN publishes no portable Windows ZIP, only an Inno Setup installer, so the
 * R component runs that installer silently into the partial directory (see {@link R_SOURCES}).
 */

import { spawn } from 'node:child_process'
import { copyFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflateRaw } from 'node:zlib'

/** A runtime the HarScience edition installs on first launch. */
export type RuntimeComponent = 'python' | 'mingw' | 'r'

/** Outcome of one component in one provisioning pass. */
export type RuntimeState = 'ready' | 'started' | 'skipped'

/** Inputs the desktop launcher knows and the provisioner needs. */
export interface RuntimeOptions {
  /** The DSH home; every component lives under `<home>/runtimes`. */
  readonly home: string
  /** Sink for a human-readable line in the shell log. */
  readonly log: (text: string) => void
  /** Components to provision; the whole ladder when omitted. */
  readonly components?: readonly RuntimeComponent[]
  /** Download seam, so tests never reach the network; the global `fetch` when omitted. */
  readonly fetch?: typeof globalThis.fetch
}

/** Inputs the Python package step needs. */
export interface PythonExtrasOptions {
  /** The DSH home; the interpreter is `<home>/runtimes/python/python.exe`. */
  readonly home: string
  /** Directory holding the bundled wheels; `pip` reads it with `--find-links`. */
  readonly wheelhouse: string
  /** Sink for a human-readable line in the shell log. */
  readonly log: (text: string) => void
}

/** Directory under the DSH home that owns every provisioned runtime. */
const RUNTIMES_DIRECTORY = 'runtimes'

/** File that only exists in a complete tree, relative to the component root. */
const MARKERS: Readonly<Record<RuntimeComponent, string>> = {
  python: 'python.exe',
  mingw: 'bin/g++.exe',
  r: 'bin/R.exe',
}

/** Ladder order: the interpreter the base layer extends, then the compiler, then R. */
const COMPONENTS: readonly RuntimeComponent[] = ['python', 'mingw', 'r']

/** CPython release python-build-standalone publishes, pinned so a mirror update cannot drift it. */
const PYTHON_RELEASE = '20261026'

/** CPython version inside that release. */
const PYTHON_VERSION = '3.13.18'

/**
 * Interpreter archive name.
 *
 * python-build-standalone publishes Windows builds only as `.tar.gz` or `.tar.zst`; there is no ZIP
 * anywhere in the release, which is why this module also carries a tar reader.
 */
const PYTHON_ARCHIVE = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`

/** Interpreter sources: the npmmirror binary mirror, the Nanjing University mirror, the release. */
const PYTHON_SOURCES: readonly string[] = [
  `https://registry.npmmirror.com/-/binary/python-build-standalone/${PYTHON_RELEASE}/${PYTHON_ARCHIVE}`,
  `https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/${PYTHON_RELEASE}/${PYTHON_ARCHIVE}`,
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${PYTHON_ARCHIVE}`,
]

/**
 * Name the mirrors one PyPI file is fetched from, in preference order.
 * @param path - path below `packages/`, which the TUNA mirror and PyPI spell identically.
 * @returns the TUNA mirror first, the canonical PyPI host last.
 */
function wheelSources(path: string): readonly string[] {
  return [`https://pypi.tuna.tsinghua.edu.cn/${path}`, `https://files.pythonhosted.org/${path}`]
}

/** One wheel of the CPython base tier, pinned so the installed layer is reproducible. */
interface WheelSpec {
  /** Filename, used only for the temporary file and log lines. */
  readonly name: string
  /** Ordered mirrors carrying the file. */
  readonly sources: readonly string[]
}

/** Base tier of the CPython component: numpy, Pillow, and sympy with its mpmath dependency. */
const PYTHON_WHEELS: readonly WheelSpec[] = [
  {
    name: 'numpy-2.5.4-cp313-cp313-win_amd64.whl',
    sources: wheelSources('packages/90/8c/140a40398a66b4471211be1affdb6ed24c486d581bd28d07b7f2fcb69540/numpy-2.5.4-cp313-cp313-win_amd64.whl'),
  },
  {
    name: 'pillow-13.0.0-cp313-cp313-win_amd64.whl',
    sources: wheelSources('packages/d7/ed/1b16fb66a37e1b9e41370b93b2c614c7da761a5b2a41dc333f7af4639962/pillow-13.0.0-cp313-cp313-win_amd64.whl'),
  },
  {
    name: 'sympy-1.14.0-py3-none-any.whl',
    sources: wheelSources('packages/a2/09/77d55d46fd61b4a135c444fc97158ef34a095e5681d0a6c10b75bf356191/sympy-1.14.0-py3-none-any.whl'),
  },
  {
    name: 'mpmath-1.4.1-py3-none-any.whl',
    sources: wheelSources('packages/13/f2/abeec3db71d221ccd3cd89d206be1fabf5a3ee7178862f5fba23a59607e0/mpmath-1.4.1-py3-none-any.whl'),
  },
]

/** winlibs release whose assets the MinGW mirrors carry; the tag feeds both the mirror and GitHub. */
const MINGW_RELEASE = '16.2.0posix-23.1.3-14.0.0-ucrt-r3'

/** MinGW archive name, which also fixes the GCC and MinGW-w64 versions it contains. */
const MINGW_ARCHIVE = 'winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r3.zip'

/** Release title the Nanjing University mirror files that tag under, percent-encoded as it serves it. */
const MINGW_MIRROR_RELEASE =
  'GCC%2016.2.0%20%28POSIX%20threads%29%20%2B%20LLVM%2023.1.3%20%2B%20MinGW-w64%2014.0.0%20UCRT%20%28release%203%29'

/** MinGW sources: the Nanjing University mirror of the release, then the release itself. */
const MINGW_SOURCES: readonly string[] = [
  `https://mirror.nju.edu.cn/github-release/brechtsanders/winlibs_mingw/${MINGW_MIRROR_RELEASE}/${MINGW_ARCHIVE}`,
  `https://github.com/brechtsanders/winlibs_mingw/releases/download/${MINGW_RELEASE}/${MINGW_ARCHIVE}`,
]

/**
 * Portable R release this product ships.
 *
 * CRAN publishes only an Inno Setup installer for Windows, which refuses to run unelevated and in a
 * background sidecar fails with a refused consent prompt (`installer exited with code 97`) — the
 * science layer then had no R at all. `portable-r` repacks the same CRAN binaries as a relocatable
 * ZIP with no registry writes, so R now arrives the way Python and MinGW do: one archive, unpacked.
 */
const R_RELEASE = '4.3.3'

/** Portable R archive name, which also fixes the release it comes from. */
const R_ARCHIVE = `portable-r-${R_RELEASE}-win-x64.zip`

/** R sources: GitHub proxy mirrors first (GitHub itself is slow or blocked here), then GitHub. */
const R_SOURCES: readonly string[] = [
  `https://ghfast.top/https://github.com/portable-r/portable-r-windows/releases/download/v${R_RELEASE}/${R_ARCHIVE}`,
  `https://gh-proxy.com/https://github.com/portable-r/portable-r-windows/releases/download/v${R_RELEASE}/${R_ARCHIVE}`,
  `https://ghproxy.net/https://github.com/portable-r/portable-r-windows/releases/download/v${R_RELEASE}/${R_ARCHIVE}`,
  `https://github.com/portable-r/portable-r-windows/releases/download/v${R_RELEASE}/${R_ARCHIVE}`,
]

/** How a component's payload arrives and what proves it complete. */
interface ComponentSpec {
  /** Marker file, relative to the component root. */
  readonly marker: string
  /** Ordered archive sources, China mirrors first. */
  readonly sources: readonly string[]
  /** Payload format: a ZIP, or a gzipped tar. */
  readonly archive: 'zip' | 'tar-gzip'
  /** Wheels unpacked into the interpreter's `Lib/site-packages` after the archive. */
  readonly wheels?: readonly WheelSpec[]
}

/** Everything the provisioner needs to know about one component. */
const SPECS: Readonly<Record<RuntimeComponent, ComponentSpec>> = {
  python: {
    marker: MARKERS.python,
    sources: PYTHON_SOURCES,
    archive: 'tar-gzip',
    wheels: PYTHON_WHEELS,
  },
  mingw: { marker: MARKERS.mingw, sources: MINGW_SOURCES, archive: 'zip' },
  r: { marker: MARKERS.r, sources: R_SOURCES, archive: 'zip' },
}

/** Queue slots already taken, keyed by home and component, so a second launch cannot duplicate one. */
const running = new Set<string>()

/** Tail of the provisioning queue; each component waits for the previous one to settle. */
let queue: Promise<void> = Promise.resolve()

/**
 * Start provisioning the components that are neither provisioned nor running.
 *
 * Returns without waiting: components queue behind each other and the caller only renders the
 * returned states. A component counts as provisioned when its marker file exists, so relaunching
 * after an interruption resumes at the first missing component, and a failure is retried there.
 * @param options - home, log sink, component selection, and download seam.
 * @returns one state per component in ladder order: `ready` when already provisioned, `started`
 * when this call queued it, `skipped` when the caller did not ask for it.
 */
export function provisionRuntimes(options: RuntimeOptions): readonly RuntimeState[] {
  const wanted = options.components ?? COMPONENTS
  const states: RuntimeState[] = []
  for (const component of COMPONENTS) {
    states.push(wanted.includes(component) ? start(component, options) : 'skipped')
  }
  return states
}

/**
 * Describe the ladder for a home without touching the network.
 * @param home - the DSH home whose `runtimes` directory is inspected.
 * @returns one entry per component with its provisioned flag and ordered sources.
 */
export function runtimePlan(
  home: string,
): readonly { component: RuntimeComponent; present: boolean; sources: readonly string[] }[] {
  const root = join(home, RUNTIMES_DIRECTORY)
  return COMPONENTS.map(component => ({
    component,
    present: existsSync(join(root, component, MARKERS[component])),
    sources: SPECS[component].sources,
  }))
}

/**
 * Install the Python packages the science panels import, into the provisioned interpreter.
 *
 * Two of them cannot ship inside the Python archive: `chemcore` is this product's own package (it
 * travels as a wheel in `resources/science/wheelhouse`, so the install works offline) and `rdkit`
 * is a 40 MB native wheel that only comes from an index. Both installs are idempotent, so a launch
 * repeats them cheaply and a machine that already has them pays only an import check.
 * @param options - home, wheel directory, and log sink.
 */
export function provisionPythonExtras(options: PythonExtrasOptions): void {
  const interpreter = join(options.home, RUNTIMES_DIRECTORY, 'python', 'python.exe')
  if (!existsSync(interpreter)) return
  const index = 'https://pypi.tuna.tsinghua.edu.cn/simple'
  const steps: readonly { label: string; probe: string; args: readonly string[] }[] = [
    {
      label: 'chemcore',
      probe: 'import chemcore',
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', options.wheelhouse, 'chemcore'],
    },
    {
      label: 'rdkit',
      probe: 'import rdkit',
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', index, 'rdkit'],
    },
  ]
  void (async () => {
    for (const step of steps) {
      const present = await runPython(interpreter, ['-c', step.probe])
      if (present === 0) {
        options.log(`python extras: ${step.label} ready`)
        continue
      }
      const code = await runPython(interpreter, step.args, options.log)
      options.log(`python extras: ${step.label} ${code === 0 ? 'installed' : `failed (${String(code)})`}`)
    }
  })().catch((error: unknown) => {
    options.log(`python extras: stopped (${reason(error)})`)
  })
}

/**
 * Run the interpreter once without shell quoting, forwarding nothing but the exit code.
 * @param interpreter - absolute path of the bundled `python.exe`.
 * @param args - arguments after the executable.
 * @param log - optional sink for the child's stderr, which carries pip's progress and errors.
 * @returns the exit code, or `null` when the spawn itself failed.
 */
function runPython(interpreter: string, args: readonly string[], log?: (line: string) => void): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false
    const child = spawn(interpreter, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (log === undefined) return
      for (const line of chunk.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed !== '') log(`python extras: ${trimmed}`)
      }
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      resolve(null)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve(code)
    })
  })
}

/**
 * Put the provisioned runtimes on PATH for plugins that spawn `python` / `python3` / `g++` directly.
 *
 * The desktop sidecar is the process every plugin runs in, so extending `process.env.PATH` here is
 * what makes `spawn('python3')` resolve. Without it those backends die with exit code 9009
 * ("command not found") even though a complete CPython tree sits under the home.
 * @param home - the DSH home whose `runtimes` directory was provisioned.
 * @returns the directories this call added to PATH (empty when the runtime is not there yet).
 */
export function adoptRuntimePath(home: string): readonly string[] {
  const root = join(home, RUNTIMES_DIRECTORY)
  const interpreter = join(root, 'python', 'python.exe')
  const present = existsSync(interpreter)
  // Windows CPython ships only `python.exe`; most plugins spawn `python3`, so mirror the name.
  if (present) {
    const alias = join(root, 'python', 'python3.exe')
    if (!existsSync(alias)) {
      try {
        copyFileSync(interpreter, alias)
      } catch (error) {
        void error
      }
    }
    process.env['MOL_PYTHON'] = interpreter
  }
  const directories = [
    join(root, 'python'),
    join(root, 'python', 'Scripts'),
    join(root, 'mingw', 'bin'),
    join(root, 'r', 'bin'),
  ].filter(directory => existsSync(directory))
  const path = process.env['PATH'] ?? ''
  const entries = path.split(';').filter(part => part !== '')
  const added = directories.filter(directory => !entries.includes(directory))
  if (added.length > 0) process.env['PATH'] = [...added, path].join(';')
  return added
}

/**
 * Decide one component's state and queue its work when it has none.
 *
 * Synchronous filesystem failures are reported here rather than thrown, because a caller launches
 * the whole ladder in one pass and an unreadable home must not abort the other components.
 * @param component - component being considered.
 * @param options - home, log sink, and download seam.
 * @returns `ready`, `started`, or `skipped` when the marker check itself failed.
 */
function start(component: RuntimeComponent, options: RuntimeOptions): RuntimeState {
  const root = join(options.home, RUNTIMES_DIRECTORY)
  try {
    if (existsSync(join(root, component, MARKERS[component]))) {
      options.log(`runtimes: ${component} ready`)
      return 'ready'
    }
  } catch (error) {
    options.log(`runtimes: ${component} stopped (${reason(error)})`)
    return 'skipped'
  }
  const key = `${options.home}\u0000${component}`
  if (running.has(key)) return 'started'
  running.add(key)
  queue = queue
    .then(() => provisionComponent(component, options))
    .catch((error: unknown) => {
      options.log(`runtimes: ${component} stopped (${reason(error)})`)
    })
  return 'started'
}

/**
 * Download, unpack, and publish one component, then release its queue slot.
 * @param component - component to provision.
 * @param options - home, log sink, and download seam.
 */
async function provisionComponent(component: RuntimeComponent, options: RuntimeOptions): Promise<void> {
  const spec = SPECS[component]
  const root = join(options.home, RUNTIMES_DIRECTORY)
  const stamp = `${Date.now().toString(36)}-${process.pid.toString(36)}`
  const partial = join(root, `${component}.partial-${stamp}`)
  const archive = join(root, `${component}.download-${stamp}`)
  try {
    await mkdir(root, { recursive: true })
    await mkdir(partial)
    await download(spec.sources, archive, options, component)
    await unpack(spec, archive, partial, options, component)
    await publish(partial, join(root, component), spec.marker)
    options.log(`runtimes: ${component} ready`)
  } catch (error) {
    options.log(`runtimes: ${component} stopped (${reason(error)})`)
  } finally {
    running.delete(`${options.home}\u0000${component}`)
    await remove(partial, options)
    await remove(archive, options)
  }
}

/**
 * Fetch one file from the first source that answers and stream it to disk.
 *
 * A body that fails mid-stream is retried on the next source; the destination is truncated by each
 * attempt, so a short download cannot be mistaken for a complete one.
 * @param sources - ordered mirrors, China first.
 * @param destination - file the bytes are written to.
 * @param options - log sink and download seam.
 * @param component - component the file belongs to, for log lines.
 */
async function download(
  sources: readonly string[],
  destination: string,
  options: RuntimeOptions,
  component: RuntimeComponent,
): Promise<void> {
  const request = options.fetch ?? globalThis.fetch
  for (const url of sources) {
    options.log(`runtimes: ${component} trying ${url}`)
    let response: Response
    try {
      response = await request(url)
    } catch (error) {
      options.log(`runtimes: ${component} could not reach ${url} (${reason(error)})`)
      continue
    }
    if (!response.ok) {
      options.log(`runtimes: ${component} mirror answered HTTP ${String(response.status)}`)
      continue
    }
    try {
      await writeBody(response, destination)
    } catch (error) {
      options.log(`runtimes: ${component} download from ${url} failed (${reason(error)})`)
      continue
    }
    return
  }
  throw new ProvisionError(`no source answered after ${String(sources.length)} attempts`)
}

/**
 * Stream one response body to a file without buffering it.
 * @param response - successful response whose body is read once.
 * @param destination - file the bytes are written to.
 */
async function writeBody(response: Response, destination: string): Promise<void> {
  const body = response.body
  if (body === null) throw new ProvisionError('response carried no body')
  const file = await open(destination, 'w')
  try {
    const reader = body.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      await file.write(Buffer.from(chunk.value))
    }
  } finally {
    await file.close()
  }
}

/**
 * Unpack a downloaded component into its partial directory.
 * @param spec - component description.
 * @param archive - downloaded archive.
 * @param partial - directory that becomes the component root.
 * @param options - log sink and download seam.
 * @param component - component being unpacked, for log lines.
 */
async function unpack(
  spec: ComponentSpec,
  archive: string,
  partial: string,
  options: RuntimeOptions,
  component: RuntimeComponent,
): Promise<void> {
  if (spec.archive === 'tar-gzip') {
    await extractTarGzip(archive, partial)
  } else {
    await extractZip(archive, partial)
  }
  if (spec.wheels === undefined) return
  const sitePackages = join(await payloadRoot(partial, spec.marker), 'Lib', 'site-packages')
  await mkdir(sitePackages, { recursive: true })
  for (const [index, wheel] of spec.wheels.entries()) {
    const file = join(dirname(archive), `${basename(archive)}.${String(index)}.wheel`)
    try {
      await download(wheel.sources, file, options, component)
      await extractZip(file, sitePackages)
    } finally {
      await remove(file, options)
    }
  }
}

/**
 * Move a finished tree into place.
 * @param partial - partial directory holding the unpacked payload.
 * @param target - final component directory; it must not exist yet.
 * @param marker - marker file proving the payload is complete.
 */
async function publish(partial: string, target: string, marker: string): Promise<void> {
  const payload = await payloadRoot(partial, marker)
  if (existsSync(target)) throw new ProvisionError(`${target} already exists`)
  await rename(payload, target)
}

/**
 * Find the directory that actually carries the marker.
 *
 * Archives wrap their tree in one top-level directory (python-build-standalone uses `python/`,
 * winlibs uses `mingw64/`), while an installer writes its tree directly, so the caller cannot know
 * the depth in advance.
 * @param partial - partial directory holding the unpacked payload.
 * @param marker - marker file, relative to the payload root.
 * @returns the payload directory, which is `partial` itself when the marker sits directly inside.
 */
async function payloadRoot(partial: string, marker: string): Promise<string> {
  if (existsSync(join(partial, marker))) return partial
  const entries = await readdir(partial, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(partial, entry.name)
    if (existsSync(join(candidate, marker))) return candidate
  }
  throw new ProvisionError(`payload did not produce ${marker}`)
}

/**
 * Remove a provisioning leftover, reporting rather than throwing when the filesystem refuses.
 * @param path - absolute path of the leftover.
 * @param options - log sink that receives the failure.
 */
async function remove(path: string, options: RuntimeOptions): Promise<void> {
  if (!existsSync(path)) return
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    options.log(`runtimes: leftover ${path} could not be removed (${reason(error)})`)
  }
}

/** Failure that stops one component; its message is the reason reported in the `stopped` line. */
class ProvisionError extends Error {
  /**
   * Name one provisioning failure.
   * @param message - localized description of what went wrong.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionError'
  }
}

/**
 * Reduce a thrown value to the text a log line can carry.
 * @param error - value a rejected promise or a throw produced.
 * @returns the error message, or the value itself when it is not an `Error`.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** End-of-central-directory signature. */
const ZIP_END_SIGNATURE = 0x06054b50

/** Local file header signature. */
const ZIP_LOCAL_SIGNATURE = 0x04034b50

/** Central directory header signature. */
const ZIP_CENTRAL_SIGNATURE = 0x02014b50

/** Largest comment the end record can carry, plus the record's own 22 bytes. */
const ZIP_TAIL_BYTES = 66_000

/** One central-directory record of a ZIP archive. */
interface ZipEntry {
  /** Entry path with `/` separators. */
  readonly name: string
  /** Compression method: 0 (stored) or 8 (deflate). */
  readonly method: number
  /** Compressed byte count. */
  readonly compressedSize: number
  /** Byte offset of the local file header. */
  readonly headerOffset: number
}

/**
 * Read a ZIP archive's central directory.
 * @param archive - path of the archive.
 * @returns every entry the directory declares.
 */
async function zipEntries(archive: string): Promise<readonly ZipEntry[]> {
  const file = await open(archive, 'r')
  try {
    const size = (await file.stat()).size
    if (size < 22) throw new ProvisionError('zip archive is too short to hold an end record')
    const tailLength = Math.min(size, ZIP_TAIL_BYTES)
    const tail = Buffer.alloc(tailLength)
    await file.read(tail, 0, tailLength, size - tailLength)
    const end = findEndRecord(tail)
    if (end < 0) throw new ProvisionError('zip archive has no end-of-central-directory record')
    const count = tail.readUInt16LE(end + 10)
    const directorySize = tail.readUInt32LE(end + 12)
    const directoryOffset = tail.readUInt32LE(end + 16)
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ProvisionError('zip64 archives are not supported')
    }
    const directory = Buffer.alloc(directorySize)
    await file.read(directory, 0, directorySize, directoryOffset)
    return parseCentralDirectory(directory, count)
  } finally {
    await file.close()
  }
}

/**
 * Locate the end-of-central-directory record in the archive tail.
 * @param tail - last bytes of the archive, comment included.
 * @returns offset of the record inside `tail`, or -1 when the tail holds none.
 */
function findEndRecord(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === ZIP_END_SIGNATURE) return offset
  }
  return -1
}

/**
 * Parse the central directory buffer.
 * @param directory - bytes of the central directory.
 * @param count - entry count the end record declared.
 * @returns the entries in archive order.
 */
function parseCentralDirectory(directory: Buffer, count: number): readonly ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    if (directory.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ProvisionError('central directory entry has the wrong signature')
    }
    const method = directory.readUInt16LE(offset + 10)
    const compressedSize = directory.readUInt32LE(offset + 20)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const headerOffset = directory.readUInt32LE(offset + 42)
    const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, compressedSize, headerOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Extract a ZIP archive into a directory.
 * @param archive - path of the archive.
 * @param directory - directory the entries are written below.
 */
async function extractZip(archive: string, directory: string): Promise<void> {
  const entries = await zipEntries(archive)
  const file = await open(archive, 'r')
  try {
    for (const entry of entries) {
      const target = entryPath(directory, entry.name)
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeZipEntry(file, archive, entry, target)
    }
  } finally {
    await file.close()
  }
}

/**
 * Write one ZIP entry to disk.
 * @param file - open handle of the archive.
 * @param archive - path of the archive, used to stream the entry's byte range.
 * @param entry - entry being written.
 * @param target - file the entry is written to.
 */
async function writeZipEntry(
  file: FileHandle,
  archive: string,
  entry: ZipEntry,
  target: string,
): Promise<void> {
  const header = Buffer.alloc(30)
  await file.read(header, 0, 30, entry.headerOffset)
  if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
    throw new ProvisionError(`zip entry ${entry.name} has no local header`)
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const start = entry.headerOffset + 30 + nameLength + extraLength
  if (entry.compressedSize === 0) {
    await writeFile(target, Buffer.alloc(0))
    return
  }
  const source = createReadStream(archive, { start, end: start + entry.compressedSize - 1 })
  const destination = createWriteStream(target)
  if (entry.method === 0) {
    await pipeline(source, destination)
    return
  }
  if (entry.method === 8) {
    // ZIP stores raw deflate, without the zlib wrapper `createInflate` would expect.
    await pipeline(source, createInflateRaw(), destination)
    return
  }
  throw new ProvisionError(`zip entry ${entry.name} uses compression ${String(entry.method)}`)
}

/** Block size of the tar format and of its padding. */
const TAR_BLOCK_BYTES = 512

/** Largest slice the tar reader copies to a file in one step. */
const TAR_CHUNK_BYTES = 1 << 20

/**
 * Stream an archive's decompressed bytes.
 *
 * A stream error destroys both streams, so the iterator raises it and the pipeline promise is left
 * settled; awaiting it in `finally` closes the file handle without masking the iterator's error.
 * @param archive - path of the gzipped archive.
 * @returns decompressed chunks in file order.
 */
async function* gunzipChunks(archive: string): AsyncIterable<Buffer> {
  const source = createReadStream(archive)
  const inflater = createGunzip()
  const finished = pipeline(source, inflater)
  finished.catch(() => undefined)
  try {
    for await (const chunk of inflater) yield chunk as Buffer
  } finally {
    await finished.catch(() => undefined)
  }
}

/**
 * Extract a gzipped tar archive into a directory.
 *
 * Only the entry kinds python-build-standalone emits are handled: directories, regular files, GNU
 * long-name records (`L`), and PAX path records (`x`). Links are skipped because the Windows build
 * carries none, and a base-256 size is rejected rather than misread.
 * @param archive - path of the archive.
 * @param directory - directory the entries are written below.
 */
async function extractTarGzip(archive: string, directory: string): Promise<void> {
  const reader = new ByteStream(gunzipChunks(archive))
  let pendingName: string | undefined
  for (;;) {
    const header = await reader.available(TAR_BLOCK_BYTES)
    if (header === undefined || isBlankBlock(header)) return
    const type = header.toString('latin1', 156, 157)
    const size = tarNumber(header, 124, 12)
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      const payload = await reader.take(size)
      await reader.skip(tarPadding(size))
      if (type === 'L') pendingName = tarString(payload, 0, payload.length)
      if (type === 'x') pendingName = paxPath(payload) ?? pendingName
      continue
    }
    const name = pendingName ?? tarEntryName(header)
    pendingName = undefined
    if (type === '5') {
      await mkdir(entryPath(directory, name), { recursive: true })
      await reader.skip(size + tarPadding(size))
      continue
    }
    if (type === '0' || type === '\u0000') {
      await writeTarEntry(reader, entryPath(directory, name), size)
      await reader.skip(tarPadding(size))
      continue
    }
    await reader.skip(size + tarPadding(size))
  }
}

/**
 * Write one tar file entry to disk.
 * @param reader - sequential reader positioned at the entry's first payload byte.
 * @param target - file the payload is written to.
 * @param size - payload byte count the header declared.
 */
async function writeTarEntry(reader: ByteStream, target: string, size: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  if (size === 0) {
    await writeFile(target, Buffer.alloc(0))
    return
  }
  const file = await open(target, 'w')
  try {
    let remaining = size
    while (remaining > 0) {
      const chunk = await reader.take(Math.min(remaining, TAR_CHUNK_BYTES))
      await file.write(chunk)
      remaining -= chunk.length
    }
  } finally {
    await file.close()
  }
}

/**
 * Read a NUL-terminated string field of a tar header.
 * @param header - 512-byte header block.
 * @param offset - field offset inside the block.
 * @param length - field width in bytes.
 * @returns the text before the first NUL.
 */
function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end === -1 ? field.length : end)
}

/**
 * Read an octal numeric field of a tar header.
 * @param header - 512-byte header block.
 * @param offset - field offset inside the block.
 * @param length - field width in bytes.
 * @returns the decoded number, zero for an empty field.
 */
function tarNumber(header: Buffer, offset: number, length: number): number {
  if (((header.at(offset) ?? 0) & 0x80) !== 0) {
    throw new ProvisionError('tar entry uses a base-256 number this reader does not decode')
  }
  const text = tarString(header, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (Number.isNaN(value)) throw new ProvisionError(`tar entry has an unreadable size field ${text}`)
  return value
}

/**
 * Compose an entry path from the header's name and ustar prefix fields.
 * @param header - 512-byte header block.
 * @returns the entry path as the archive spells it.
 */
function tarEntryName(header: Buffer): string {
  const name = tarString(header, 0, 100)
  const ustar = header.toString('latin1', 257, 262) === 'ustar'
  const prefix = ustar ? tarString(header, 345, 155) : ''
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Read the path record out of a PAX extended header.
 * @param payload - payload bytes of the `x` entry.
 * @returns the recorded path, or undefined when the record carries none.
 */
function paxPath(payload: Buffer): string | undefined {
  for (const line of payload.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/u.exec(line)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
  }
  return undefined
}

/**
 * Padding that follows a payload of the given size.
 * @param size - payload byte count.
 * @returns bytes needed to reach the next block boundary.
 */
function tarPadding(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
}

/**
 * Tell the end-of-archive block from an entry header.
 * @param block - one 512-byte block.
 * @returns whether every byte is zero.
 */
function isBlankBlock(block: Buffer): boolean {
  return block.every(byte => byte === 0)
}

/**
 * Resolve an archive entry to a path below the extraction directory.
 *
 * Archive entries are attacker-controlled only in principle — the sources are fixed mirrors — but a
 * `..` segment or a drive-qualified name would still write outside the partial directory, so both
 * are rejected before any file is opened.
 * @param directory - extraction directory.
 * @param name - entry path as the archive spells it.
 * @returns absolute path of the entry.
 */
function entryPath(directory: string, name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  const escapes = normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)
    || segments.includes('..')
  if (segments.length === 0 || escapes) {
    throw new ProvisionError(`archive entry ${name} escapes the target directory`)
  }
  return join(directory, ...segments)
}

/**
 * Sequential reader over an async byte stream, so headers and payloads can be pulled by length.
 *
 * Streams deliver arbitrary chunk boundaries; tar parsing needs exact counts, so one block is held
 * back when a chunk ends before the requested length does.
 */
class ByteStream {
  /** Source iterator, advanced only when the held block runs out. */
  private readonly source: AsyncIterator<Buffer>

  /** Bytes already pulled from the source but not yet returned. */
  private pending: Buffer = Buffer.alloc(0)

  /**
   * Read from a stream of buffers.
   * @param stream - decompressed tar bytes.
   */
  constructor(stream: AsyncIterable<Buffer>) {
    this.source = stream[Symbol.asyncIterator]()
  }

  /**
   * Read exactly the requested count.
   * @param length - byte count; zero returns an empty buffer.
   * @returns the bytes in one buffer.
   */
  async take(length: number): Promise<Buffer> {
    const buffer = await this.available(length)
    if (buffer === undefined || buffer.length !== length) {
      throw new ProvisionError('tar archive ended before its payload did')
    }
    return buffer
  }

  /**
   * Read up to the requested count.
   * @param length - byte count to read.
   * @returns the bytes, or undefined when the stream ended first.
   */
  async available(length: number): Promise<Buffer | undefined> {
    const pieces: Buffer[] = []
    let remaining = length
    while (remaining > 0) {
      if (this.pending.length === 0 && !(await this.fill())) break
      const size = Math.min(remaining, this.pending.length)
      pieces.push(this.pending.subarray(0, size))
      this.pending = this.pending.subarray(size)
      remaining -= size
    }
    if (pieces.length === 0) return undefined
    return Buffer.concat(pieces, length - remaining)
  }

  /**
   * Discard the requested count.
   * @param length - byte count to discard.
   */
  async skip(length: number): Promise<void> {
    let remaining = length
    while (remaining > 0) {
      if (this.pending.length === 0 && !(await this.fill())) return
      const size = Math.min(remaining, this.pending.length)
      this.pending = this.pending.subarray(size)
      remaining -= size
    }
  }

  /**
   * Pull the next chunk into the held block.
   * @returns whether a chunk was available.
   */
  private async fill(): Promise<boolean> {
    const next = await this.source.next()
    if (next.done === true) return false
    this.pending = next.value
    return true
  }
}
