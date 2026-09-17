/** Transactional owner of the reserved desktop profile and its private pnpm state. */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { bundledPluginDependencies, bundledPluginNames } from './bundled-plugins.ts'
import {
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  desktopDshPackageSpec,
  readDesktopCorePackageSet,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import { yieldToEventLoop } from './event-loop.ts'
import { removeOwnedDirectory, renameOwnedDirectory } from './owned-directory.ts'
import type { DesktopPaths } from './paths.ts'
import { parseDesktopRelease, type DesktopRelease } from './release.ts'
import {
  SEED_STORE_ARCHIVE_DIR,
  extractPnpmStoreArchives,
  materializeLinkedProfile,
  mergePnpmStore,
} from './seed-store.ts'

/**
 * Profile record of the seed this profile was installed from.
 *
 * A release version does not identify a build: two seeds of the same version can carry
 * different packaged packages, which is exactly what a rebuilt installer has. The seed's own
 * integrity inventory changes whenever any seed file does, so its digest names one exact seed
 * and a profile that records a different one is not current.
 */
export const DESKTOP_SEED_IDENTITY_FILE = 'desktop-seed.json'

/** Installed profile's record of the seed it was built from. */
interface DesktopSeedIdentity {
  readonly schemaVersion: 1
  /** Hex SHA-256 of the seed's `integrity.json`. */
  readonly integrity: string
}

/**
 * Record, beside the persistent store, which store archives it was last merged from.
 *
 * Unpacking the seed's archives costs far more than any other step of a refresh, and the
 * result is identical whenever the archives are: this marker lets a launch that only needs the
 * profile rebuilt skip the store work entirely. It is keyed on the archives rather than on the
 * whole seed because a rebuilt installer usually ships the same packages and differs only in
 * the application code around them. A marker that does not match is not an error, it just
 * means the store has to be merged again.
 */
const STORE_SEED_FILE = 'store-seed.json'

/** Store's record of the seed archives it was merged from. */
interface DesktopStoreSeedRecord {
  readonly schemaVersion: 1
  /** Hex SHA-256 of the seed's store archive records. */
  readonly archives: string
}

/** Files the package transaction copies between active and staging projects. */
const DESKTOP_PROJECT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'desktop-release.json',
  DESKTOP_SEED_IDENTITY_FILE,
  DESKTOP_PACKAGE_SET_FILE,
] as const

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
}

/** Installed desktop project manifest slice. */
interface DesktopProjectManifest {
  readonly name: string
  readonly private: true
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly profile: {
      readonly bundles: string[]
    }
  }
}

/** Journaled activation step used for crash recovery. */
interface DesktopPendingTransaction {
  readonly schemaVersion: 1
  readonly id: string
  readonly stagingProfile: string
  readonly step: 'prepared' | 'active-moved' | 'staging-activated'
}

/** Exact executables the desktop shell bundles. */
export interface DesktopRuntimeExecutables {
  readonly node: string
  readonly pnpm: string
}

/** Hooks that bind project replacement to backend lifecycle and health. */
export interface DesktopProjectHooks {
  /** Prove the staged dependency graph while the active backend is stopped. */
  healthCheck(projectDir: string): Promise<void>
  /** Stop the active backend and await process exit before directory moves. */
  beforeActivate(): Promise<void>
  /** Start the selected active project after commit or rollback. */
  afterActivate(): Promise<void>
  /**
   * Report one phase of a long transaction for the run log.
   *
   * A first launch spends minutes unpacking and installing the seed, and the shell has no
   * other progress to show for that time.
   * @param message - one line naming the phase that just finished or is about to start.
   */
  note?(message: string): void
  /**
   * Report how far the transaction has come, for the window the shell shows while it runs.
   * @param progress - completed fraction of the transaction, from 0 through 1.
   */
  progress?(progress: number): void
}

/** Supported dependency mutation. */
export type DesktopProjectMutation =
  | { readonly type: 'plugin-add'; readonly spec: string }
  | { readonly type: 'plugin-remove'; readonly name: string }
  | { readonly type: 'plugin-update'; readonly name: string; readonly version: string }

interface DesktopSeedIntegrityRecord {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function releaseFile(projectDir: string): DesktopRelease {
  return parseDesktopRelease(readJson(join(projectDir, 'desktop-release.json')))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDescendant(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`desktop project: invalid npm package name ${JSON.stringify(name)}`)
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`desktop project: invalid exact version ${JSON.stringify(version)}`)
}

/**
 * Validate one registry package spec and return its requested package name when explicit.
 * @param spec - npm registry name with an optional version or tag.
 * @returns package name, or undefined when the spec's final name is registry-resolved.
 */
export function packageNameFromSpec(spec: string): string | undefined {
  if (spec === '' || spec.startsWith('-') || /[\s\\]/u.test(spec) || spec.includes('://') || spec.startsWith('file:')) {
    throw new Error(`desktop project: unsupported npm package spec ${JSON.stringify(spec)}`)
  }
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash === -1) throw new Error(`desktop project: invalid scoped package spec ${JSON.stringify(spec)}`)
    const versionAt = spec.indexOf('@', slash)
    const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
    assertPackageName(name)
    if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
    return name
  }
  const versionAt = spec.indexOf('@')
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
  assertPackageName(name)
  if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
  return name
}

function copyMetadata(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const filename of DESKTOP_PROJECT_FILES) {
    const from = join(source, filename)
    if (existsSync(from)) copyFileSync(from, join(target, filename), constants.COPYFILE_EXCL)
  }
  cpSync(join(source, DESKTOP_PACKAGES_DIR), join(target, DESKTOP_PACKAGES_DIR), {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
}

/**
 * Inventory one seed tree, hashing every file it ships.
 *
 * The walk yields between files: the shell serves its own windows, and a launch that never
 * yields also stops the startup window from loading.
 * @param root - seed directory to inventory, excluding its own integrity inventory.
 * @returns one record per file, in path order.
 */
async function seedFiles(root: string): Promise<readonly DesktopSeedIntegrityRecord[]> {
  const paths: string[] = []
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = path.slice(root.length + 1).split(sep).join('/')
      if (relativePath === 'integrity.json') continue
      if (entry.isSymbolicLink()) throw new Error(`desktop seed: symbolic link is not allowed: ${relativePath}`)
      if (entry.isDirectory()) {
        collect(path)
        continue
      }
      if (!entry.isFile()) throw new Error(`desktop seed: unsupported file type: ${relativePath}`)
      paths.push(relativePath)
    }
  }
  collect(root)
  paths.sort((left, right) => left.localeCompare(right))
  const files: DesktopSeedIntegrityRecord[] = []
  for (const relativePath of paths) {
    const body = readFileSync(join(root, ...relativePath.split('/')))
    files.push({
      path: relativePath,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
    await yieldToEventLoop()
  }
  return files
}

/**
 * Read one seed's integrity inventory, rejecting a record the caller cannot act on.
 *
 * Both the verification walk and the digests taken from the same inventory read it here, so a
 * malformed record is refused once, in the place that owns the file's format.
 * @param seedDir - seed directory that carries `integrity.json`.
 * @returns one record per shipped file, in path order.
 */
function readSeedIntegrity(seedDir: string): readonly DesktopSeedIntegrityRecord[] {
  const integrityPath = join(seedDir, 'integrity.json')
  const integrity = readJson(integrityPath)
  if (!isRecord(integrity) || integrity.schemaVersion !== 2 || !Array.isArray(integrity.files)) {
    throw new Error(`desktop seed: invalid integrity inventory ${integrityPath}`)
  }
  return integrity.files.map((record): DesktopSeedIntegrityRecord => {
    if (!isRecord(record) || typeof record.path !== 'string' || record.path === '' || record.path.startsWith('/')
      || record.path.split('/').includes('..') || typeof record.bytes !== 'number'
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new Error(`desktop seed: invalid integrity record in ${integrityPath}`)
    }
    return { path: record.path, bytes: record.bytes, sha256: record.sha256 }
  }).sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Verify the packaged offline seed before any content enters writable desktop state.
 * @param seedDir - packaged seed directory described by its own integrity inventory.
 * @returns resolves once every shipped seed file matches the inventory.
 */
export async function verifySeedIntegrity(seedDir: string): Promise<void> {
  const expected = readSeedIntegrity(seedDir)
  const actual = await seedFiles(seedDir)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('desktop seed: integrity verification failed')
  }
}

/**
 * Digest one seed's content inventory.
 *
 * The inventory lists a hash per seed file, so hashing the inventory itself identifies the
 * whole seed without re-reading its archives on every launch.
 * @param seedDir - seed directory that carries `integrity.json`.
 * @returns hex SHA-256 of the inventory.
 */
function seedIdentity(seedDir: string): string {
  return createHash('sha256').update(readFileSync(join(seedDir, 'integrity.json'))).digest('hex')
}

/**
 * Digest the part of one seed's inventory the persistent package store is built from.
 *
 * A rebuilt installer usually ships the same packages and differs only in the application code
 * around them, so this digest is what decides whether the archives have to be unpacked again.
 * Every profile link the seed records resolves against a file these archives publish, so a
 * store that carries them carries every target the rebuilt tree links to.
 * @param seedDir - seed directory that carries `integrity.json`.
 * @returns hex SHA-256 over the seed's store archive records.
 */
function storeIdentity(seedDir: string): string {
  const archives = readSeedIntegrity(seedDir)
    .filter(record => record.path.startsWith(`${SEED_STORE_ARCHIVE_DIR}/`))
  if (archives.length === 0) throw new Error(`desktop seed: ${seedDir} ships no pnpm store archives`)
  return createHash('sha256').update(JSON.stringify(archives)).digest('hex')
}

/**
 * Read the seed a profile was installed from.
 * @param projectDir - active desktop profile.
 * @returns recorded inventory digest, or undefined when the profile predates the record.
 */
function profileSeedIdentity(projectDir: string): string | undefined {
  const path = join(projectDir, DESKTOP_SEED_IDENTITY_FILE)
  if (!existsSync(path)) return undefined
  const value = readJson(path)
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.integrity !== 'string' || !/^[a-f0-9]{64}$/u.test(value.integrity)) {
    throw new Error(`desktop project: invalid seed identity ${path}`)
  }
  return value.integrity
}

/**
 * Report whether one workspace file still carries the core package mapping.
 *
 * pnpm appends its own sections to this file as it installs — `minimumReleaseAgeExclude`
 * records dependencies it accepted past the release-age policy — so the file is checked for
 * the mapping it has to keep rather than for whole-file equality with what the desktop wrote.
 * An appended section is pnpm's own record; a changed or missing override is not.
 * @param content - current `pnpm-workspace.yaml` body.
 * @param overrides - core package overrides the profile must still map to local tarballs.
 * @returns whether every override survives in the file.
 */
function workspaceMappingIsIntact(content: string, overrides: Readonly<Record<string, string>>): boolean {
  if (!content.includes('nodeLinker: hoisted')) return false
  return Object.entries(overrides).every(([name, spec]) =>
    content.includes(`  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`))
}

function projectManifest(projectDir: string): DesktopProjectManifest {
  const path = join(projectDir, 'package.json')
  const value = readJson(path)
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || value.name !== PROJECT_NAME || value.private !== true
    || typeof value.version !== 'string' || !isRecord(value.dependencies)
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  const manifest = value as unknown as DesktopProjectManifest
  const packageSet = readDesktopCorePackageSet(projectDir, releaseFile(projectDir).version)
  const expectedOverrides = desktopCorePackageOverrides(packageSet)
  if (manifest.dependencies[DSH_PACKAGE] !== desktopDshPackageSpec(packageSet)
    || Object.entries(expectedOverrides).some(([name, spec]) => manifest.dependencies[name] !== spec)
    || !workspaceMappingIsIntact(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf8'), expectedOverrides)) {
    throw new Error(`desktop project: core package mapping does not match ${DESKTOP_PACKAGE_SET_FILE}`)
  }
  return manifest
}

function profilePluginNames(projectDir: string): readonly string[] {
  const bundles = projectManifest(projectDir).dsh.profile.bundles
  if (!DESKTOP_PROFILE_BUNDLES.every((bundle, index) => bundles[index] === bundle)) {
    throw new Error('desktop project: profile must begin with the built-in desktop bundle list')
  }
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  for (const plugin of plugins) assertPackageName(plugin)
  return plugins
}

function pluginRecords(projectDir: string): readonly DesktopPluginRecord[] {
  return profilePluginNames(projectDir).map(name => inspectPlugin(projectDir, name))
}

function writeProfilePlugins(projectDir: string, plugins: readonly DesktopPluginRecord[]): void {
  const manifest = projectManifest(projectDir)
  writeJson(join(projectDir, 'package.json'), {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...plugins.map(plugin => plugin.name)],
      },
    },
  } satisfies DesktopProjectManifest)
}

function inspectPlugin(projectDir: string, requestedName: string): DesktopPluginRecord {
  const manifestPath = join(projectDir, 'node_modules', ...requestedName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has no manifest`)
  }
  const manifest = readJson(manifestPath)
  if (!isRecord(manifest) || manifest.name !== requestedName || typeof manifest.version !== 'string') {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has inconsistent name or version`)
  }
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  if (typeof patch !== 'string' || patch === '') {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} does not declare dsh.bundle.patch`)
  }
  const packageDir = dirname(manifestPath)
  const patchPath = resolve(packageDir, patch)
  if ((patchPath !== packageDir && !patchPath.startsWith(packageDir + sep)) || !existsSync(patchPath)) {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} declares an invalid bundle patch`)
  }
  return { name: requestedName, version: manifest.version }
}

/** Transactional desktop npm project manager. */
export class DesktopProjectManager {
  private lockDescriptor: number | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute bundled Node.js and pnpm entry paths.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
  ) {}

  /** Recover an interrupted directory replacement before reading the active project. */
  recover(): void {
    if (!existsSync(this.paths.pending)) return
    const value = readJson(this.paths.pending)
    if (!isRecord(value) || value.schemaVersion !== 1
      || typeof value.id !== 'string' || typeof value.stagingProfile !== 'string'
      || !isDescendant(this.paths.staging, value.stagingProfile)
      || (value.step !== 'prepared' && value.step !== 'active-moved' && value.step !== 'staging-activated')) {
      throw new Error(`desktop project: invalid activation journal ${this.paths.pending}`)
    }
    const pending: DesktopPendingTransaction = {
      schemaVersion: 1,
      id: value.id,
      stagingProfile: value.stagingProfile,
      step: value.step,
    }
    if (!existsSync(this.paths.profile) && existsSync(this.paths.rollback)) {
      mkdirSync(dirname(this.paths.profile), { recursive: true })
      renameOwnedDirectory(this.paths.rollback, this.paths.profile)
    }
    removeOwnedDirectory(pending.stagingProfile)
    unlinkSync(this.paths.pending)
  }

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    return pluginRecords(this.paths.profile)
  }

  /** Read the exact dsh version installed in the active desktop project. */
  dshVersion(): string {
    if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
    return this.installedPackageVersion(DSH_PACKAGE)
  }

  private installedPackageVersion(packageName: string): string {
    const manifestPath = join(this.paths.profile, 'node_modules', ...packageName.split('/'), 'package.json')
    const manifest = readJson(manifestPath)
    if (!isRecord(manifest) || typeof manifest.version !== 'string') {
      throw new Error(`desktop project: installed ${packageName} package has no version`)
    }
    assertVersion(manifest.version)
    return manifest.version
  }

  /** Read the release version applied to the active desktop project. */
  releaseVersion(): string {
    if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
    return releaseFile(this.paths.profile).version
  }

  /**
   * Report whether the installed profile is already this exact release and seed.
   *
   * A profile directory can exist without being usable: a first launch that was killed
   * mid-install, or a terminated package transaction, leaves a partial tree holding some
   * metadata and no installed packages. Every fact this asks for is then absent, so a
   * missing manifest answers "no" and lets the caller rebuild the profile instead of
   * failing the launch with an unactionable ENOENT. Any other read failure still throws:
   * a profile that is present but broken is a fault the caller must see rather than a
   * profile to silently discard.
   * @param expectedVersion - version the bundled seed requires.
   * @param expectedIdentity - inventory digest of the seed that will be installed.
   * @returns whether the active project is installed and matches that version and seed.
   */
  private profileMatchesRelease(expectedVersion: string, expectedIdentity: string): boolean {
    if (!existsSync(this.paths.profile)) return false
    try {
      return this.releaseVersion() === expectedVersion
        && this.dshVersion() === expectedVersion
        && this.installedPackageVersion(DESKTOP_HOST_PACKAGE) === expectedVersion
        && profileSeedIdentity(this.paths.profile) === expectedIdentity
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      return false
    }
  }

  /**
   * Report whether the active profile directory holds a usable installed project.
   *
   * The profile is read as a project only when its own manifest can be read: a tree that lost
   * its manifest — the residue of an interrupted install, or of a removal that could not
   * finish — has no release to reuse and no plugin list to carry forward, and reading it as an
   * installed project is what aborts the launch with a missing file instead of rebuilding it.
   * `activate` still moves the residue aside before publishing the new profile.
   * @returns whether the active profile's project manifest is readable.
   */
  private hasInstalledProfile(): boolean {
    if (!existsSync(join(this.paths.profile, 'node_modules'))) return false
    try {
      projectManifest(this.paths.profile)
      return true
    } catch {
      // Every way `projectManifest` refuses a directory means the same thing here: this tree
      // states no project the rebuild cannot recreate from the seed archives.
      return false
    }
  }

  /** Install or reconcile the active project to the Electron package's exact release. */
  async applyRelease(seedDir: string, electronVersion: string, hooks: DesktopProjectHooks): Promise<boolean> {
    const note = (message: string): void => { hooks.note?.(message) }
    const progress = (fraction: number): void => { hooks.progress?.(fraction) }
    return this.withLock(async () => {
      this.recover()
      // The release identity is read before the seed is verified so an installed profile can
      // answer first. A launch that reuses its profile never reads seed content, and hashing
      // the seed's store archives to decide that would charge every launch for the work of
      // the first one. The inventory digest is the exception: it is one small file, and it is
      // what makes a rebuilt installer of the same version replace a stale profile.
      const target = releaseFile(seedDir)
      const identity = seedIdentity(seedDir)
      if (target.version !== electronVersion) {
        throw new Error(`desktop project: seed ${target.version} does not match Electron ${electronVersion}`)
      }
      if (this.profileMatchesRelease(target.version, identity)) {
        verifyDesktopCorePackageSet(this.paths.profile, target.version)
        note(`desktop runtime ${target.version} is already installed`)
        return false
      }
      // Everything below consumes seed content, so the seed is verified before any of it
      // reaches writable desktop state.
      await verifySeedIntegrity(seedDir)
      note('bundled seed verified')
      progress(0.15)
      verifyDesktopCorePackageSet(seedDir, target.version)
      // The store is keyed on the archives it was built from, not on the whole inventory: a
      // rebuild that changes only the application code publishes the same archives, and
      // unpacking them again would recreate entries the store already holds.
      const archives = storeIdentity(seedDir)
      if (this.storeMatchesSeed(archives)) {
        note('package store already carries this seed')
      } else {
        note('unpacking the bundled package store')
        progress(0.3)
        await this.mergeSeedPnpmState(seedDir)
        this.recordStoreSeed(archives)
        note('package store ready; rebuilding the desktop runtime')
        progress(0.45)
      }
      const stagingProfile = this.newStagingProfile()
      try {
        // The seed carries the installed tree as links into the store it just published, so
        // the runtime is rebuilt here instead of installed: pnpm would recreate exactly these
        // files, at several times the cost of one link each.
        // The seed's tree already carries every bundled plugin at its pinned version, so a
        // profile that only names those needs no pnpm run at all. A plugin the user added, or
        // one they moved to another version, is the only thing restored from the store.
        const bundled = bundledPluginDependencies()
        const plugins = (this.hasInstalledProfile() ? pluginRecords(this.paths.profile) : [])
          .filter(plugin => bundled[plugin.name] !== plugin.version)
        copyMetadata(seedDir, stagingProfile)
        await materializeLinkedProfile(seedDir, stagingProfile, this.paths.pnpm.store, this.paths.profile)
        writeJson(join(stagingProfile, DESKTOP_SEED_IDENTITY_FILE), {
          schemaVersion: 1,
          integrity: identity,
        } satisfies DesktopSeedIdentity)
        note('desktop runtime linked from the package store')
        progress(0.75)
        if (plugins.length > 0) {
          note(`restoring ${String(plugins.length)} desktop plugin(s)`)
          await this.runPnpm(stagingProfile, [
            'add',
            ...plugins.map(plugin => `${plugin.name}@${plugin.version}`),
            '--save-exact',
            '--offline',
          ])
          writeProfilePlugins(stagingProfile, plugins)
        }
        note('verifying the staged runtime')
        progress(0.85)
        await hooks.healthCheck(stagingProfile)
        note('staged runtime boots; activating it')
        progress(0.9)
        await this.activate(stagingProfile, hooks)
        note('desktop runtime activated')
        progress(0.94)
        return true
      } catch (error) {
        this.discardStaging(stagingProfile, error)
      }
    })
  }

  /**
   * Remove a failed staging profile without discarding the failure that created it.
   *
   * The staging tree was just used by the Host, so removing it can report its own EPERM
   * while the real reason the transaction failed is something else entirely. Letting that
   * cleanup error replace the original leaves the user with an unactionable permission
   * failure on first launch, so the original stays primary and the cleanup failure is
   * attached to it.
   * @param stagingProfile - staging tree the failed transaction left behind.
   * @param error - failure that aborted the transaction.
   */
  private discardStaging(stagingProfile: string, error: unknown): never {
    let cleanupFailure: unknown
    try {
      removeOwnedDirectory(stagingProfile)
    } catch (failure) {
      cleanupFailure = failure
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure],
        `${errorOf(error, 'desktop project: profile activation failed').message}`
        + ' (staging cleanup also failed)',
      )
    }
    throw error
  }

  /** Apply one exact dependency mutation through a staging project. */
  async mutate(mutation: DesktopProjectMutation, hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      this.recover()
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      verifyDesktopCorePackageSet(this.paths.profile, this.releaseVersion())
      const stagingProfile = this.newStagingProfile()
      try {
        copyMetadata(this.paths.profile, stagingProfile)
        await this.applyMutation(stagingProfile, mutation)
        await hooks.healthCheck(stagingProfile)
        await this.activate(stagingProfile, hooks)
      } catch (error) {
        this.discardStaging(stagingProfile, error)
      }
    })
  }

  private newStagingProfile(): string {
    const path = join(this.paths.staging, randomUUID(), 'profile')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }

  private async applyMutation(projectDir: string, mutation: DesktopProjectMutation): Promise<void> {
    switch (mutation.type) {
      case 'plugin-add': {
        const requestedName = packageNameFromSpec(mutation.spec)
        if (requestedName === undefined) throw new Error('desktop project: plugin package name is required')
        await this.runPnpm(projectDir, ['add', mutation.spec, '--save-exact'])
        const installed = inspectPlugin(projectDir, requestedName)
        const current = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
        writeProfilePlugins(
          projectDir,
          [...current, installed].sort((left, right) => left.name.localeCompare(right.name)),
        )
        return
      }
      case 'plugin-remove': {
        assertPackageName(mutation.name)
        if (!profilePluginNames(projectDir).includes(mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== mutation.name)
        await this.runPnpm(projectDir, ['remove', mutation.name])
        writeProfilePlugins(projectDir, remaining)
        return
      }
      case 'plugin-update':
        assertPackageName(mutation.name)
        assertVersion(mutation.version)
        if (!profilePluginNames(projectDir).includes(mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        await this.runPnpm(projectDir, ['add', `${mutation.name}@${mutation.version}`, '--save-exact'])
        {
          const installed = inspectPlugin(projectDir, mutation.name)
          writeProfilePlugins(
            projectDir,
            pluginRecords(projectDir).map(plugin => plugin.name === installed.name ? installed : plugin),
          )
        }
        return
      default:
        mutation satisfies never
    }
  }

  /**
   * Report whether the persistent store already carries this seed's archives.
   * @param archives - store archive digest of the seed about to be installed.
   * @returns whether the store needs no further merging for those archives.
   */
  private storeMatchesSeed(archives: string): boolean {
    if (!existsSync(this.paths.pnpm.store)) return false
    const path = join(this.paths.pnpm.root, STORE_SEED_FILE)
    if (!existsSync(path)) return false
    try {
      const value = readJson(path)
      return isRecord(value) && value.schemaVersion === 1 && value.archives === archives
    } catch {
      // An unreadable marker costs one merge and is then rewritten, so it is never a fault.
      return false
    }
  }

  private recordStoreSeed(archives: string): void {
    writeJson(join(this.paths.pnpm.root, STORE_SEED_FILE), {
      schemaVersion: 1,
      archives,
    } satisfies DesktopStoreSeedRecord)
  }

  private async mergeSeedPnpmState(seedDir: string): Promise<void> {
    const transactionRoot = join(this.paths.staging, randomUUID())
    const extractedStore = join(transactionRoot, 'store')
    try {
      await extractPnpmStoreArchives(seedDir, extractedStore)
      await mergePnpmStore(extractedStore, this.paths.pnpm.store)
    } finally {
      removeOwnedDirectory(transactionRoot)
    }
  }

  private async activate(stagingProfile: string, hooks: DesktopProjectHooks): Promise<void> {
    const pending: DesktopPendingTransaction = {
      schemaVersion: 1,
      id: basename(dirname(stagingProfile)),
      stagingProfile,
      step: 'prepared',
    }
    writeJson(this.paths.pending, pending)
    await hooks.beforeActivate()
    let activeMoved = false
    try {
      removeOwnedDirectory(this.paths.rollback)
      mkdirSync(dirname(this.paths.rollback), { recursive: true, mode: 0o700 })
      writeJson(this.paths.pending, { ...pending, step: 'active-moved' } satisfies DesktopPendingTransaction)
      if (existsSync(this.paths.profile)) {
        renameOwnedDirectory(this.paths.profile, this.paths.rollback)
        activeMoved = true
      }
      mkdirSync(dirname(this.paths.profile), { recursive: true, mode: 0o700 })
      writeJson(this.paths.pending, { ...pending, step: 'staging-activated' } satisfies DesktopPendingTransaction)
      renameOwnedDirectory(stagingProfile, this.paths.profile)
      await hooks.afterActivate()
      unlinkSync(this.paths.pending)
    } catch (error) {
      if (existsSync(this.paths.profile)) removeOwnedDirectory(this.paths.profile)
      if (activeMoved && existsSync(this.paths.rollback)) renameOwnedDirectory(this.paths.rollback, this.paths.profile)
      if (existsSync(this.paths.pending)) unlinkSync(this.paths.pending)
      await hooks.afterActivate().catch(() => undefined)
      throw error
    }
  }

  private async runPnpm(projectDir: string, args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop project: pnpm command is required')
    for (const path of [this.paths.root, this.paths.pnpm.store, this.paths.pnpm.cache,
      this.paths.pnpm.state, this.paths.pnpm.config, this.paths.pnpm.home]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const npmrc = join(this.paths.pnpm.config, 'npmrc')
    if (!existsSync(npmrc)) writeFileSync(npmrc, '', { mode: 0o600 })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    )))
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, [
        this.runtime.pnpm,
        `--config.registry=${DESKTOP_REGISTRY}`,
        `--config.store-dir=${this.paths.pnpm.store}`,
        '--config.enable-global-virtual-store=false',
        `--config.userconfig=${npmrc}`,
        command,
        ...commandArgs,
      ], {
        cwd: projectDir,
        env: {
          ...inherited,
          COREPACK_HOME: this.paths.pnpm.home,
          NPM_CONFIG_REGISTRY: DESKTOP_REGISTRY,
          NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
          NPM_CONFIG_USERCONFIG: npmrc,
          PATH: `${dirname(this.runtime.node)}${delimiter}${process.env.PATH ?? ''}`,
          PNPM_HOME: this.paths.pnpm.home,
          XDG_CACHE_HOME: this.paths.pnpm.cache,
          XDG_CONFIG_HOME: this.paths.pnpm.config,
          XDG_STATE_HOME: this.paths.pnpm.state,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const childPid = child.pid
      if (childPid === undefined) {
        child.kill('SIGKILL')
        reject(new Error('desktop project: pnpm did not report a process id'))
        return
      }
      try {
        this.writeLockOwner(childPid)
      } catch (error) {
        child.kill('SIGKILL')
        reject(errorOf(error, 'desktop project: failed to assign the package transaction lock to pnpm'))
        return
      }
      let diagnostics = ''
      let completed = false
      const appendDiagnostics = (chunk: string): void => {
        diagnostics = (diagnostics + chunk).slice(-MAX_PNPM_DIAGNOSTIC_BYTES)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', appendDiagnostics)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', appendDiagnostics)
      const complete = (settleChild: () => void): void => {
        if (completed) return
        completed = true
        try {
          this.writeLockOwner(process.pid)
        } catch (error) {
          reject(errorOf(error, 'desktop project: failed to return the package transaction lock to Electron'))
          return
        }
        settleChild()
      }
      child.once('error', (error) => { complete(() => { reject(error) }) })
      child.once('close', (code, signal) => {
        complete(() => {
          if (code === 0) {
            settle()
            return
          }
          reject(new Error(
            `desktop project: pnpm exited with ${String(code ?? signal)}${diagnostics.trim() === '' ? '' : `: ${diagnostics.trim()}`}`,
          ))
        })
      })
    })
  }

  private writeLockOwner(pid: number): void {
    const descriptor = this.lockDescriptor
    if (descriptor === undefined) throw new Error('desktop project: package transaction lost its lock')
    const content = Buffer.from(`${String(pid)}\n`)
    ftruncateSync(descriptor, 0)
    writeSync(descriptor, content, 0, content.byteLength, 0)
    fsyncSync(descriptor)
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 })
    let descriptor: number
    try {
      descriptor = openSync(this.paths.lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(this.paths.lock)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: package transaction lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(this.paths.lock, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another package transaction is active')
        unlinkSync(this.paths.lock)
        descriptor = openSync(this.paths.lock, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      this.lockDescriptor = descriptor
      this.writeLockOwner(process.pid)
      return await operation()
    } finally {
      this.lockDescriptor = undefined
      closeSync(descriptor)
      unlinkSync(this.paths.lock)
    }
  }
}

/**
 * Create seed metadata for one exact Electron and dsh release.
 *
 * The bundled third-party plugins are declared here rather than only in the profile because
 * the seed manifest is what `applyRelease` copies into a fresh profile, and because
 * `prepare-seed` installs this exact dependency set to warm the archived pnpm store. Both
 * the dependencies and the bundle list are therefore inherited by the first launch.
 */
export function createSeedMetadata(seedDir: string, release: DesktopRelease): void {
  mkdirSync(seedDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(seedDir, release.version)
  const manifest: DesktopProjectManifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: { ...desktopCorePackageOverrides(packageSet), ...bundledPluginDependencies() },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES, ...bundledPluginNames()] } },
  }
  writeJson(join(seedDir, 'package.json'), manifest)
  writeFileSync(
    join(seedDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
  writeJson(join(seedDir, 'desktop-release.json'), release)
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
  writeJson(join(projectDir, 'desktop-release.json'), release)
}
