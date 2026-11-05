/**
 * Grant the compatibility exemptions this release has actually verified.
 *
 * A profile bundle whose `peerDependencies` name an older DSH line is skipped by `dsh-app-boot`'s
 * compatibility gate, and the skip is silent from the product's side: the Host boots without the
 * plugin and its routes, tools and client halves simply do not exist. The runtime accepts an
 * explicit, exact-version exemption for such a package, recorded in the profile's own
 * `compatibility.json`.
 *
 * That file is profile metadata, so a seed that does not carry it produces profiles that break the
 * same way on every fresh install. This script writes it into the seed with the runtime's own writer
 * (`setProfileVersionExemption`), keyed on the exact runtime version the seed ships — no version is
 * taken from an environment variable, because the seed's own tree is the thing being described.
 *
 * Only packages this release exercised belong here. Everything else stays skipped, and the Host now
 * logs each skipped bundle at startup instead of hiding it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** Profile file the runtime reads its exact-version exemptions from. */
const FILENAME = 'compatibility.json'

/**
 * Packages this release verified against the DSH runtime it ships.
 *
 * `tested` records the evidence, not a promise: an entry may only be added after the described
 * behaviour was observed on the exact version named here.
 */
export const TESTED_EXEMPTIONS = [
  {
    packageName: 'dsh-remote-ssh-ops',
    version: '0.1.0',
    tested: 'the Host serves /remote-ssh-ops/v1, an SSH login to a real server succeeds, and the '
      + 'workspace tree lists remote directories through /hosts/:id/files',
  },
]

/**
 * Load the compatibility implementation out of the tree being described.
 *
 * The runtime version must be the seed's own, not the build machine's: `getDshRuntimeVersion()`
 * reads the manifest of the `@deepseek-ai/dsh-app-boot` copy that will actually run, so a seed that
 * installs a different DSH cannot be granted an exemption it did not earn.
 * @param profileDir - the seed profile root.
 * @returns the functions the grant and its verification use.
 * @throws When the seed has no app-boot, or has one that does not expose this API.
 */
async function runtimeCompatibility(profileDir) {
  const directory = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  if (!existsSync(join(directory, 'package.json'))) {
    throw new Error(`desktop seed: @deepseek-ai/dsh-app-boot is not installed in ${profileDir}, so no exemption can name its runtime`)
  }
  const api = await import(pathToFileURL(join(directory, 'lib', 'index.js')).href)
  for (const name of ['getDshRuntimeVersion', 'readProfileVersionExemptions', 'setProfileVersionExemption']) {
    if (typeof api[name] !== 'function') {
      throw new Error(`desktop seed: ${join(directory, 'lib', 'index.js')} does not export ${name}`)
    }
  }
  return api
}

/**
 * The packages this seed installs and this release verified, with their installed versions.
 * @param profileDir - the seed profile root.
 * @returns one record per tested package the seed actually ships.
 * @throws When a shipped tested package is not the version this release verified, because granting
 * the exemption would then approve a build nobody ran.
 */
function testedPackages(profileDir) {
  const packages = []
  for (const entry of TESTED_EXEMPTIONS) {
    const manifest = join(profileDir, 'node_modules', ...entry.packageName.split('/'), 'package.json')
    if (!existsSync(manifest)) continue
    const installed = JSON.parse(readFileSync(manifest, 'utf8')).version
    if (installed !== entry.version) {
      throw new Error(
        `desktop seed: refusing to exempt ${entry.packageName}@${String(installed)}; ${entry.version} is the version `
        + `this release verified (${entry.tested}). Update TESTED_EXEMPTIONS only after testing the new version.`,
      )
    }
    packages.push({ name: entry.packageName, version: installed })
  }
  return packages
}

/**
 * Grant every tested exemption in a seed profile and prove the grants read back.
 * @param profileDir - the seed profile root.
 * @returns the runtime version granted and the exact keys granted on it.
 */
export async function writeCompatibilityExemptions(profileDir) {
  const runtime = await runtimeCompatibility(profileDir)
  const runtimeVersion = runtime.getDshRuntimeVersion()
  const granted = []
  for (const entry of testedPackages(profileDir)) {
    const key = `${entry.name}@${entry.version}`
    // The runtime refuses a grant for any runtime but its own, and requires the caller to accept
    // that an out-of-range peer may crash or lose data: this file is that acknowledgement, made
    // once per released version after the verification named in TESTED_EXEMPTIONS.
    await runtime.setProfileVersionExemption(profileDir, key, runtimeVersion, true, true)
    granted.push(key)
  }
  const exemptions = runtime.readProfileVersionExemptions(profileDir)
  for (const key of granted) {
    if (!(exemptions[key] ?? []).includes(runtimeVersion)) {
      throw new Error(`desktop seed: ${FILENAME} does not grant ${key} on dsh ${runtimeVersion}`)
    }
  }
  return { runtimeVersion, granted }
}

/**
 * Require the grants a materialized profile needs, without writing.
 * @param profileDir - the seed or profile root to inspect.
 * @returns the keys the file grants on the tree's own runtime version.
 * @throws When a tested package is installed but unexempted, which is the state that hides a
 * plugin's routes while the profile still boots.
 */
export async function verifyCompatibilityExemptions(profileDir) {
  const runtime = await runtimeCompatibility(profileDir)
  const runtimeVersion = runtime.getDshRuntimeVersion()
  const exemptions = runtime.readProfileVersionExemptions(profileDir)
  const keys = []
  for (const entry of testedPackages(profileDir)) {
    const key = `${entry.name}@${entry.version}`
    if (!(exemptions[key] ?? []).includes(runtimeVersion)) {
      throw new Error(`desktop seed: ${join(profileDir, FILENAME)} does not grant ${key} on dsh ${runtimeVersion}`)
    }
    keys.push(key)
  }
  return keys
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: write-compatibility-exemptions.mjs [--check] <profile dir>')
    process.exit(2)
  }
  if (check) {
    try {
      report('compatibility-exemptions', root, 'patched', (await verifyCompatibilityExemptions(root)).join(', '))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A tested package installed at a version nobody verified is drift; a seed that simply has not
      // been granted yet is pristine, and applying the patch is the expected next step.
      report('compatibility-exemptions', root, message.includes('refusing to exempt') ? 'drifted' : 'pristine', message)
    }
  }
  const result = await writeCompatibilityExemptions(root)
  console.log(
    `desktop seed: compatibility exemptions on dsh ${result.runtimeVersion}: `
    + (result.granted.length === 0 ? 'none (no tested package is installed)' : result.granted.join(', ')),
  )
}
