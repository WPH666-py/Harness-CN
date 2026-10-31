/**
 * Fold this release's plugin decisions into the seed.
 *
 * The seed is what every profile is materialized from, so a plugin added or removed only in the live
 * profile disappears on the next runtime install. This script makes the edits at the one place that
 * survives: the seed's own manifest and `node_modules`.
 *
 * It does NOT run the package manager. A `pnpm remove`/`pnpm add` inside the seed re-resolves the
 * whole tree, which needs the registry for tarballs the seed deliberately does not keep, and that
 * turns a packaging step into a network dependency. The seed's tree is used as-is by the profile that
 * materializes from it, so removing a directory and copying another in is enough.
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Plugins withdrawn from this release. */
const REMOVED = [
  '@furongjun1999/dsh-memory',
  // VSCodeMode polled `/edrv/rpc` about nine times a second and starved the page's socket pool,
  // which is what left the connection indicator stuck on `connecting` (0.2.1-rc.7 report).
  'dsh-vscode-mode',
  // Research Graph: a sidebar footer button the product does not ship.
  'dsh-scifork',
]

/** Plugins this release adds, with the spec a later install would use and the package name. */
const ADDED = [
  { name: 'dsh-meme', spec: 'github:yyh-001/dsh-meme' },
]

/**
 * Locate a package directory to copy for an added plugin.
 *
 * The live profile is the only place on a build machine that is guaranteed to hold the exact bytes
 * this release was tested with; `HARNESS_CN_SEED_PLUGIN_SOURCE` overrides it for a clean machine.
 * @param name - package name.
 * @returns absolute source directory, or undefined when it is absent.
 */
function sourceOf(name) {
  const override = process.env.HARNESS_CN_SEED_PLUGIN_SOURCE
  if (override !== undefined && override !== '') {
    const candidate = join(override, name)
    return existsSync(candidate) ? candidate : undefined
  }
  const live = join('D:', 'Harness', 'Harness-CN', 'data', 'profiles', 'desktop', 'node_modules', name)
  return existsSync(live) ? live : undefined
}

/**
 * Apply the plugin decisions to one seed directory.
 * @param seedRoot - the seed directory produced by the payload pipeline.
 * @returns what changed, for the build log.
 */
export function patchSeedPlugins(seedRoot) {
  const manifestPath = join(seedRoot, 'package.json')
  if (!existsSync(manifestPath)) return { removed: [], added: [] }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencies = manifest.dependencies ?? {}

  const removed = []
  for (const name of REMOVED) {
    if (name in dependencies) {
      delete dependencies[name]
      removed.push(name)
    }
    // A scoped package leaves an empty scope directory behind, which the loader tolerates but a
    // later `pnpm install` would try to reconcile; both go.
    const parts = name.split('/')
    const dir = join(seedRoot, 'node_modules', ...parts)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (parts.length === 2) {
      const scope = join(seedRoot, 'node_modules', parts[0])
      if (existsSync(scope) && readdirSync(scope).length === 0) rmSync(scope, { recursive: true, force: true })
    }
  }

  const added = []
  for (const plugin of ADDED) {
    const dir = join(seedRoot, 'node_modules', plugin.name)
    if (!existsSync(dir)) {
      const source = sourceOf(plugin.name)
      if (source === undefined) {
        throw new Error(`desktop seed: cannot add ${plugin.name} — no installed copy found to stage from`)
      }
      cpSync(source, dir, { recursive: true, dereference: true })
      added.push(plugin.name)
    }
    dependencies[plugin.name] = plugin.spec
  }
  manifest.dependencies = dependencies

  // The loader reads `dsh.profile.bundles`, so a package that is only a dependency is inert.
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const filtered = bundles.filter((entry) => !REMOVED.includes(entry))
  for (const plugin of ADDED) {
    if (!filtered.includes(plugin.name)) filtered.push(plugin.name)
  }
  manifest.dsh.profile.bundles = filtered
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { removed, added }
}

/**
 * Report whether a seed already carries this release's plugin decisions.
 * @param seedRoot - the seed directory produced by the payload pipeline.
 * @returns the state and, when it is not `patched`, what is still owed.
 */
function inspectOne(seedRoot) {
  const manifestPath = join(seedRoot, 'package.json')
  if (!existsSync(manifestPath)) return { status: 'absent' }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencies = manifest.dependencies ?? {}
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const outstanding = [
    ...REMOVED.filter((name) => name in dependencies || bundles.includes(name)),
    ...ADDED.filter((plugin) => !(plugin.name in dependencies) || !bundles.includes(plugin.name)).map((plugin) => plugin.name),
  ]
  if (outstanding.length === 0) return { status: 'patched' }
  return { status: 'pristine', detail: `still owed: ${outstanding.join(', ')}` }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
  if (root === undefined) {
    console.error('usage: patch-seed-plugins.mjs [--check] <seed-root>')
    process.exit(2)
  }
  if (process.argv.includes('--check')) {
    const result = inspectOne(root)
    process.stdout.write(`${JSON.stringify({ patch: 'seed-plugins', root, state: result.status, detail: result.detail ?? '' })}\n`)
    process.exit(result.status === 'drifted' ? 1 : 0)
  }
  const result = patchSeedPlugins(root)
  console.log(`seed plugins: removed [${result.removed.join(', ')}], added [${result.added.join(', ')}]`)
}
