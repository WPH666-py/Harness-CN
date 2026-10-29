/**
 * Describe how a rebased tree came out: which overlay files landed, which conflicts the new base
 * raised, and where each conflict sits.
 *
 * `replay --apply` writes the tree but only prints the first twenty conflicts. This reads the same
 * three sources — manifest, triage, the target tree — and writes a report grouped by package, which
 * is the form a reviewer can actually work through.
 *
 * @example
 * node overlay/rebase-report.mjs --target ../_work/rebase-0.2.1 --write
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'manifest.json')
const TRIAGE = join(HERE, 'triage.json')

/**
 * Hash a file on disk.
 * @param path - absolute path.
 * @returns the digest, or undefined when the file is absent.
 */
function digestOf(path) {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The package a path belongs to, for grouping a report.
 * @param path - repository-relative path.
 * @returns the group key.
 */
function groupOf(path) {
  const parts = path.split('/')
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 3).join('/')
  return parts[0]
}

const argv = process.argv.slice(2)
const targetArg = argv.indexOf('--target')
if (targetArg === -1) {
  console.error('usage: overlay/rebase-report.mjs --target <rebased tree> [--write [file]]')
  process.exit(2)
}
const root = resolve(argv[targetArg + 1] ?? '')

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const verdicts = new Map()
if (existsSync(TRIAGE)) {
  for (const row of JSON.parse(readFileSync(TRIAGE, 'utf8')).entries) verdicts.set(row.path, row.verdict)
}

const added = manifest.added.map((entry) => {
  const actual = digestOf(join(root, entry.path))
  const state = actual === entry.sha256 ? 'copied' : actual === undefined ? 'missing' : 'differs'
  return { path: entry.path, state, verdict: verdicts.get(entry.path) ?? 'unknown' }
})

const modified = manifest.modified.map((entry) => {
  const actual = digestOf(join(root, entry.path))
  const verdict = verdicts.get(entry.path) ?? 'unknown'
  let state
  if (actual === entry.sha256) state = 'ours'
  else if (actual === entry.baseSha256) state = 'base'
  else if (actual === undefined) state = 'missing'
  else state = 'conflict'
  return { path: entry.path, state, verdict }
})

const counts = (rows) => {
  const map = new Map()
  for (const row of rows) map.set(row.state, (map.get(row.state) ?? 0) + 1)
  return Object.fromEntries(map)
}

const report = {
  target: root,
  base: manifest.base.directory,
  added: counts(added),
  modified: counts(modified),
}

console.log(JSON.stringify(report, null, 2))

const lines = [
  '# Rebase report',
  '',
  `- target: \`${relative(resolve(HERE, '..'), root).split('\\').join('/')}\``,
  `- base recorded in the manifest: \`${manifest.base.directory}\``,
  '',
  '## Added files',
  '',
  ...Object.entries(report.added).map(([state, count]) => `- ${state}: ${String(count)}`),
  '',
  '## Modified files',
  '',
  ...Object.entries(report.modified).map(([state, count]) => `- ${state}: ${String(count)}`),
  '',
]

// Group whatever still needs a decision: copied files that differ, edits the new base contradicts,
// and edits whose file the new base no longer has at all.
const decided = new Set(['mechanical', 'upstream'])
const pending = [
  ...added.filter((row) => row.state === 'differs'),
  ...modified.filter((row) => row.state === 'conflict' && !decided.has(row.verdict)),
  ...modified.filter((row) => row.state === 'missing'),
]
const groups = new Map()
for (const row of pending) {
  const key = groupOf(row.path)
  const list = groups.get(key) ?? []
  list.push(row)
  groups.set(key, list)
}
lines.push(`## Needs a decision (${String(pending.length)})`, '')
for (const [group, rows] of [...groups].sort((left, right) => right[1].length - left[1].length)) {
  lines.push(`### ${group} (${String(rows.length)})`, '')
  for (const row of rows) lines.push(`- \`${row.path}\` — ${row.state}, ${String(row.verdict)}`)
  lines.push('')
}

if (argv.includes('--write')) {
  const file = join(HERE, 'rebase-report.md')
  writeFileSync(file, lines.join('\n'))
  console.log(`wrote ${file}`)
}
