/**
 * Force one version across the rebase tree.
 *
 * `pnpm run release:pack --family dsh` refuses to build when the family's manifests
 * disagree, and they do after a rebase: upstream packages kept `0.2.1-rc.4` while our
 * root/`apps/*` carry the product version. This sets every workspace manifest (and the
 * Tauri/Cargo pair) to one string so the release machinery treats the tree as one
 * product line. It is a packaging step, not a product decision: the version is chosen
 * by the caller.
 *
 *   node apps/desktop/scripts/local-uniform-version.mjs <version> [--root <tree>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const version = argv.find((argument) => !argument.startsWith('--') && !argument.includes('\\'))
if (!version) {
  process.stderr.write('usage: local-uniform-version.mjs <version> [--root <tree>]\n')
  process.exit(2)
}
const rootIndex = argv.indexOf('--root')
const root = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1]

const SKIP = new Set(['node_modules', '.git', 'lib', 'dist', 'target', '.desktop-build', 'resources'])
let changed = 0
let seen = 0

/** @param {string} directory */
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      walk(path)
      continue
    }
    if (entry !== 'package.json') continue
    seen += 1
    const source = readFileSync(path, 'utf8')
    const parsed = JSON.parse(source)
    if (parsed.version === version || typeof parsed.version !== 'string') continue
    parsed.version = version
    writeFileSync(path, `${JSON.stringify(parsed, undefined, 2)}\n`, 'utf8')
    changed += 1
  }
}

walk(root)

for (const [file, pattern, replacement] of [
  [join(root, 'apps/desktop-shell/src-tauri/tauri.conf.json'), /("version"\s*:\s*)"[^"]*"/u, `$1"${version}"`],
  [join(root, 'apps/desktop-shell/src-tauri/Cargo.toml'), /^version = "[^"]*"/mu, `version = "${version}"`],
]) {
  try {
    const source = readFileSync(file, 'utf8')
    const next = source.replace(pattern, replacement)
    if (next !== source) {
      writeFileSync(file, next, 'utf8')
      changed += 1
    }
  } catch {
    // The file belongs to a package this line does not ship; nothing to align.
  }
}

console.log(`uniform version: ${seen} manifest(s) inspected, ${changed} rewritten to ${version}`)
