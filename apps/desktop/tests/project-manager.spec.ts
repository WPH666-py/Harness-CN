import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledPluginNames, bundledPluginPackageNames } from '../src/bundled-plugins.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import {
  createSeedMetadata,
  DesktopProjectManager,
  packageNameFromSpec,
  verifySeedIntegrity,
  type DesktopProjectHooks,
} from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DESKTOP_HOST_PACKAGE, DESKTOP_PACKAGES_DIR, DESKTOP_PACKAGE_SET_FILE } from '../src/core-package-set.ts'
import type { DesktopRelease } from '../src/release.ts'
import {
  archivePnpmStore,
  SEED_PROFILE_FILE_ARCHIVE,
  SEED_PROFILE_LINK_MANIFEST,
} from '../src/seed-store.ts'
import { create } from 'tar'

const roots: string[] = []
const releaseWorkers: Array<() => Promise<void>> = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}

function writeIntegrity(seed: string): void {
  const paths: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name !== 'integrity.json') paths.push(path)
    }
  }
  visit(seed)
  const files = paths.sort().map((path) => {
    const body = readFileSync(path)
    return {
      path: relative(seed, path).split(sep).join('/'),
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  })
  writeFileSync(join(seed, 'integrity.json'), `${JSON.stringify({ schemaVersion: 2, files })}\n`)
}

function archiveStore(seed: string): void {
  const store = join(seed, 'store')
  mkdirSync(store, { recursive: true })
  if (readdirSync(store).length === 0) writeFileSync(join(store, 'test-entry'), 'content')
  archivePnpmStore(seed, store)
}

/**
 * Seed store content plus the link manifest that rebuilds the profile tree from it.
 *
 * A real seed records the installed tree this way instead of shipping it (see
 * `archiveLinkedProfile`), so a fixture that wants `applyRelease` to produce an installed
 * profile has to supply the same pair: store files under `v11/files` and the links naming
 * where each one lands in `node_modules`.
 * @param seed - seed directory under construction.
 * @param desktopRelease - release whose version the packaged core packages report.
 */
function writeLinkedProfileSeed(seed: string, desktopRelease: DesktopRelease): void {
  const files = join(seed, 'store', 'v11', 'files')
  mkdirSync(files, { recursive: true })
  const record = (name: string, body: string): string => {
    writeFileSync(join(files, name), body)
    return `v11/files/${name}`
  }
  const links: Record<string, string> = {
    'node_modules/@deepseek-ai/dsh/package.json': record(
      'dsh-package.json',
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: desktopRelease.version })}\n`,
    ),
    [`node_modules/${DESKTOP_HOST_PACKAGE}/package.json`]: record(
      'host-package.json',
      `${JSON.stringify({ name: DESKTOP_HOST_PACKAGE, version: desktopRelease.version })}\n`,
    ),
    [`node_modules/${DESKTOP_HOST_PACKAGE}/lib/index.js`]: record('host-lib-index.js', ''),
  }
  const template = join(seed, 'profile-template')
  mkdirSync(join(template, 'node_modules'), { recursive: true })
  // The shape a seed-side install leaves: the build-time store and the temporary directory
  // pnpm installed in. Materialization has to correct both before pnpm will use the tree.
  writeFileSync(join(template, 'node_modules', '.modules.yaml'), [
    '"layoutVersion": 5,',
    '"nodeLinker": "hoisted",',
    '"storeDir": "C:\\\\Temp\\\\seed-build\\\\store\\\\v11",',
    '"virtualStoreDir": "C:\\\\Temp\\\\seed-build\\\\node_modules\\\\.pnpm",',
    '',
  ].join('\n'))
  create({
    cwd: template,
    file: join(seed, SEED_PROFILE_FILE_ARCHIVE),
    noDirRecurse: true,
    noMtime: true,
    portable: true,
    sync: true,
  }, ['node_modules/.modules.yaml'])
  rmSync(template, { recursive: true, force: true })
  writeFileSync(
    join(seed, SEED_PROFILE_LINK_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, links }, undefined, 2)}\n`,
  )
}

function writeCorePackageSet(seed: string, version: string): void {
  const packages = [
    { name: '@deepseek-ai/dsh', file: `deepseek-ai-dsh-${version}.tgz`, body: Buffer.from(`dsh-${version}`) },
    {
      name: '@deepseek-ai/dsh-desktop-host',
      file: `deepseek-ai-dsh-desktop-host-${version}.tgz`,
      body: Buffer.from(`desktop-host-${version}`),
    },
  ]
  mkdirSync(join(seed, DESKTOP_PACKAGES_DIR), { recursive: true })
  for (const entry of packages) writeFileSync(join(seed, DESKTOP_PACKAGES_DIR, entry.file), entry.body)
  writeFileSync(join(seed, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify({
    schemaVersion: 1,
    packages: packages.map(({ name, file, body }) => ({
      name,
      version,
      file,
      bytes: body.byteLength,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    })),
  })}\n`)
}

function createTestSeedMetadata(seed: string, desktopRelease: DesktopRelease): void {
  writeCorePackageSet(seed, desktopRelease.version)
  createSeedMetadata(seed, desktopRelease)
  // These specs cover the core install, the user-plugin mutations, and rollback. A seed
  // that already carries the bundled plugin set would make every profile start with those
  // plugins installed and activated, so the fixture strips the bundled plugins out of both
  // lists to keep the original transaction semantics under test.
  const manifestPath = join(seed, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  const installed = new Set(bundledPluginPackageNames())
  const activated = new Set(bundledPluginNames())
  for (const name of installed) delete manifest.dependencies[name]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => !activated.has(bundle))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function writeFakePnpm(root: string): string {
  const path = join(root, 'pnpm.mjs')
  writeFileSync(path, String.raw`
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
const project = process.cwd()
const command = args.find(value => value === 'install' || value === 'add' || value === 'remove')
const manifestPath = join(project, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageName = spec => spec.startsWith('@')
  ? spec.slice(0, spec.indexOf('@', spec.indexOf('/') + 1) === -1 ? undefined : spec.indexOf('@', spec.indexOf('/') + 1))
  : spec.split('@')[0]
const packageVersion = spec => {
  const index = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.indexOf('@')
  return index === -1 ? '1.0.0' : spec.slice(index + 1)
}

if (command === 'add') {
  const spec = args[args.indexOf('add') + 1]
  manifest.dependencies[packageName(spec)] = packageVersion(spec)
}
if (command === 'remove') delete manifest.dependencies[args[args.indexOf('remove') + 1]]
writeFileSync(manifestPath, JSON.stringify(manifest))
rmSync(join(project, 'node_modules'), { recursive: true, force: true })
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const packageRoot = join(project, 'node_modules', ...name.split('/'))
  mkdirSync(packageRoot, { recursive: true })
  const core = name === '@deepseek-ai/dsh' || name === '@deepseek-ai/dsh-desktop-host'
  const plugin = !core
  const installedVersion = plugin
    ? version
    : JSON.parse(readFileSync(join(project, 'desktop-release.json'), 'utf8')).version
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name, version: installedVersion,
    ...(plugin ? { dsh: { bundle: { patch: './bundle.yml' } } } : {}),
  }))
  if (plugin) writeFileSync(join(packageRoot, 'bundle.yml'), '[]\n')
  else if (name === '@deepseek-ai/dsh-desktop-host') {
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'lib', 'index.js'), '')
  }
}
writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
if (process.env.TEST_PNPM_LOG) writeFileSync(process.env.TEST_PNPM_LOG, JSON.stringify({ args, env: process.env }))
`)
  return path
}

function writeBlockingFakePnpm(root: string, ready: string, release: string): string {
  const path = join(root, 'blocking-pnpm.mjs')
  const delegate = writeFakePnpm(root)
  writeFileSync(path, `
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
writeFileSync(${JSON.stringify(ready)}, String(process.pid))
while (!existsSync(${JSON.stringify(release)})) await sleep(10)
await import(${JSON.stringify(pathToFileURL(delegate).href)})
`)
  return path
}

function hooks(overrides: Partial<DesktopProjectHooks> = {}): DesktopProjectHooks {
  return {
    healthCheck: async () => {},
    beforeActivate: async () => {},
    afterActivate: async () => {},
    ...overrides,
  }
}

function release(version = '1.0.0'): DesktopRelease {
  return {
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.17.0',
    pnpmVersion: '11.7.0',
  }
}

afterEach(async () => {
  const cleanups = releaseWorkers.splice(0)
  const directories = roots.splice(0)
  const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  for (const root of directories) rmSync(root, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'desktop worker cleanup failed')
})

describe('desktop package policy', () => {
  it('accepts registry package specs but rejects alternate sources and flags', () => {
    expect(packageNameFromSpec('@scope/plugin@1.2.3')).toBe('@scope/plugin')
    expect(packageNameFromSpec('plugin@next')).toBe('plugin')
    expect(() => packageNameFromSpec('file:../plugin')).toThrow(/unsupported npm package spec/u)
    expect(() => packageNameFromSpec('--registry=evil')).toThrow(/unsupported npm package spec/u)
    expect(() => packageNameFromSpec('https://example.test/plugin.tgz')).toThrow(/unsupported npm package spec/u)
  })

  it('rejects any seed content changed after release inventory generation', async () => {
    const seed = join(temporaryRoot(), 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeIntegrity(seed)
    await expect(verifySeedIntegrity(seed)).resolves.toBeUndefined()
    writeFileSync(join(seed, 'package.json'), '{}\n')
    await expect(verifySeedIntegrity(seed)).rejects.toThrow(/integrity verification failed/u)
  })
})

describe('desktop project transactions', () => {
  it('rebuilds a profile an interrupted first install left incomplete', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    writeFileSync(join(seed, 'store', 'seed-entry'), 'content')
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    // A first launch killed mid-install leaves a profile directory holding the copied
    // metadata but neither the release manifest nor installed packages. The release check
    // used to read `desktop-release.json` from exactly this tree and fail the whole launch
    // with an unactionable ENOENT; the absent manifest has to read as "no usable profile"
    // so the seed rebuilds it.
    mkdirSync(paths.profile, { recursive: true })
    for (const name of ['package.json', 'pnpm-workspace.yaml']) {
      writeFileSync(join(paths.profile, name), readFileSync(join(seed, name)))
    }
    expect(existsSync(join(paths.profile, 'desktop-release.json'))).toBe(false)
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)
    expect(manager.dshVersion()).toBe('1.0.0')
    expect(existsSync(join(paths.profile, 'desktop-release.json'))).toBe(true)
  })

  it('reuses an installed profile instead of verifying the seed it never reads', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)
    // A launch whose profile already holds this release consumes no seed content, so the seed
    // inventory is not re-read for it. Hashing the store archives to reach that same answer
    // would charge every launch for the cost of the first one.
    writeFileSync(join(seed, 'package.json'), '{}\n')
    await expect(verifySeedIntegrity(seed)).rejects.toThrow(/integrity verification failed/u)
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(false)
  })

  it('replaces an installed profile when the seed was rebuilt under the same version', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)

    // The same release version, rebuilt: the seed inventory changed, so the installed profile
    // is not this build. Version equality alone would keep serving the previous build's Host,
    // which is how a rebuilt installer of an unchanged version used to leave its own fixes
    // uninstalled.
    writeFileSync(join(seed, 'package.json'), `${readFileSync(join(seed, 'package.json'), 'utf8')}\n`)
    writeIntegrity(seed)

    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(false)
  })

  it('reuses a package store that already carries the seed', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    const first: string[] = []
    await expect(manager.applyRelease(seed, '1.0.0', hooks({ note: message => first.push(message) })))
      .resolves.toBe(true)
    expect(first).toContain('unpacking the bundled package store')

    // Losing the profile is the common case. The store is still this seed's, so the launch
    // rebuilds the tree and never unpacks the archives again.
    rmSync(paths.profile, { recursive: true, force: true })
    const second: string[] = []
    await expect(manager.applyRelease(seed, '1.0.0', hooks({ note: message => second.push(message) })))
      .resolves.toBe(true)
    expect(second).toContain('package store already carries this seed')
    expect(second).not.toContain('unpacking the bundled package store')
    expect(manager.dshVersion()).toBe('1.0.0')
  })

  it('reuses the store when a rebuild ships the same archives and differs only in application code', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)

    // A rebuilt installer of the same packages ships byte-identical archives: the profile has
    // to be rebuilt because its inventory moved, but unpacking those archives again would only
    // recreate entries the store already holds, and that unpack is the longest step of a
    // refresh. Keying the store marker on the archives is what lets this launch skip it.
    writeFileSync(join(seed, 'package.json'), `${readFileSync(join(seed, 'package.json'), 'utf8')}\n`)
    writeIntegrity(seed)
    const rebuilt: string[] = []
    await expect(manager.applyRelease(seed, '1.0.0', hooks({ note: message => rebuilt.push(message) })))
      .resolves.toBe(true)
    expect(rebuilt).toContain('package store already carries this seed')
    expect(rebuilt).not.toContain('unpacking the bundled package store')
  })

  it('rebuilds a profile left without its manifest instead of reading it as installed', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)

    // A removal that could not finish leaves the package tree without the profile's own
    // files. That tree is not an installed project: reading its plugin list raised ENOENT and
    // aborted the launch before it could rebuild, which is a startup failure a residue must
    // never cause.
    for (const entry of readdirSync(paths.profile)) {
      if (entry !== 'node_modules') rmSync(join(paths.profile, entry), { recursive: true, force: true })
    }
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)
    expect(existsSync(join(paths.profile, 'package.json'))).toBe(true)
    expect(existsSync(join(paths.rollback, 'node_modules'))).toBe(true)
  })

  it('installs the offline seed and reconciles a mismatched private Host', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    writeFileSync(join(seed, 'store', 'seed-entry'), 'content')
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await expect(manager.applyRelease(seed, '2.0.0', hooks())).rejects.toThrow(/does not match Electron/u)
    await manager.applyRelease(seed, '1.0.0', hooks())
    // An installed profile holds the store's own files as hard links, so a Host build that
    // differs has to arrive as its own file: writing through the link would rewrite the store
    // entry every profile shares.
    const hostManifest = join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json')
    rmSync(hostManifest)
    writeFileSync(hostManifest, '{"name":"@deepseek-ai/dsh-desktop-host","version":"0.9.0"}\n')
    await expect(manager.applyRelease(seed, '1.0.0', hooks())).resolves.toBe(true)
    expect(manager.dshVersion()).toBe('1.0.0')
    expect(manager.releaseVersion()).toBe('1.0.0')
    expect(paths.profile).toBe(join(root, '.dsh', 'profiles', 'desktop'))
    expect(existsSync(join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh'))).toBe(true)
    const installedHost = JSON.parse(readFileSync(
      join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'),
      'utf8',
    )) as { version: string }
    expect(installedHost.version).toBe('1.0.0')
    expect(existsSync(join(paths.profile, 'desktop-plugins.json'))).toBe(false)
    expect(readFileSync(join(paths.pnpm.store, 'seed-entry'), 'utf8')).toBe('content')
    // The rebuilt tree is the store's own files, not copies: pnpm would have written the same
    // bytes here at several times the cost of one link.
    const linked = statSync(join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const original = statSync(join(paths.pnpm.store, 'v11', 'files', 'dsh-package.json'))
    expect(linked.ino).toBe(original.ino)
    expect(linked.nlink).toBeGreaterThan(1)
  })

  it('restores the active project when the replacement backend cannot start', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await manager.applyRelease(seed, '1.0.0', hooks())
    let starts = 0
    await expect(manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks({
      afterActivate: async () => {
        starts += 1
        if (starts === 1) throw new Error('backend rejected staged graph')
      },
    }))).rejects.toThrow(/backend rejected staged graph/u)
    expect(manager.listPlugins()).toEqual([])
    expect(manager.dshVersion()).toBe('1.0.0')
    expect(starts).toBe(2)
  })

  it('restores rollback when the active move completed before its journal update', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await manager.applyRelease(seed, '1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    const stagingProfile = join(paths.staging, 'interrupted', 'profile')
    mkdirSync(stagingProfile, { recursive: true })
    writeFileSync(join(stagingProfile, 'marker'), 'staging')
    rmSync(paths.rollback, { recursive: true, force: true })
    mkdirSync(dirname(paths.rollback), { recursive: true })
    renameSync(paths.profile, paths.rollback)
    writeFileSync(paths.pending, `${JSON.stringify({
      schemaVersion: 1,
      id: 'interrupted',
      stagingProfile,
      step: 'prepared',
    })}\n`)

    manager.recover()

    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0' }])
    expect(existsSync(stagingProfile)).toBe(false)
    expect(existsSync(paths.pending)).toBe(false)
  })

  it('records the live pnpm worker as transaction owner until it exits', async ({ task, signal }) => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const ready = join(root, 'pnpm-ready')
    const releaseWorker = join(root, 'pnpm-release')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const runtime = { node: process.execPath, pnpm: writeBlockingFakePnpm(root, ready, releaseWorker) }
    const manager = new DesktopProjectManager(paths, runtime)
    await manager.applyRelease(seed, '1.0.0', hooks())
    // Only a dependency mutation spawns pnpm now; activation rebuilds the tree from the seed's
    // links. The lock still has to name whichever child is running, so drive it from a mutation.
    const installing = manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    // Teardown observes failures even if the runner has abandoned the test body.
    const completed = installing.then(value => ({ value }), (error: unknown) => ({ error }))
    releaseWorkers.push(async () => {
      writeFileSync(releaseWorker, 'continue')
      const outcome = await completed
      if ('error' in outcome) throw outcome.error
    })
    // Child startup shares the test budget; an aborted poll must not resume ownership assertions.
    await expect.poll(() => {
      signal.throwIfAborted()
      return existsSync(ready)
    }, { timeout: task.timeout }).toBe(true)
    signal.throwIfAborted()
    const workerPid = Number.parseInt(readFileSync(ready, 'utf8'), 10)
    expect(readFileSync(paths.lock, 'utf8')).toBe(`${String(workerPid)}\n`)
    const competing = new DesktopProjectManager(paths, runtime)
    await expect(competing.applyRelease(seed, '1.0.0', hooks())).rejects.toThrow(/another package transaction is active/u)
    writeFileSync(releaseWorker, 'continue')
    await expect(installing).resolves.toBeUndefined()
    expect(existsSync(paths.lock)).toBe(false)
  })

  it('keeps core packages local while installing plugins from the desktop registry', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const log = join(root, 'pnpm-log.json')
    createTestSeedMetadata(seed, release())
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeLinkedProfileSeed(seed, release())
    archiveStore(seed)
    writeIntegrity(seed)
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    await manager.applyRelease(seed, '1.0.0', hooks())
    const previousLog = process.env.TEST_PNPM_LOG
    process.env.TEST_PNPM_LOG = log
    try {
      await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    } finally {
      if (previousLog === undefined) delete process.env.TEST_PNPM_LOG
      else process.env.TEST_PNPM_LOG = previousLog
    }

    const manifest = JSON.parse(readFileSync(join(paths.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const coreSpec = manifest.dependencies['@deepseek-ai/dsh']
    expect(coreSpec).toMatch(/^file:\.\/desktop-packages\//u)
    expect(readFileSync(join(paths.profile, 'pnpm-workspace.yaml'), 'utf8'))
      .toContain(`${JSON.stringify('@deepseek-ai/dsh')}: ${JSON.stringify(coreSpec)}`)
    expect(manifest.dependencies['@scope/plugin']).toBe('2.0.0')
    const invocation = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; env: Record<string, string> }
    expect(invocation.args).toContain('add')
    expect(invocation.args).toContain('@scope/plugin@2.0.0')
    expect(invocation.args).toContain('--config.registry=https://registry.npmjs.org/')
    expect(invocation.args).toContain(`--config.store-dir=${paths.pnpm.store}`)
    expect(invocation.args).toContain('--config.enable-global-virtual-store=false')
    expect(invocation.env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org/')
    expect(invocation.env.NPM_CONFIG_STORE_DIR).toBe(paths.pnpm.store)
    expect(invocation.env.NPM_CONFIG_USERCONFIG).toBe(join(paths.pnpm.config, 'npmrc'))
    expect(invocation.env.npm_config_registry).toBeUndefined()
  })

  it('reconciles dsh to the packaged release without removing desktop plugins', async () => {
    const root = temporaryRoot()
    const paths = resolveDesktopPaths(join(root, '.dsh'))
    const manager = new DesktopProjectManager(paths, { node: process.execPath, pnpm: writeFakePnpm(root) })
    const firstSeed = join(root, 'seed-1')
    createTestSeedMetadata(firstSeed, release('1.0.0'))
    writeFileSync(join(firstSeed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    mkdirSync(join(firstSeed, 'store'), { recursive: true })
    writeFileSync(join(firstSeed, 'store', 'release-1'), 'one')
    writeLinkedProfileSeed(firstSeed, release('1.0.0'))
    archiveStore(firstSeed)
    writeIntegrity(firstSeed)
    await manager.applyRelease(firstSeed, '1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())

    const nextSeed = join(root, 'seed-2')
    createTestSeedMetadata(nextSeed, release('1.1.0'))
    writeFileSync(join(nextSeed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    mkdirSync(join(nextSeed, 'store'), { recursive: true })
    writeFileSync(join(nextSeed, 'store', 'release-2'), 'two')
    writeLinkedProfileSeed(nextSeed, release('1.1.0'))
    archiveStore(nextSeed)
    writeIntegrity(nextSeed)

    await expect(manager.applyRelease(nextSeed, '1.1.0', hooks())).resolves.toBe(true)
    expect(manager.releaseVersion()).toBe('1.1.0')
    expect(manager.dshVersion()).toBe('1.1.0')
    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0' }])
    const profile = JSON.parse(readFileSync(join(paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@scope/plugin',
    ])
    expect(readFileSync(join(paths.pnpm.store, 'release-1'), 'utf8')).toBe('one')
    expect(readFileSync(join(paths.pnpm.store, 'release-2'), 'utf8')).toBe('two')
    await expect(manager.applyRelease(nextSeed, '1.1.0', hooks())).resolves.toBe(false)
  })
})
