#!/usr/bin/env node
/**
 * Repairs a freshly replayed tree so `build:official` and the installer bundle can run.
 *
 * `overlay/replay.mjs --apply` copies this product's files over an upstream tag. That alone leaves
 * a tree that typechecks under `tsc -b` but cannot produce an installer: the desktop shell is a
 * Tauri application this product owns, and nothing in the upstream tag knows the five things below
 * are required. Each one was learned by watching a release build fail, so each one is a patch here
 * instead of a step in my head.
 *
 *   version-lock      `src-tauri/Cargo.toml` and `Cargo.lock` carry the crate version Tauri
 *                     compares against `tauri.conf.json`; a replay leaves them at the old tag's
 *                     number and the bundle step refuses to start.
 *   stage-web-assets  `frontendDist` points at `apps/desktop-shell/dist`, which only exists after
 *                     the web application is built and copied in.
 *   desktop-bundle    `pnpm --filter @deepseek-ai/dsh-desktop run bundle` is a gate of
 *                     `build:official`; the upstream manifest has the script only on packages that
 *                     ship a headless bundle.
 *   tsconfig-entries  The host aggregate needs our sidecar and the packages upstream's root include
 *                     list forgot; the client aggregate must stop listing the Electron sources this
 *                     product replaced with the Tauri shell.
 *
 * Usage:
 *   node overlay/post-apply.mjs --check <tree>   report what a replay would still need
 *   node overlay/post-apply.mjs --apply <tree>   write the patches
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const HERE = import.meta.dirname
const REPOSITORY = join(HERE, '..')

const HOST_INCLUDES = [
  'apps/desktop-shell/src/**/*.ts',
  'packages/client/shortcuts/src/**/*.ts',
  'packages/fs/node-vision/src/**/*.ts',
]

const DESKTOP_BUNDLE_SCRIPT = 'tsdown --config-loader native'
const DESKTOP_EXCLUDED_INCLUDES = [
  'apps/desktop/tests/keyboard.spec.ts',
  'apps/desktop/src/keyboard.ts',
  'apps/desktop/src/keybindings.ts',
  'apps/desktop/src/browser-guests.ts',
  'apps/desktop/src/ipc.ts',
  'apps/desktop/src/update-overlay.ts',
  'apps/desktop/tests/**/*.client.spec.tsx',
]

function readText(path) {
  return readFileSync(path, 'utf8')
}

/** Reads a JSON document that may carry comments, which `JSON.parse` refuses. */
function readJsonc(path) {
  const text = readText(path)
  const stripped = text
    .replace(/^\uFEFF/u, '')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (_match, literal) => literal ?? '')
    .replace(/,(\s*[}\]])/gu, '$1')
  return { text, value: JSON.parse(stripped) }
}

/** @returns {'already' | 'applies' | 'absent'} */
function versionLock(tree, apply) {
  const configPath = join(tree, 'apps/desktop-shell/src-tauri/tauri.conf.json')
  const cargoPath = join(tree, 'apps/desktop-shell/src-tauri/Cargo.toml')
  const lockPath = join(tree, 'apps/desktop-shell/src-tauri/Cargo.lock')
  if (!existsSync(configPath) || !existsSync(cargoPath)) return 'absent'
  const { value: config } = readJsonc(configPath)
  const version = config.version
  if (typeof version !== 'string' || version === '') return 'absent'
  const cargo = readText(cargoPath)
  const lock = existsSync(lockPath) ? readText(lockPath) : ''
  const cargoVersion = /^\[package\][^[]*?^version\s*=\s*"([^"]*)"/msu.exec(cargo)?.[1]
  const lockVersion = /^name\s*=\s*"harness-cn"\r?\nversion\s*=\s*"([^"]*)"/mu.exec(lock)?.[1]
  // `edition` has to be found anywhere in the manifest, not just between `[package]` and the next
  // table header: an anchored block regex silently missed an existing key once and wrote a second
  // copy, which TOML rejects as a duplicate.
  const editionLines = cargo.split('\n').filter((line) => /^\s*edition\s*=/u.test(line))
  const wantsEdition = editionLines.length === 0
  const duplicateEdition = editionLines.length > 1
  const settled = cargoVersion === version && (lockVersion === undefined || lockVersion === version) && !wantsEdition && !duplicateEdition
  if (settled) return 'already'
  if (!apply) return 'applies'
  let nextCargo = cargo.replace(
    /(^\[package\][^[]*?^version\s*=\s*")[^"]*(")/msu,
    `$1${version}$2`,
  )
  if (duplicateEdition) {
    let kept = false
    nextCargo = nextCargo
      .split('\n')
      .filter((line) => {
        if (!/^\s*edition\s*=/u.test(line)) return true
        if (kept) return false
        kept = true
        return true
      })
      .join('\n')
  }
  if (wantsEdition) nextCargo = nextCargo.replace(/(^\[package\][^[]*?^version\s*=\s*"[^"]*"\r?\n)/msu, `$1edition = "2021"\n`)
  writeFileSync(cargoPath, nextCargo, 'utf8')
  if (lockVersion !== undefined && lockVersion !== version) {
    writeFileSync(lockPath, lock.replace(/(^name\s*=\s*"harness-cn"\r?\nversion\s*=\s*")[^"]*(")/mu, `$1${version}$2`), 'utf8')
  }
  return 'applies'
}

/** @returns {'already' | 'applies' | 'absent'} */
function stageWebAssets(tree, apply) {
  const webDist = join(tree, 'apps/web/dist')
  const shellDist = join(tree, 'apps/desktop-shell/dist')
  if (!existsSync(webDist)) return 'absent'
  if (existsSync(join(shellDist, 'index.html'))) return 'already'
  if (!apply) return 'applies'
  mkdirSync(shellDist, { recursive: true })
  const copy = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const destination = join(to, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(destination, { recursive: true })
        copy(source, destination)
      } else if (entry.isFile()) copyFileSync(source, destination)
    }
  }
  copy(webDist, shellDist)
  return 'applies'
}

/** @returns {'already' | 'applies' | 'absent'} */
function desktopBundle(tree, apply) {
  const manifestPath = join(tree, 'apps/desktop/package.json')
  if (!existsSync(manifestPath)) return 'absent'
  const { text, value } = readJsonc(manifestPath)
  if (value.scripts?.bundle === DESKTOP_BUNDLE_SCRIPT) return 'already'
  if (!apply) return 'applies'
  const scripts = value.scripts ?? {}
  const rewritten = JSON.parse(JSON.stringify({ ...value, scripts: { ...scripts, bundle: DESKTOP_BUNDLE_SCRIPT } }))
  // The manifest is four-space indented and ends with a newline; re-emitting it wholesale keeps the
  // diff to the one line this patch owns instead of reformatting a thousand dependencies.
  const indent = /\n(\s+)"/u.exec(text)?.[1] ?? '  '
  writeFileSync(manifestPath, `${JSON.stringify(rewritten, undefined, indent)}\n`, 'utf8')
  return 'applies'
}

/** @returns {'already' | 'applies' | 'absent'} */
function tsconfigEntries(tree, apply) {
  const hostPath = join(tree, 'tsconfig.host.json')
  if (!existsSync(hostPath)) return 'absent'
  const { text: host, value } = readJsonc(hostPath)
  const include = value.include ?? []
  const missing = HOST_INCLUDES.filter((entry) => !include.includes(entry))
  const clientPath = join(tree, 'tsconfig.client.json')
  const client = existsSync(clientPath) ? readJsonc(clientPath) : undefined
  const legacy = client === undefined ? [] : (client.value.include ?? []).filter((entry) => DESKTOP_EXCLUDED_INCLUDES.includes(entry))
  if (missing.length === 0 && legacy.length === 0) return 'already'
  if (!apply) return 'applies'
  if (missing.length > 0) {
    const indent = /\n(\s+)"/u.exec(host)?.[1] ?? '  '
    const next = { ...value, include: [...include, ...missing] }
    writeFileSync(hostPath, `${JSON.stringify(next, undefined, indent)}\n`, 'utf8')
  }
  if (client !== undefined && legacy.length > 0) {
    const indent = /\n(\s+)"/u.exec(client.text)?.[1] ?? '  '
    const next = { ...client.value, include: (client.value.include ?? []).filter((entry) => !legacy.includes(entry)) }
    writeFileSync(clientPath, `${JSON.stringify(next, undefined, indent)}\n`, 'utf8')
  }
  return 'applies'
}

const PATCHES = [
  ['version-lock', versionLock],
  ['stage-web-assets', stageWebAssets],
  ['desktop-bundle', desktopBundle],
  ['tsconfig-entries', tsconfigEntries],
]

function main(argv) {
  const apply = argv.includes('--apply')
  const tree = argv.find((argument) => !argument.startsWith('--'))
  if (tree === undefined) {
    console.error('usage: overlay/post-apply.mjs --check|--apply <tree>')
    return 2
  }
  process.stdout.write(`tree: ${relative(REPOSITORY, tree) || tree}\n`)
  let outstanding = 0
  for (const [name, patch] of PATCHES) {
    const outcome = patch(tree, apply)
    if (outcome === 'applies') outstanding += 1
    const verb = outcome === 'applies' ? (apply ? 'patched ' : 'needs   ') : outcome === 'already' ? 'settled ' : 'absent  '
    process.stdout.write(`  ${verb} ${name}\n`)
  }
  process.stdout.write(apply ? `\n${PATCHES.length} patch(es) replayed\n` : `\n${outstanding} patch(es) still needed\n`)
  return apply || outstanding === 0 ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
