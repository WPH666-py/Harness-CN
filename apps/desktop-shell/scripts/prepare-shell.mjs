/**
 * Assemble everything the installer ships beside `Harness-CN.exe`.
 *
 * Tauri reads `bundle.resources` from disk, so the runtime, the seed, and the shell pages all have
 * to exist under `src-tauri/resources` before `tauri build` runs. The two large trees are produced
 * by the Electron build pipeline and are staged here by **hard link** rather than copy: they live
 * on the same volume, a link costs no space and no time, and nothing here ever writes to them. A
 * volume that refuses a link falls back to a real copy.
 */

import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const BUILD_ROOT = join(REPO_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
const RESOURCE_ROOT = join(PACKAGE_ROOT, 'src-tauri', 'resources')

/** Trees the Electron pipeline prepared, and where each one lands in the bundle. */
const LINKED_TREES = [
  { from: join(BUILD_ROOT, 'runtime'), to: join(RESOURCE_ROOT, 'runtime') },
  { from: join(BUILD_ROOT, 'seed'), to: join(RESOURCE_ROOT, 'seed') },
]

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

for (const tree of LINKED_TREES) {
  if (!existsSync(tree.from)) {
    throw new Error(
      `prepare-shell: ${tree.from} is missing. Run the Electron pipeline's prepare steps first:`
      + ' `pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime` and `prepare:seed`.',
    )
  }
  rmSync(tree.to, { recursive: true, force: true })
  const files = linkTree(tree.from, tree.to)
  process.stdout.write(`prepare-shell: staged ${String(files)} files into ${tree.to}\n`)
}

// The shell's own pages are small and are authored here, so they are copied rather than linked.
rmSync(join(RESOURCE_ROOT, 'shell'), { recursive: true, force: true })
cpSync(join(PACKAGE_ROOT, 'rsc'), join(RESOURCE_ROOT, 'shell'), { recursive: true })
process.stdout.write(`prepare-shell: copied the shell pages into ${join(RESOURCE_ROOT, 'shell')}\n`)

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
const bytes = statSync(sidecar).size
process.stdout.write(`prepare-shell: sidecar ${sidecar} (${String(bytes)} bytes); icon ${icon}\n`)
process.stdout.write(`prepare-shell: resource root ${RESOURCE_ROOT}\n`)
