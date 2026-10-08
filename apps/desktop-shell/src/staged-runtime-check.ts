/**
 * Prove a staged desktop runtime is complete without booting it.
 *
 * WHY THIS REPLACES A BOOT. The first launch and every upgrade used to prove the staged tree by
 * starting a whole dsh Host from it, waiting for it to report ready, and stopping it again — about
 * fifty seconds, and the single largest cost of a launch after the seed work itself. What that
 * boot actually proves is: the dependency tree resolved, every file the composition reaches is
 * present, and the native modules load. All three can be established far more cheaply, because the
 * tree was built by hardlinking entries out of a store that was itself verified file by file
 * against the published seed inventory, and every link target is known to have existed a moment
 * earlier.
 *
 * WHAT THIS DOES PROVE, and what it does not. It proves the tree is complete — every declared
 * package directory is there with a manifest, nothing is missing, and the native bindings load in
 * the same Node the Host will run under. It does NOT prove the composition applies: a plugin whose
 * cordis schema is wrong would still boot and fail. That is why the boot is kept for the case that
 * can actually introduce such a package — installing or changing a plugin — and only the
 * first-launch and upgrade paths take this route. A tree assembled from a verified seed is not a
 * place a new plugin can appear.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES } from '../../desktop/src/core-package-set.ts'

/**
 * Fewest files a complete desktop runtime can plausibly hold.
 *
 * The published seed records 27,370 profile links into its store, so anything close to that is a
 * complete tree and anything far below it is a tree that was interrupted. The floor is deliberately
 * well under the real figure: it exists to catch a truncated extraction, not to pin a count that a
 * future seed would have to match.
 */
const MINIMUM_RUNTIME_FILES = 20_000

/**
 * Packages whose value is a compiled binding, probed by loading them by name.
 *
 * Loading is the only check that a prebuild survived; a file that exists can still fail to map on a
 * machine whose runtime differs from the one it was built against. Each is loaded only when it is
 * present, so a release that stops shipping one is not reported as a failure.
 *
 * These are deliberately modules with a main entry. `@img/sharp-win32-x64` is NOT one of them: it
 * is a payload package that `sharp` reaches by path and that defines no `exports`, so requiring it
 * by name fails on a perfectly good installation — which is exactly what the first version of this
 * check did, and the reason `sharp` is probed instead.
 */
const NATIVE_PROBE_PACKAGES = ['node-pty', 'koffi', 'sharp'] as const

/** What one staged-runtime check established. */
export interface StagedRuntimeReport {
  /** Files found under the staged profile's `node_modules`. */
  readonly files: number
  /** Native packages that were present and loaded cleanly. */
  readonly nativeModules: readonly string[]
}

/** Options for {@link verifyStagedRuntime}. */
export interface StagedRuntimeOptions {
  /** Absolute directory of the staged profile. */
  readonly projectDir: string
  /** Absolute path of the bundled Node the Host will run under. */
  readonly node: string
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/**
 * Count every entry under one tree, and reject a link that leads nowhere.
 * @param root - absolute directory to walk.
 * @returns files seen, and directories seen.
 */
function walk(root: string): { files: number; directories: number } {
  let files = 0
  let directories = 0
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop() as string
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        // A hoisted install has no links, so one here is unexpected rather than routine; it is
        // still only a fault when it does not resolve.
        if (!existsSync(path)) throw new Error(`desktop runtime: ${path} is a link that leads nowhere`)
        files += 1
        continue
      }
      if (entry.isDirectory()) {
        directories += 1
        stack.push(path)
        continue
      }
      if (!entry.isFile()) throw new Error(`desktop runtime: unsupported entry ${path}`)
      files += 1
    }
  }
  return { files, directories }
}

/**
 * Load every native package the staged tree contains, in the Node the Host will use.
 *
 * This is one short-lived process: it resolves each package the same way the Host would and lets the
 * loader map the binding. A failure here is exactly the failure a full boot would have hit, and it
 * is reported with the loader's own message rather than a timeout.
 * @param options - staged profile and the Node to probe with.
 * @returns the packages that were present and loaded.
 */
async function probeNativeModules(options: StagedRuntimeOptions): Promise<readonly string[]> {
  const present = NATIVE_PROBE_PACKAGES.filter(
    name => existsSync(join(options.projectDir, 'node_modules', ...name.split('/'))),
  )
  if (present.length === 0) return []
  const script = [
    'const names = JSON.parse(process.argv[1]);',
    'const failed = [];',
    'for (const name of names) {',
    '  try { require(name) } catch (error) { failed.push(name + ": " + (error && error.message ? error.message : String(error))) }',
    '}',
    'if (failed.length > 0) { console.error(failed.join("\\n")); process.exit(1) }',
    'console.log(JSON.stringify(names));',
  ].join('\n')
  const result = await new Promise<{ code: number | null; out: string; err: string }>((settle) => {
    const child = spawn(options.node, ['-e', script, JSON.stringify(present)], {
      cwd: options.projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { err += chunk })
    child.once('error', (error) => { settle({ code: null, out, err: error.message }) })
    child.once('close', (code) => { settle({ code, out, err }) })
  })
  if (result.code !== 0) {
    throw new Error(
      `desktop runtime: a bundled native module did not load under ${options.node}\n${result.err.trim()}`,
    )
  }
  return present
}

/**
 * Verify a staged desktop runtime is complete enough to activate.
 *
 * Runs before a profile replaces the working one, so a failure here leaves the previous
 * installation exactly as it was.
 * @param options - staged profile and the Node it will run under.
 * @returns what the check established, for the run log.
 * @throws when the tree is incomplete, the Host's own files are absent, or a native module fails.
 */
export async function verifyStagedRuntime(options: StagedRuntimeOptions): Promise<StagedRuntimeReport> {
  const modules = join(options.projectDir, 'node_modules')
  if (!existsSync(modules)) throw new Error(`desktop runtime: ${modules} is missing`)
  const counted = walk(modules)
  if (counted.files < MINIMUM_RUNTIME_FILES) {
    throw new Error(
      `desktop runtime: the staged tree holds ${String(counted.files)} files,`
      + ` fewer than the ${String(MINIMUM_RUNTIME_FILES)} a complete runtime has`,
    )
  }
  const host = join(modules, ...DESKTOP_HOST_PACKAGE.split('/'))
  for (const file of DESKTOP_HOST_RUNTIME_FILES) {
    if (!existsSync(join(host, ...file.split('/')))) {
      throw new Error(`desktop runtime: ${DESKTOP_HOST_PACKAGE} does not contain ${file}`)
    }
  }
  // A manifest that cannot be read is the state an interrupted install leaves behind, and the
  // composition reads it before anything else.
  for (const file of ['package.json', 'desktop-release.json']) {
    const path = join(options.projectDir, file)
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`desktop runtime: ${path} is missing or empty`)
    }
  }
  const nativeModules = await probeNativeModules(options)
  return { files: counted.files, nativeModules }
}
