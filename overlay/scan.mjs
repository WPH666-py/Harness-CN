/**
 * Record exactly what Harness-CN adds to and changes in the upstream tree.
 *
 * The overlay is the answer to one question that has cost this project real releases: *when upstream
 * moves, which of our files are ours and which are theirs?* Without a recorded answer, a rebase is a
 * conversation with 300 files and no list, and the failure mode is that a patched file is silently
 * replaced by the vendor's version — the same class of bug the patch scripts warn about.
 *
 * The output is `overlay/manifest.json`: every path we added, every path we changed, each tagged
 * with the layer it belongs to, so a later rebase can be decided layer by layer instead of file by
 * file. Paths whose content is a build product of another path (`rsc/` → `resources/shell/`) are
 * excluded: they are not decisions, they are copies.
 *
 *   node overlay/scan.mjs --base <upstream source dir> [--root <our tree>] [--out <file>] [--write]
 *
 * `--root` scans a tree other than this checkout. That is how a rebased staging tree gets its own
 * manifest: the product line moves to the rebase tree, and the overlay of record must describe that
 * tree, not the old one.
 *
 * Both trees are hashed from disk, so the scan needs no git and works on an unpacked release
 * archive — which is exactly what a base is here.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, layerOf } from './lib/tree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY = resolve(HERE, '..')

const argv = process.argv.slice(2)
const rootIndex = argv.indexOf('--root')
const oursRoot = rootIndex === -1 ? REPOSITORY : resolve(argv[rootIndex + 1])
const outIndex = argv.indexOf('--out')
const outPath = outIndex === -1 ? join(HERE, 'manifest.json') : resolve(argv[outIndex + 1])
const baseIndex = argv.indexOf('--base')
if (baseIndex === -1 || argv[baseIndex + 1] === undefined) {
  process.stderr.write('usage: overlay/scan.mjs --base <upstream source dir> [--write]\n')
  process.exit(2)
}
const baseRoot = resolve(argv[baseIndex + 1])
if (!existsSync(baseRoot)) {
  process.stderr.write(`overlay/scan.mjs: no such directory: ${baseRoot}\n`)
  process.exit(2)
}

const ours = digest(oursRoot)
const theirs = digest(baseRoot)

/**
 * Say whether a modified `package.json` differs only in its version.
 *
 * Release preparation rewrites the version in every manifest of the tree, so those edits are not
 * decisions a rebase has to preserve — regenerating them is a build step. Marking them separates a
 * few hundred generated rows from the handful of real edits underneath.
 * @param path - repository-relative path.
 * @returns true when the only difference is the `version` field.
 */
function bumpOnly(path) {
  if (!path.endsWith('package.json')) return false
  try {
    const mine = JSON.parse(readFileSync(join(oursRoot, path), 'utf8'))
    const original = JSON.parse(readFileSync(join(baseRoot, path), 'utf8'))
    delete mine.version
    delete original.version
    return JSON.stringify(mine) === JSON.stringify(original)
  } catch {
    return false
  }
}

const added = []
const modified = []
for (const [path, entry] of [...ours].sort(([left], [right]) => left.localeCompare(right))) {
  const original = theirs.get(path)
  if (original === undefined) added.push({ path, layer: layerOf(path), bytes: entry.bytes, sha256: entry.sha256 })
  else if (original.sha256 !== entry.sha256) {
    modified.push({
      path,
      layer: layerOf(path),
      kind: bumpOnly(path) ? 'version' : 'edit',
      sha256: entry.sha256,
      baseSha256: original.sha256,
      decision: null,
    })
  }
}
const removed = [...theirs.keys()].filter((path) => !ours.has(path)).sort()

const tally = (entries) => {
  const counts = {}
  for (const entry of entries) counts[entry.layer] = (counts[entry.layer] ?? 0) + 1
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([layer, count]) => `${layer} ${String(count)}`).join(', ')
}
const edits = modified.filter((entry) => entry.kind === 'edit').length

process.stdout.write(`overlay/scan.mjs: base ${baseRoot}\n`)
process.stdout.write(`  ours ${String(ours.size)} files, base ${String(theirs.size)} files\n`)
process.stdout.write(`  added    ${String(added.length)}  (${tally(added)})\n`)
process.stdout.write(`  modified ${String(modified.length)}  (${String(edits)} real edits, ${String(modified.length - edits)} version-only)\n`)
process.stdout.write(`  removed  ${String(removed.length)}\n`)

if (argv.includes('--write')) {
  const manifest = {
    // The base is identified by directory name: the scan runs on an unpacked release archive, and
    // the tag is part of the archive's folder name.
    base: { directory: relative(oursRoot, baseRoot).split(sep).join('/') },
    added,
    modified,
    removed,
  }
  const target = outPath
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`  wrote ${relative(REPOSITORY, target).split(sep).join('/')}\n`)
}
