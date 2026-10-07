/**
 * Bundle the sidecar into the single file the installer ships.
 *
 * The sidecar is written as TypeScript inside this workspace and reuses the Electron shell's own
 * modules verbatim, which is the point: the desktop project transaction, the seed transport, the
 * Host pipe carrier, and the credential gate are Node programs that never depended on Electron.
 * Bundling resolves those cross-package imports and the workspace dependencies they pull in, so
 * the installed sidecar is one file next to `node.exe` instead of a tree that needs its own
 * `node_modules`.
 *
 * esbuild is taken from the workspace's own installation rather than added as a dependency of this
 * package: the toolchain is already pinned here, and the bundle is a build step, not a runtime one.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const ENTRY = join(PACKAGE_ROOT, 'src', 'shell-main.ts')
const OUTPUT = join(PACKAGE_ROOT, 'src-tauri', 'resources', 'sidecar', 'shell.mjs')

/**
 * Locate esbuild and the arguments needed to run it.
 *
 * The platform binary is preferred over the `bin/esbuild` JavaScript shim because that shim is a
 * `.cmd` on Windows and `execFile` refuses to spawn one without a shell. pnpm stores the platform
 * package either beside the shim or under a version-specific directory in the virtual store.
 * @returns the executable to run, and the arguments that must precede esbuild's own.
 */
function findEsbuild() {
  // The shim first: it is the exact esbuild version this package depends on, and it is a Node
  // program, so running it through the current interpreter sidesteps Windows' refusal to
  // `execFile` a `.cmd`.
  const shim = join(PACKAGE_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (existsSync(shim)) return { command: process.execPath, prefix: [shim] }
  const store = join(REPO_ROOT, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    const versions = readdirSync(store)
      .filter(entry => entry.startsWith('@esbuild+win32-x64@'))
      .sort()
      .reverse()
    for (const entry of versions) {
      const binary = join(store, entry, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
      if (existsSync(binary)) return { command: binary, prefix: [] }
    }
  }
  throw new Error('build-sidecar: esbuild was not found in the workspace; run `pnpm install` first')
}

mkdirSync(dirname(OUTPUT), { recursive: true })
const esbuild = findEsbuild()
execFileSync(esbuild.command, [...esbuild.prefix, ENTRY,
  '--bundle',
  '--platform=node',
  '--target=node24',
  '--format=esm',
  '--outfile=' + OUTPUT,
  // The Host is a separate process and the runtime supplies every `node:` builtin, so nothing
  // here may be inlined from the standard library or resolved from the installed profile.
  '--external:node:*',
  '--banner:js=#!/usr/bin/env node',
], { stdio: 'inherit', cwd: PACKAGE_ROOT })

process.stdout.write(`build-sidecar: wrote ${OUTPUT} (${String(statSync(OUTPUT).size)} bytes)\n`)
