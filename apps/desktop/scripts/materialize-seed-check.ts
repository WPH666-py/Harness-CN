// Materialize one linked profile out of a rebuilt desktop seed, the way the launcher does, and
// report what the rule engine's classification table says in the tree that comes out.
//
// This is a release-time probe (run it with the repo's own tsx, not with the packaged node):
// it answers the only question that matters for the `compress` fix — does the seed's archived
// store produce the patched table, or only the machine that built the release has it.
//
// Usage: pnpm exec tsx scripts/materialize-seed-check.ts <seed-dir> <target-dir>
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractPnpmStoreArchives, materializeLinkedProfile } from '../src/seed-store.ts'

const [seedDir, targetDir] = process.argv.slice(2)
if (seedDir === undefined || targetDir === undefined) {
  process.stderr.write('usage: tsx scripts/materialize-seed-check.ts <seed-dir> <target-dir>\n')
  process.exit(2)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
const store = join(targetDir, '.store')
await extractPnpmStoreArchives(seedDir, store)
const linked = await materializeLinkedProfile(seedDir, targetDir, store, targetDir)

const catalog = join(targetDir, 'node_modules', 'dsh-rule-engine', 'lib', 'core', 'tool-catalog.js')
const size = statSync(catalog).size
const module = await import(`${pathToFileURL(catalog).href}?probe=${String(Date.now())}`) as {
  toolClass: (name: string, args: unknown) => string
}
const probes: readonly [string, unknown, string][] = [
  ['compress', {}, 'artifact'],
  ['todo_write', {}, 'artifact'],
  ['read', {}, 'analysis'],
  ['edit', {}, 'mutating'],
  ['pwsh', { command: 'npm test' }, 'analysis'],
  ['pwsh', { command: 'node ./x.mjs' }, 'mutating'],
]
const seen = probes.map(([name, args, expected]) => {
  const actual = module.toolClass(name, args)
  return `${name}=${actual}${actual === expected ? '' : `(WANT ${expected})`}`
})
const links = JSON.parse(readFileSync(join(seedDir, 'profile-links.json'), 'utf8')) as {
  files?: readonly { path?: string; link?: string; sha256?: string }[]
}
const rows = Array.isArray(links) ? links : links.files ?? []
const row = rows.find(entry => String(entry.path ?? '').includes('rule-engine/lib/core/tool-catalog.js'))
process.stdout.write(`materialize-seed-check: linked=${String(JSON.stringify(linked))}\n`)
process.stdout.write(`materialize-seed-check: catalog=${String(size)}B ${seen.join(' ')}\n`)
process.stdout.write(`materialize-seed-check: link row ${JSON.stringify(row)}\n`)
