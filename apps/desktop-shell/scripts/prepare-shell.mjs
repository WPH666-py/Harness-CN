/**
 * Assemble everything the installer ships beside `Harness-CN.exe`, and build the offline package.
 *
 * Tauri reads `bundle.resources` from disk, so the runtime and the shell pages have to exist under
 * `src-tauri/resources` before `tauri build` runs. The runtime is produced by the Electron build
 * pipeline and is staged here by **hard link** rather than copy: it lives on the same volume, a link
 * costs no space and no time, and nothing here ever writes to it. A volume that refuses a link
 * falls back to a real copy.
 *
 * THE SEED IS NOT STAGED BY DEFAULT. Package it into the installer and the installer is ~93 MB
 * against Gitee's 100 MB attachment limit — headroom that one release of ordinary growth would
 * spend. Instead the seed becomes its own published attachment
 * (`dist-artifacts/Harness-CN-seed-<version>.tar.gz`, ~87 MB) which the first launch fetches once
 * and keeps. Setting `HARNESS_CN_SEED_IN_INSTALLER=1` stages it as well, producing the larger
 * installer for offline distribution; the application prefers a seed beside the runtime over
 * fetching one, so that build works with no network at all.
 */

import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTar } from 'tar'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const BUILD_ROOT = join(REPO_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const RESOURCE_ROOT = join(PACKAGE_ROOT, 'src-tauri', 'resources')
const ARTIFACT_ROOT = join(PACKAGE_ROOT, 'dist-artifacts')
const SEED_SOURCE = join(BUILD_ROOT, 'seed')
const SEED_STAGED = join(RESOURCE_ROOT, 'seed')

/**
 * The version the installer will report.
 * @returns the version `tauri.conf.json` declares, which is the one file that defines it.
 */
function applicationVersion() {
  const config = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  if (typeof config.version !== 'string' || config.version === '') {
    throw new Error('prepare-shell: tauri.conf.json carries no version')
  }
  return config.version
}

/** Directories the shared payload pipeline prepared, and where each one lands in the bundle. */
const LINKED_TREES = [{ from: join(BUILD_ROOT, 'runtime'), to: join(RESOURCE_ROOT, 'runtime') }]

/**
 * Stage one directory as hard links, falling back to a copy.
 * @param from - populated source tree.
 * @param to - destination that receives the same structure.
 * @returns how many files were staged.
 */
function linkTree(from, to) {
  const stack = [[from, to]]
  let files = 0
  while (stack.length > 0) {
    const [source, target] = stack.pop()
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name)
      const targetPath = join(target, entry.name)
      if (entry.isDirectory()) {
        stack.push([sourcePath, targetPath])
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`prepare-shell: unsupported entry ${relative(from, sourcePath)}`)
      }
      try {
        linkSync(sourcePath, targetPath)
      } catch {
        cpSync(sourcePath, targetPath)
      }
      files += 1
    }
  }
  return files
}

if (!existsSync(SEED_SOURCE)) {
  throw new Error(
    `prepare-shell: ${SEED_SOURCE} is missing. Run the shared payload pipeline first:`
    + ' `pnpm --filter @deepseek-ai/dsh-desktop run prepare:package`.',
  )
}

for (const tree of LINKED_TREES) {
  if (!existsSync(tree.from)) {
    throw new Error(`prepare-shell: ${tree.from} is missing; run the shared payload pipeline first.`)
  }
  rmSync(tree.to, { recursive: true, force: true })
  const files = linkTree(tree.from, tree.to)
  process.stdout.write(`prepare-shell: staged ${String(files)} files into ${tree.to}\n`)
}

// The shell's own pages are small and are authored here, so they are copied rather than linked.
rmSync(join(RESOURCE_ROOT, 'shell'), { recursive: true, force: true })
cpSync(join(PACKAGE_ROOT, 'rsc'), join(RESOURCE_ROOT, 'shell'), { recursive: true })
process.stdout.write(`prepare-shell: copied the shell pages into ${join(RESOURCE_ROOT, 'shell')}\n`)

const version = applicationVersion()
const withSeed = process.env.HARNESS_CN_SEED_IN_INSTALLER === '1'
rmSync(SEED_STAGED, { recursive: true, force: true })
if (withSeed) {
  const files = linkTree(SEED_SOURCE, SEED_STAGED)
  process.stdout.write(`prepare-shell: staged ${String(files)} seed files into ${SEED_STAGED}\n`)
  process.stdout.write('prepare-shell: this installer carries the offline package and needs no network\n')
} else {
  process.stdout.write('prepare-shell: the seed is published separately; not staged into the installer\n')
}

// The offline package itself: one archive of the whole seed, so the first launch fetches one file,
// named after the release it belongs to.
mkdirSync(ARTIFACT_ROOT, { recursive: true })
const archive = join(ARTIFACT_ROOT, `Harness-CN-seed-${version}.tar.gz`)
rmSync(archive, { force: true })
createTar({
  cwd: SEED_SOURCE,
  file: archive,
  gzip: { level: 9 },
  // Timestamps and ownership would only make two builds of the same seed differ; nothing reads
  // either out of the extracted tree, and the inventory check does not cover them.
  noMtime: true,
  portable: true,
  sync: true,
}, readdirSync(SEED_SOURCE))
const megabytes = (statSync(archive).size / 1024 / 1024).toFixed(1)
process.stdout.write(`prepare-shell: offline package ${archive} (${megabytes} MB)\n`)

// Tauri needs the application icon inside `src-tauri`, and it takes it from the Electron shell's
// own build resources so both shells of this fork wear the same icon by construction.
const icon = join(PACKAGE_ROOT, 'src-tauri', 'icons', 'icon.ico')
const iconSource = join(REPO_ROOT, 'apps', 'desktop', 'build', 'icon.ico')
if (!existsSync(iconSource)) {
  throw new Error(`prepare-shell: the application icon is missing at ${iconSource}`)
}
mkdirSync(dirname(icon), { recursive: true })
cpSync(iconSource, icon)

const sidecar = join(RESOURCE_ROOT, 'sidecar', 'shell.mjs')
if (!existsSync(sidecar)) {
  throw new Error('prepare-shell: the sidecar bundle is missing. Run `pnpm run build:sidecar` first.')
}
process.stdout.write(
  `prepare-shell: sidecar ${sidecar} (${String(statSync(sidecar).size)} bytes); icon ${icon}\n`,
)
process.stdout.write(`prepare-shell: resource root ${RESOURCE_ROOT}\n`)
