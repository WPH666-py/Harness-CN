// Patch dsh-rule-engine's tool classification table inside a profile or a seed tree.
//
// `compress` is an official DSH tool that folds a range of the conversation into a summary block.
// It writes session storage and touches no file outside the session, so it belongs to the engine's
// `artifact` class — the same class as `todo_write` and `skill`. The published engine (0.6.4) does
// not list it, and an unlisted tool is denied on its first call, so every session on a fresh
// profile loses that tool until a human grants it.
//
// The engine's classification table is a plain Set inside `lib/core/tool-catalog.js`, and the
// engine reads no configuration that could extend it, so the only place to fix this without
// forking the package is the installed file itself. Doing it here — while `prepare-seed.ts`
// builds the seed — means the archived store, the profile the first launch materializes from it,
// and every later distribution of that seed all carry the fixed table.
//
// Writing the file as a new file and renaming it over the old path is deliberate: pnpm hardlinks
// store entries into the profile, so editing the file in place would rewrite the store copy
// through the link while the recorded store index still describes the old bytes.
//
// Usage: node scripts/patch-rule-engine.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The module the table lives in, relative to a node_modules root. */
const CATALOG_PATH = join('dsh-rule-engine', 'lib', 'core', 'tool-catalog.js')

/** Artifact-class tools the table already lists; the patch anchors on the last of them. */
const ANCHOR_LINE = '  "skill", "todo_write", "visualize",'

/** The line the patch adds below the anchor, with the newline decided from the file itself. */
const INSERT_LINE = '  "compress",'

/**
 * The existing comment above this entry, copied so the published package and the patched tree read
 * the same way. Kept as escapes: a source file whose encoding survived a Windows editor is not
 * something to depend on, and these bytes are identical either way.
 */
const INSERT_COMMENT = '  // \u4f1a\u8bdd\u4e0a\u4e0b\u6587\u7ba1\u7406\uff08compress \u5199\u4f1a\u8bdd\u5b58\u50a8\u7684\u6298\u53e0\u5757\uff0c\u65e0\u6587\u4ef6\u526f\u4f5c\u7528\uff09\u2192 artifact'

/**
 * Tools whose class must not move because of this patch, as `[name, args, class]`. The mix covers
 * all three fixed Sets, a prefix rule, and the one tool whose class depends on its arguments, so a
 * patch that landed in the wrong Set cannot pass by leaving `compress` alone.
 */
const MUST_STAY = [
  ['read', {}, 'analysis'],
  ['job_output', {}, 'analysis'],
  ['skill', {}, 'artifact'],
  ['todo_write', {}, 'artifact'],
  ['subagent', {}, 'artifact'],
  ['edit', {}, 'mutating'],
  ['mcp__anything', {}, 'mutating'],
  ['pwsh', { command: 'npm test' }, 'analysis'],
  ['pwsh', { command: 'node ./scripts/build.mjs' }, 'mutating'],
  ['compress', {}, 'artifact'],
]

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function patchOne(root) {
  const file = join(root, CATALOG_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  const module = await import(pathToFileURL(file).href)
  if (typeof module.toolClass !== 'function') {
    throw new Error(`${file} does not export toolClass`)
  }
  if (module.toolClass('compress', {}) === 'artifact') {
    return { root, status: 'already', bytes: statSync(file).size }
  }
  if (module.toolClass('compress', {}) !== 'unknown') {
    throw new Error(`compress is classified as ${module.toolClass('compress', {})} in ${file}; the patch assumes unknown`)
  }
  const newline = before.includes('\r\n') ? '\r\n' : '\n'
  const lines = before.split(/\r?\n/)
  const anchor = lines.indexOf(ANCHOR_LINE)
  if (anchor === -1) {
    throw new Error(`${file} has no anchor line (${ANCHOR_LINE}); the table changed shape and the patch needs a new anchor`)
  }
  const after = [
    ...lines.slice(0, anchor + 1),
    INSERT_COMMENT,
    INSERT_LINE,
    ...lines.slice(anchor + 1),
  ].join(newline)
  // The rename below publishes the content, so the checks below run on the exact bytes it writes.
  const temporary = `${file}.patch-tmp`
  writeFileSync(temporary, after, 'utf8')
  renameSync(temporary, file)
  const check = await import(`${pathToFileURL(file).href}?patched=${String(Date.now())}`)
  for (const [name, args, expected] of MUST_STAY) {
    const actual = check.toolClass(name, args)
    if (actual !== expected) {
      throw new Error(`${file}: ${name} became ${actual} (expected ${expected}) — the wrong Set was patched`)
    }
  }
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

/**
 * Report what the patch would do to one tree, without writing.
 *
 * The patch's own success criterion is the imported `toolClass('compress')`, so the check asks the
 * module the same question the patch does: an upgrade that re-classifies `compress` elsewhere, or
 * drops the anchor line, shows up here instead of as a silently denied tool on a user's machine.
 * @param root - a node_modules root.
 * @returns the state and, when it is not ok, what is wrong.
 */
async function inspectOne(root) {
  const file = join(root, CATALOG_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const text = readFileSync(file, 'utf8')
  const module = await import(pathToFileURL(file).href)
  if (typeof module.toolClass !== 'function') {
    return { root, status: 'drifted', detail: `${file} does not export toolClass` }
  }
  const classified = module.toolClass('compress', {})
  if (classified === 'artifact') return { root, status: 'patched' }
  if (classified === 'unknown' && text.split(/\r?\n/u).includes(ANCHOR_LINE)) {
    return { root, status: 'pristine' }
  }
  return {
    root,
    status: 'drifted',
    detail: `compress is ${String(classified)} and the anchor line is ${text.includes(ANCHOR_LINE) ? 'present' : 'missing'} in ${file}`,
  }
}

/** Roots to act on, with the check flag removed. */
const roots = process.argv.slice(2).filter((argument) => argument !== '--check')
const check = process.argv.includes('--check')
if (roots.length === 0) {
  process.stderr.write('patch-rule-engine: give at least one node_modules root\n')
  process.exit(2)
}
if (check) {
  let drifted = false
  for (const root of roots) {
    const result = await inspectOne(root)
    process.stdout.write(`${JSON.stringify({ patch: 'rule-engine', root, state: result.status, detail: result.detail ?? '' })}\n`)
    if (result.status === 'drifted') drifted = true
  }
  process.exit(drifted ? 1 : 0)
}
for (const root of roots) {
  const result = await patchOne(root)
  if (result.status === 'absent') {
    process.stdout.write(`patch-rule-engine: no dsh-rule-engine under ${root}; nothing to patch\n`)
  } else if (result.status === 'already') {
    process.stdout.write(`patch-rule-engine: ${root} already classifies compress as artifact (${String(result.bytes)} bytes)\n`)
  } else {
    process.stdout.write(`patch-rule-engine: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`)
  }
}
