/**
 * Replay the overlay onto a tree, or prove that a tree already carries it.
 *
 * `manifest.json` records what this product added to and changed in its upstream base. Two operations
 * matter, and they answer different questions:
 *
 *   --check <tree>   does a tree still carry the overlay? Every added file must be there with the
 *                    recorded bytes. Run this on the installed profile's source checkout, on a CI
 *                    runner that unpacked a release archive, or after a rebase, to find the file a
 *                    merge silently dropped.
 *
 *   --apply <tree>   copy the added files into a new base. Modified files are *not* copied unless
 *                    `--take-ours` is passed: a modified file is a conflict by definition, and
 *                    replacing the vendor's version wholesale is exactly how a rebase loses an
 *                    upstream fix. They are listed with both digests so the merge can be decided
 *                    one file at a time.
 *
 *   node overlay/replay.mjs --check  <tree>
 *   node overlay/replay.mjs --apply  <tree> [--take-ours]
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY = resolve(HERE, '..')
const MANIFEST = join(HERE, 'manifest.json')
const TRIAGE = join(HERE, 'triage.json')

if (!existsSync(MANIFEST)) {
  process.stderr.write('overlay/replay.mjs: no overlay/manifest.json — run overlay/scan.mjs --write first\n')
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

const argv = process.argv.slice(2)
const target = argv.find((argument) => !argument.startsWith('--'))
if (target === undefined) {
  process.stderr.write('usage: overlay/replay.mjs --check|--apply <tree> [--take-ours]\n')
  process.exit(2)
}
const root = resolve(target)
const check = argv.includes('--check')
const apply = argv.includes('--apply')
if (check === apply) {
  process.stderr.write('overlay/replay.mjs: pass exactly one of --check or --apply\n')
  process.exit(2)
}

/**
 * Hash a file on disk.
 * @param path - absolute path.
 * @returns the digest, or undefined when the file is absent.
 */
function digestOf(path) {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (check) {
  const missing = []
  const changed = []
  for (const entry of manifest.added) {
    const actual = digestOf(join(root, entry.path))
    if (actual === undefined) missing.push(entry.path)
    else if (actual !== entry.sha256) changed.push(entry.path)
  }
  // A modified file has two acceptable states: our bytes, or the base's. Anything else means the
  // file was edited by someone else after the manifest was written, which the merge must see.
  const vendor = []
  const unknown = []
  for (const entry of manifest.modified) {
    const actual = digestOf(join(root, entry.path))
    if (actual === entry.sha256) continue
    if (actual === entry.baseSha256) vendor.push(entry.path)
    else unknown.push(entry.path)
  }
  const describe = (label, paths) => {
    if (paths.length === 0) return
    process.stdout.write(`  ${label}: ${String(paths.length)}\n`)
    for (const path of paths.slice(0, 20)) process.stdout.write(`    ${path}\n`)
    if (paths.length > 20) process.stdout.write(`    … ${String(paths.length - 20)} more\n`)
  }
  process.stdout.write(`overlay/replay.mjs: ${root} against ${manifest.base.directory}\n`)
  process.stdout.write(`  added files present: ${String(manifest.added.length - missing.length - changed.length)}/${String(manifest.added.length)}\n`)
  describe('MISSING added file', missing)
  describe('CHANGED added file', changed)
  describe('modified file back at base version', vendor)
  describe('modified file at unknown version', unknown)
  process.exit(missing.length === 0 && changed.length === 0 ? 0 : 1)
}

// What each entry *means*, when the triage has run. Without it every difference is treated as ours,
// which is the safe reading for --check and the noisy one for --apply.
const verdicts = new Map()
if (existsSync(TRIAGE)) {
  for (const row of JSON.parse(readFileSync(TRIAGE, 'utf8')).entries) verdicts.set(row.path, row.verdict)
}

let copied = 0
let keptUpstream = 0
for (const entry of manifest.added) {
  const destination = join(root, entry.path)
  if (digestOf(destination) === entry.sha256) continue
  if (verdicts.get(entry.path) === 'upstream' && existsSync(destination)) {
    keptUpstream += 1
    continue
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(REPOSITORY, entry.path), destination)
  copied += 1
}
process.stdout.write(`overlay/replay.mjs: copied ${String(copied)} added file(s) into ${root}\n`)
if (keptUpstream > 0) {
  process.stdout.write(`  kept ${String(keptUpstream)} upstream-identical file(s) as the new base has them\n`)
}

const differing = manifest.modified.filter((entry) => digestOf(join(root, entry.path)) !== entry.sha256)
const byVerdict = (verdict) => differing.filter((entry) => verdicts.get(entry.path) === verdict)
const conflicts = differing.filter((entry) => {
  const verdict = verdicts.get(entry.path)
  return verdict !== 'mechanical' && verdict !== 'upstream'
})
if (argv.includes('--take-ours')) {
  for (const entry of conflicts) {
    const destination = join(root, entry.path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(REPOSITORY, entry.path), destination)
  }
  process.stdout.write(`  --take-ours: overwrote ${String(conflicts.length)} modified file(s) with ours\n`)
} else {
  const mechanical = byVerdict('mechanical').length
  const upstream = byVerdict('upstream').length
  process.stdout.write(`  ${String(conflicts.length)} modified file(s) need a decision:\n`)
  for (const entry of conflicts.slice(0, 20)) {
    process.stdout.write(`    ${entry.path}${verdicts.has(entry.path) ? `  [${String(verdicts.get(entry.path))}]` : ''}\n`)
  }
  if (conflicts.length > 20) process.stdout.write(`    … ${String(conflicts.length - 20)} more\n`)
  if (mechanical > 0) process.stdout.write(`  ${String(mechanical)} version-only file(s): the bump regenerates them\n`)
  if (upstream > 0) process.stdout.write(`  ${String(upstream)} file(s) carry later upstream work: take the base's\n`)
}
if (argv.includes('--apply')) {
  // A replay alone leaves a tree that typechecks but cannot build an installer: the repairs the
  // release learned about are in `post-apply.mjs`, and forgetting them looks exactly like an
  // upstream regression until the bundle step fails minutes later.
  process.stdout.write('  next: node overlay/post-apply.mjs --apply <tree>\n')
}
