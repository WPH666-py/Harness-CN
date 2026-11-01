/**
 * Provision the REA bundle the `dsh-plugin-rea` plugin needs.
 *
 * The plugin ships only the loader: `scripts/setup.mjs` downloads a portable Node, a JDK, Ghidra,
 * apktool, jadx-headless-mcp and the `rea-agents` npm package into `<home>/plugins/rea-bundle` and
 * records the result in `bundle.json`. Until that file exists the plugin renders a card telling the
 * user to run the command by hand, and its MCP row fails to spawn `bin/rea-shim.mjs` on every retry —
 * which is what the 30 s `MODULE_NOT_FOUND` lines in the log were.
 *
 * The download is roughly 800 MiB, so this runs in the background: a launch must not sit on a
 * network fetch that may take ten minutes. The setup script is idempotent and resumable (it caches
 * the archives and skips stages that already verify), so an interrupted run simply continues on the
 * next launch, and a missing `bundle.json` is the only signal needed to try again.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Where the plugin looks for its provisioned runtime, relative to the bundle root. */
const BUNDLE_MARKER = 'bundle.json'

/** Result of one provisioning attempt. */
export type ReaBundleState = 'ready' | 'absent' | 'started' | 'unavailable'

/** Inputs the launcher knows and the provisioner needs. */
export interface ReaBundleOptions {
  /** Node binary that runs the setup script; the bundled runtime is always present. */
  readonly node: string
  /** `<home>/profiles/desktop`, whose `node_modules` carries the plugin. */
  readonly profile: string
  /** `<home>/plugins`, the directory the plugin treats as its bundle parent. */
  readonly plugins: string
  /** Home the setup script must adopt, so its default root resolves to the same place. */
  readonly home: string
  /** Sink for a human-readable line in the shell log. */
  readonly log: (text: string) => void
}

/**
 * Start the REA bundle setup when it has not been done yet.
 *
 * Returns immediately: the child keeps running and logs its own progress. Callers only ever log the
 * state, because a bundle that is still downloading must not hold up the workspace.
 * @param options - paths, binary, and log sink of the running installation.
 * @returns `ready` when the bundle is already provisioned, `absent` when the plugin is not installed,
 * `started` when a setup child is now running, `unavailable` when the setup script is missing.
 */
export function provisionReaBundle(options: ReaBundleOptions): ReaBundleState {
  const bundleRoot = join(options.plugins, 'rea-bundle')
  if (existsSync(join(bundleRoot, BUNDLE_MARKER))) return 'ready'
  const setup = join(options.profile, 'node_modules', 'dsh-plugin-rea', 'scripts', 'setup.mjs')
  if (!existsSync(setup)) return 'absent'
  const child = launchSetup(options, setup)
  if (child === undefined) return 'unavailable'
  options.log('REA bundle: provisioning started (about 800 MiB on the first run)')
  child.on('exit', (code) => {
    const done = existsSync(join(bundleRoot, BUNDLE_MARKER))
    options.log(`REA bundle: provisioning ${done ? 'finished' : 'stopped'} (exit ${String(code ?? 'null')})`)
    if (done) options.log('REA bundle: restart the application so the mcp-rea row connects')
  })
  return 'started'
}

/**
 * Spawn the setup script with the flags that make it unattended.
 * @param options - paths and log sink of the running installation.
 * @param setup - absolute path of the plugin's `scripts/setup.mjs`.
 * @returns the running child, or `undefined` when the spawn failed synchronously.
 */
function launchSetup(options: ReaBundleOptions, setup: string): ChildProcess | undefined {
  let child: ChildProcess
  try {
    child = spawn(options.node, [setup, '--reuse', '--yes'], {
      cwd: options.plugins,
      env: { ...process.env, DSH_HOME: options.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    options.log(`REA bundle: setup could not start: ${(error as Error).message}`)
    return undefined
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => forward(options, chunk))
  child.stderr?.on('data', (chunk: string) => forward(options, chunk))
  child.on('error', (error) => { options.log(`REA bundle: setup failed: ${error.message}`) })
  return child
}

/**
 * Forward one chunk of setup output, one log line per non-empty source line.
 * @param options - log sink of the running installation.
 * @param chunk - raw text the child wrote.
 */
function forward(options: ReaBundleOptions, chunk: string): void {
  for (const line of chunk.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed !== '') options.log(`REA bundle: ${trimmed}`)
  }
}
