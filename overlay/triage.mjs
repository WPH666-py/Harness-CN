/**
 * Decide what each difference in `manifest.json` *means*, so a rebase knows which entries it may
 * simply take from the new upstream and which ones are the fork's own work.
 *
 * The manifest answers "what differs from the base tag". That is not the same question as "what did
 * we write": this tree came from a snapshot *newer* than the tag, so a file can differ from the tag
 * purely because upstream itself moved on. Guessing that per file by eye is how a rebase silently
 * drops a real edit — or discards an upstream fix.
 *
 * Evidence, strongest first:
 *
 * 1. **Byte equality with a later upstream tag.** If our copy of a path is byte-for-byte the copy in
 *    `dsh-v0.2.2-alpha.2`, upstream produced that content and our tree merely carries it.
 * 2. **Line overlap with a later upstream tag.** Where the path moved or the tag reflowed the file,
 *    compare the lines that actually differ from the base: when the tag holds nearly all of them,
 *    the difference is upstream's, not ours. Same-basename candidates are searched too, because
 *    upstream renames packages between tags.
 * 3. **Version lines only.** A file whose only changed lines are version strings is a bump, not an
 *    edit: `bump` regenerates it, so it needs no decision at all.
 * 4. **Product fingerprints.** Text only this fork contains: its name, its env vars, its packages,
 *    its Chinese UI copy.
 *
 * Everything else is reported as `unknown` rather than guessed into `ours`; an honest unknown is a
 * question for a human, a wrong `ours` is a lost upstream fix.
 *
 * @example
 * node overlay/triage.mjs --base ../base/deepseek-harness-dsh-v0.1.5-rc.1 --corpus ../base/x --write
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from './lib/tree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY = resolve(HERE, '..')
const MANIFEST = join(HERE, 'manifest.json')
const OUTPUT = join(HERE, 'triage.json')

/** Text only this fork contains; finding it in a changed line means we wrote that line. */
const MARKERS = [
  [/Harness-CN|harness-cn/iu, 'product name'],
  [/HARNESS_CN_[A-Z_]+/u, 'product env var'],
  [/水哥/u, 'author'],
  [/desktop-shell|desktop-host/u, 'shell package'],
  [/shell-api|shellPort|shell_port/u, 'shell API'],
  [/stream-mux/u, 'stream mux'],
  [/apps\/desktop\/scripts|patchInstalled/u, 'patch scripts'],
  [/QQ 群管理|移动访问|休闲食品商城|服务器管理/u, 'CN UI copy'],
]

/** A line that is nothing but a version, a version key, or a changelog heading about one. */
const VERSION_LINE = /^(?:["']?(?:version|versionName)["']?\s*[:=]|#+\s*v?\d+\.\d+\.\d+|v?\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$|["']?@deepseek-ai\/dsh[^"']*["']?\s*:\s*["']?\^?\d)/iu

/**
 * Read the manifest, or explain what to run first.
 * @returns the parsed manifest.
 */
function readManifest() {
  if (!existsSync(MANIFEST)) {
    console.error(`manifest missing: ${MANIFEST}\nrun: node overlay/scan.mjs --base <upstream tree> --write`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

/**
 * Name a corpus directory the way a report reads best.
 * @param directory - corpus root.
 * @returns the label.
 */
function labelOf(directory) {
  return basename(directory).replace(/^deepseek-harness-/u, '')
}

/**
 * The set of lines a file contributes, trimmed, blanks dropped.
 * @param path - absolute path.
 * @returns the line set, or an empty set when unreadable.
 */
function linesOf(path) {
  if (!existsSync(path)) return new Set()
  const text = readFileSync(path, 'utf8')
  return new Set(text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== ''))
}

/**
 * How much of one set of lines another set covers.
 * @param wanted - the lines to look for.
 * @param have - the lines available.
 * @returns the share covered, 0 when nothing was wanted.
 */
function coverage(wanted, have) {
  if (wanted.size === 0) return 0
  let hits = 0
  for (const line of wanted) if (have.has(line)) hits += 1
  return hits / wanted.size
}

/**
 * Collect every corpus given on the command line, with a basename index for the moved-file search.
 * @param argv - unparsed arguments.
 * @returns corpora in the order given.
 */
function readCorpora(argv) {
  const corpora = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--corpus') continue
    const directory = resolve(argv[index + 1] ?? '')
    if (!existsSync(directory)) {
      console.error(`corpus missing: ${directory}`)
      process.exit(1)
    }
    const files = digest(directory)
    const byName = new Map()
    for (const path of files.keys()) {
      const name = basename(path)
      const list = byName.get(name) ?? []
      list.push(path)
      byName.set(name, list)
    }
    corpora.push({ label: labelOf(directory), root: directory, files, byName })
  }
  if (corpora.length === 0) {
    console.error('need at least one --corpus <upstream tree> to compare against')
    process.exit(1)
  }
  return corpora
}

/**
 * The lines of a changed file that the base does not have.
 * @param path - repository-relative path.
 * @param baseRoot - base tree root.
 * @returns the differing lines.
 */
function changedLines(path, baseRoot) {
  const ours = linesOf(join(REPOSITORY, path))
  const base = linesOf(join(baseRoot, path))
  const differing = new Set([...ours].filter((line) => !base.has(line)))
  return differing
}

/**
 * Find the corpus file that covers a set of lines best.
 * @param entry - manifest entry.
 * @param wanted - the lines to look for.
 * @param corpora - pre-digested upstream trees.
 * @returns the best match and its coverage, if any.
 */
function bestMatch(entry, wanted, corpora) {
  let best
  for (const corpus of corpora) {
    const candidates = [entry.path, ...(corpus.byName.get(basename(entry.path)) ?? [])]
    for (const candidate of new Set(candidates)) {
      if (!corpus.files.has(candidate)) continue
      const score = coverage(wanted, linesOf(join(corpus.root, candidate)))
      if (best === undefined || score > best.score) best = { score, label: corpus.label, candidate }
    }
  }
  return best
}

/**
 * Fingerprints among a set of changed lines.
 * @param differing - the lines that differ from the base.
 * @returns the marker names found.
 */
function markersIn(differing) {
  const text = [...differing].join('\n')
  return MARKERS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name)
}

/**
 * Directories this fork owns outright; upstream ships nothing there, so a file in one is ours no
 * matter what text it contains.
 */
const FORK_DIRECTORIES = /^(?:apps\/(?:desktop|desktop-host|desktop-shell)\/|mono\/)/u

/** Paths where a rename is plausible, so the same-basename search is worth running. */
const MIRRORED_DIRECTORIES = /^(?:\.agents\/|docs\/|native\/|packages\/|vendor\/)/u

/**
 * Classify one manifest entry.
 * @param entry - manifest entry with path, sha256, kind.
 * @param corpora - pre-digested upstream trees.
 * @param baseRoot - base tree root.
 * @returns the verdict and its evidence.
 */
function classify(entry, corpora, baseRoot) {
  for (const corpus of corpora) {
    const other = corpus.files.get(entry.path)
    if (other !== undefined && other.sha256 === entry.sha256) {
      return { verdict: 'upstream', evidence: `byte-identical to ${corpus.label}` }
    }
  }
  if (entry.path.startsWith('overlay/')) return { verdict: 'ours', evidence: 'overlay tooling' }
  if (/^Harness[.\-]/iu.test(basename(entry.path))) return { verdict: 'ours', evidence: 'product asset' }
  const differing = changedLines(entry.path, baseRoot)
  const markers = markersIn(differing)
  if (markers.length > 0) return { verdict: 'ours', evidence: markers.join(', ') }
  if (entry.kind === 'edit' && differing.size > 0 && [...differing].every((line) => VERSION_LINE.test(line))) {
    return { verdict: 'mechanical', evidence: `${String(differing.size)} version line(s) only` }
  }
  if (FORK_DIRECTORIES.test(entry.path)) return { verdict: 'ours', evidence: 'fork-only directory' }
  if (MIRRORED_DIRECTORIES.test(entry.path)) {
    const changed = bestMatch(entry, differing, corpora)
    if (changed !== undefined && changed.score >= 0.6) {
      return { verdict: 'upstream', evidence: `${String(Math.round(changed.score * 100))}% of changed lines in ${changed.label}` }
    }
    // A file that sits almost entirely inside a later tag's copy came from upstream too, even when
    // the tag reflowed the lines we count as changed.
    const whole = bestMatch(entry, linesOf(join(REPOSITORY, entry.path)), corpora)
    if (whole !== undefined && whole.score >= 0.9 && changed !== undefined && changed.score >= 0.4) {
      return { verdict: 'upstream', evidence: `${String(Math.round(whole.score * 100))}% of file in ${whole.label}` }
    }
    // A path the base never had but a later tag carries is upstream's path: the tag's author created
    // it, and our copy is an intermediate revision of the same file.
    if (entry.kind === 'add') {
      const carrier = corpora.find((corpus) => corpus.files.has(entry.path))
      if (carrier !== undefined) return { verdict: 'upstream', evidence: `path exists in ${carrier.label}` }
    }
  }
  if (entry.kind === 'add' && entry.path.startsWith('.agents/notes/')) {
    return { verdict: 'upstream-docs', evidence: 'upstream note without product marker' }
  }
  return { verdict: 'unknown', evidence: 'no tag match, no marker' }
}

const manifest = readManifest()
const argv = process.argv.slice(2)
const baseArg = argv.indexOf('--base')
const baseRoot = resolve(baseArg === -1 ? manifest.base.directory : (argv[baseArg + 1] ?? manifest.base.directory))
if (!existsSync(baseRoot)) {
  console.error(`base missing: ${baseRoot}`)
  process.exit(1)
}
const corpora = readCorpora(argv)
const entries = [
  ...manifest.added.map((entry) => ({ kind: 'add', entry })),
  ...manifest.modified.map((entry) => ({ kind: 'edit', entry })),
].map(({ kind, entry }) => ({
  kind,
  layer: entry.layer,
  path: entry.path,
  sha256: entry.sha256,
  bytes: entry.bytes,
  ...classify({ ...entry, kind }, corpora, baseRoot),
}))

inheritFromPackage(entries)

/** The package a path belongs to, used to let a package's known files vote for its unknown ones. */
function packageOf(path) {
  const parts = path.split('/')
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 3).join('/')
  return parts[0]
}

/**
 * Let packages vote: a file upstream authored sits among files upstream authored. A package whose
 * known files agree on one owner is strong evidence for the files that carry no marker of their own.
 * @param rows - all classified entries.
 */
function inheritFromPackage(rows) {
  for (const row of rows) {
    if (row.verdict !== 'unknown') continue
    const key = packageOf(row.path)
    const peers = rows.filter((other) => other.verdict !== 'unknown' && packageOf(other.path) === key)
    if (peers.length < 4) continue
    const upstream = peers.filter((other) => other.verdict === 'upstream' || other.verdict === 'upstream-docs').length
    const ours = peers.filter((other) => other.verdict === 'ours').length
    if (upstream / peers.length >= 0.8) {
      row.verdict = 'upstream'
      row.evidence = `package majority upstream (${String(upstream)}/${String(peers.length)})`
    } else if (ours / peers.length >= 0.8) {
      row.verdict = 'ours'
      row.evidence = `package majority ours (${String(ours)}/${String(peers.length)})`
    }
  }
}

const tally = (rows) => {
  const counts = new Map()
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1)
  return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1]))
}

const report = {
  generatedAt: new Date().toISOString(),
  base: manifest.base.directory,
  corpora: corpora.map((corpus) => corpus.label),
  counts: {
    added: tally(entries.filter((row) => row.kind === 'add')),
    modified: tally(entries.filter((row) => row.kind === 'edit')),
  },
  entries,
}

console.log('base    :', manifest.base.directory)
console.log('corpora :', report.corpora.join(', '))
console.log('added   :', JSON.stringify(report.counts.added))
console.log('modified:', JSON.stringify(report.counts.modified))
for (const verdict of ['ours', 'unknown', 'upstream', 'upstream-docs', 'mechanical']) {
  const rows = entries.filter((row) => row.verdict === verdict)
  if (rows.length === 0) continue
  console.log(`\n${verdict} (${rows.length})`)
  for (const row of rows.slice(0, 10)) console.log(`  ${row.path}  —  ${row.evidence}`)
  if (rows.length > 10) console.log(`  … ${rows.length - 10} more`)
}

if (argv.includes('--review')) {
  const unknown = entries.filter((row) => row.verdict === 'unknown')
  const lines = [
    '# Overlay triage: files that need a human decision',
    '',
    `${String(unknown.length)} of ${String(entries.length)} differences could not be attributed by evidence.`,
    'Each one is either a fork edit the rebase must keep, or an upstream revision the base tag simply',
    'lacks. Read the sample lines: text about this product, its ports, menus or Chinese copy is ours;',
    'a refactor of upstream internals is theirs.',
    '',
  ]
  for (const row of unknown) {
    const carrier = corpora.filter((corpus) => corpus.files.has(row.path)).map((corpus) => corpus.label)
    const differing = changedLines(row.path, baseRoot)
    const sample = [...differing].slice(0, 3).map((line) => `    ${line.slice(0, 120)}`)
    lines.push(
      `## ${row.path}`,
      '',
      `- kind: ${row.kind}, layer: ${row.layer}`,
      `- in later tags: ${carrier.length === 0 ? 'no path match' : carrier.join(', ')}`,
      `- changed lines: ${String(differing.size)}`,
      '',
      ...sample,
      '',
    )
  }
  writeFileSync(join(HERE, 'triage-review.md'), lines.join('\n'))
  console.log(`\nwrote ${join(HERE, 'triage-review.md')} (${String(unknown.length)} entries)`)
}

if (argv.includes('--write')) {
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nwrote ${OUTPUT}`)
}
