/**
 * Point every internal dependency at the workspace.
 *
 * Upstream 0.2.1 links its own packages with `workspace:*`, so `release:pack` accepts
 * the packed range only when it equals the family version. Our fork's manifests were
 * written when the packages were published separately and carry `^0.x` ranges, which
 * the family validator rejects with:
 *
 *   @deepseek-ai/dsh-api-workspace-files: packed dependencies.@deepseek-ai/dsh-deque
 *   must equal 0.2.1-rc.4, got ^0.2
 *
 * This rewrites every `@deepseek-ai/dsh-*` dependency whose target is a package in
 * this tree to `workspace:*`. Dependencies on packages we do not ship are untouched.
 *
 *   node apps/desktop/scripts/local-workspace-protocol.mjs [--root <tree>] [--check]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const rootIndex = argv.indexOf('--root')
const root = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1]
const check = argv.includes('--check')
const SKIP = new Set(['node_modules', '.git', 'lib', 'dist', 'target', '.desktop-build', 'resources'])
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** @type {Map<string, string>} */
const packages = new Map()

/** @param {string} directory */
function collect(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      collect(path)
      continue
    }
    if (entry !== 'package.json') continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.name === 'string' && typeof parsed.version === 'string') packages.set(parsed.name, path)
    } catch {
      // A manifest that does not parse is a different problem, reported elsewhere.
    }
  }
}

collect(root)

let rewritten = 0
const pending = []
for (const [name, path] of packages) {
  const source = readFileSync(path, 'utf8')
  const parsed = JSON.parse(source)
  let touched = false
  for (const section of SECTIONS) {
    const table = parsed[section]
    if (table === undefined) continue
    for (const [dependency, range] of Object.entries(table)) {
      if (!dependency.startsWith('@deepseek-ai/dsh')) continue
      if (!packages.has(dependency)) continue
      if (range === 'workspace:*') continue
      if (check) {
        pending.push(`${name}: ${section}.${dependency} = ${String(range)}`)
        continue
      }
      table[dependency] = 'workspace:*'
      touched = true
    }
  }
  if (!touched) continue
  writeFileSync(path, `${JSON.stringify(parsed, undefined, 2)}\n`, 'utf8')
  rewritten += 1
}

if (check) {
  console.log(`workspace protocol: ${String(pending.length)} internal range(s) would be rewritten`)
  for (const line of pending.slice(0, 20)) console.log(`  ${line}`)
} else {
  console.log(`workspace protocol: ${String(rewritten)} manifest(s) rewritten, ${String(packages.size)} package(s) in the tree`)
}
if (pending.length > 0) process.exitCode = 1
