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
import { readFile } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { bundledPluginDependencies, bundledPluginNames, bundledPluginPackageNames } from './bundled-plugins.ts'
import {
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  desktopDshPackageSpec,
  readDesktopCorePackageSet,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
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

/** Manifest that marks a directory as a desktop project; the move-aside takes it with the tree. */
const DESKTOP_PROJECT_MANIFEST_FILE = DESKTOP_PROJECT_FILES[0]

/** Number of seed files hashed at once when verifying a seed's integrity. */
const SEED_HASH_CONCURRENCY = 8

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
  /**
   * Whether this release ships the plugin, which fixes both its version and its
   * presence. The Desktop plugin window reports it so the row can state the
   * fact instead of offering controls the Host refuses.
   */
  readonly bundled: boolean
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

/**
 * Journaled activation step used for crash recovery.
 *
 * `prepared` is written before the active profile moves, `active-moved` once it has, and
 * `staging-activated` only after the replacement booted — which is what makes the last step the
 * record that separates an activation to keep from one to repair.
 */
interface DesktopPendingTransaction {
  readonly schemaVersion: 1
  readonly id: string
  readonly stagingProfile: string
  readonly step: 'prepared' | 'active-moved' | 'staging-activated'
}

/** What an interrupted activation left behind and what recovery did about it. */
export interface DesktopRecoveryReport {
  /** Journaled step the interrupted launch reached before it stopped. */
  readonly step: 'prepared' | 'active-moved' | 'staging-activated'
  /** Directory that held the previous runtime when the interrupted launch moved it aside. */
  readonly rollback: string
  /** Whether the previous runtime was put back as the active profile. */
  readonly restored: boolean
  /** Whether a superseded runtime copy left beside the active profile was discarded. */
  readonly discardedRollback: boolean
  /** Whether the interrupted launch's staging tree was discarded. */
  readonly discardedStaging: boolean
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
  /**
   * Name the step the following progress belongs to, and report that step's own fraction.
   *
   * `progress` says how far the whole transaction has come; on a first launch it also moves so
   * slowly within one step that the bar alone cannot tell work from a hang. This carries the step's
   * own share, which is the figure a user can watch while one step runs.
   * @param label - short name of the step, in the language the shell shows.
   * @param fraction - completed fraction of that step, from 0 through 1.
   */
  step?(label: string, fraction: number): void
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

/** The plugins this release ships, whose versions and presence the release owns. */
const BUNDLED_PLUGIN_NAMES = new Set(bundledPluginPackageNames())

/**
 * Refuse a mutation aimed at a plugin this release ships.
 *
 * A bundled plugin's version is pinned by three things that must agree — the
 * offline store warmed at build time, the profile manifest, and the bundle list
 * — so moving one off its version leaves the next launch unable to install
 * without a network. The Desktop plugin window states the fact on the row; this
 * refusal is what enforces it, because the mutation is the operation that would
 * perform the change.
 * @param name - plugin package name the mutation names.
 */
function assertNotBundled(name: string): void {
  if (!BUNDLED_PLUGIN_NAMES.has(name)) return
  throw new Error(`desktop project: ${JSON.stringify(name)} is bundled with Harness-CN and cannot be changed`)
}
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024

/**
 * Registry this product installs plugins from when the machine names none.
 *
 * It is a fallback rather than the policy: a user behind a mirror or a proxy states their own
 * registry, and an installation that ignored that would refuse to install anything on the machines
 * that need it most. What still holds is the shape — the value this product acts on is a registry
 * origin it validated, never something a page or a package spec can name.
 *
 * It is not npmjs, because the machines this product ships to reach npmjs through a proxy that
 * drops most of a package's metadata requests: a restore of one ordinary plugin sat in
 * `restoring desktop plugins` for over half an hour, and the same restore against this mirror
 * finished in under a minute. A machine that states npmjs or its own registry still wins — this
 * only decides the case where nothing was stated.
 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com/'

/**
 * Environment names that carry a registry choice, in the order npm itself prefers them.
 *
 * npm and pnpm read both spellings, so this product does too; the order decides which one wins when
 * a machine sets both.
 */
const REGISTRY_ENVIRONMENT_NAMES = ['npm_config_registry', 'NPM_CONFIG_REGISTRY'] as const

/** Environment names that carry a user configuration file npm and pnpm would read. */
const USERCONFIG_ENVIRONMENT_NAMES = ['npm_config_userconfig', 'NPM_CONFIG_USERCONFIG'] as const

/**
 * Environment names that decide whether this machine reaches the registry through a proxy.
 *
 * Node only honours these for its own `fetch` and `http` when `NODE_USE_ENV_PROXY` is set, so the
 * child is given that switch too — a user who configured a proxy for npm has already said how this
 * machine reaches the internet, and an installer that ignores it fails with a bare network error.
 */
const PROXY_ENVIRONMENT_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY'] as const

/** Environment names for a TLS trust anchor this product must add, not replace. */
const CA_ENVIRONMENT_NAMES = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] as const

/**
 * Read one environment value through every spelling npm accepts.
 * @param names - names to look up, most specific first.
 * @returns the value, or undefined when none is set to a non-empty string.
 */
function environmentValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Reduce one registry answer to the origin this product will install from.
 *
 * A registry is an origin: `registry.npmjs.org` and `https://registry.npmjs.org/` name the same
 * service, while a value carrying a path, credentials, or a non-HTTP scheme is either a typo or a
 * package-spec injection, and both are refused rather than guessed at.
 * @param value - registry as the machine stated it.
 * @returns the normalized origin, or undefined when the value is not a registry origin.
 */
function registryOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (url.pathname !== '/' && url.pathname !== '') return undefined
    if (url.search !== '' || url.hash !== '') return undefined
    return url.origin + '/'
  } catch {
    return undefined
  }
}

/**
 * The registry this machine names, when it names one.
 *
 * Kept separate from {@link resolveRegistrySettings} because "which registry" and "may pnpm read the
 * file that named it" are two different questions: a caller that has to decide whether to override
 * pnpm at all needs the first one on its own.
 * @returns the normalized registry origin, or undefined when the machine names none.
 */
export function statedRegistry(): string | undefined {
  const stated = environmentValue(REGISTRY_ENVIRONMENT_NAMES)
  return stated === undefined ? undefined : registryOrigin(stated)
}

/**
 * The registry and configuration file one pnpm run should use.
 *
 * A mirror is only usable when pnpm is allowed to read the file that names it, so the two answers
 * travel together: this returns the user's configuration file when there is one, and only falls
 * back to this product's own registry when the machine names none.
 * @param fallbackUserConfig - path of this product's own npmrc, used when the machine has no file.
 * @returns the registry for this run and the configuration file pnpm should read.
 */
export function resolveRegistrySettings(fallbackUserConfig: string): {
  readonly registry: string
  readonly userConfig: string
} {
  const configured = environmentValue(USERCONFIG_ENVIRONMENT_NAMES)
  return {
    registry: statedRegistry() ?? DEFAULT_REGISTRY,
    userConfig: configured ?? fallbackUserConfig,
  }
}

/**
 * Environment additions that let a configured proxy and a private trust anchor reach pnpm.
 *
 * A machine that reaches the registry through a proxy has already said so in these variables; npm
 * and pnpm read them directly, but Node's own `fetch` and `http` only do so under
 * `NODE_USE_ENV_PROXY`, which is not set by default. Both are reported here rather than copied
 * blindly, so the run log can say which one was in play when an install fails.
 * @returns environment entries to add for one pnpm run, and whether a proxy was found.
 */
export function registryTransportEnvironment(): {
  readonly environment: Readonly<Record<string, string>>
  readonly proxy: string | undefined
  readonly caFile: string | undefined
} {
  const environment: Record<string, string> = {}
  const proxy = environmentValue(PROXY_ENVIRONMENT_NAMES)
  if (proxy !== undefined) environment.NODE_USE_ENV_PROXY = '1'
  const caFile = environmentValue(CA_ENVIRONMENT_NAMES)
  return { environment, proxy, caFile }
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/**
 * Name the runtime a refused directory move was trying to take, and what the user can do.
 *
 * Windows refuses to rename a directory while any process holds a handle inside it, and the
 * desktop runtime is exactly such a tree: a Host started by another launch keeps the profile
 * undisplaceable for as long as it runs. The move reports only `EPERM`, `EACCES`, or `EBUSY`,
 * which names neither the tree nor the remedy, so the transaction has to say both itself.
 * @param held - directory the move tried to take.
 * @param reason - failure raised by the move.
 * @returns the failure to raise in its place.
 */
function renameConflictError(held: string, reason: unknown): Error {
  const report = errorOf(reason, `desktop project: could not move ${held}`)
  const code = (report as { code?: unknown }).code
  if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') return report
  return new Error(
    `desktop project: the Harness-CN runtime at ${held} is in use and could not be moved;`
    + ' close every Harness-CN window and any other program using this home, then start again',
    { cause: report },
  )
}

/**
 * Whether a rebuild failed because the package store was not whole.
 *
 * That is the one failure a fresh unpack can fix: linking is what reads the content the
 * previous stage wrote, so a store whose entries are not all on disk reports itself here and
 * nowhere else. Three shapes mean it, and all three are matched because the layers disagree:
 * the link writer refuses a manifest entry whose content it cannot find, Node's own `link`
 * names the store path it could not read, and a store that answers without the entry surfaces
 * as a missing file inside it.
 * @param error - failure raised while rebuilding the profile.
 * @param storeRoot - absolute path of the package store the rebuild links from.
 * @returns whether re-unpacking the store and rebuilding could succeed.
 */
function isStoreLinkError(error: unknown, storeRoot: string): boolean {
  const report = errorOf(error, 'desktop project: profile rebuild failed')
  const message = report.message
  if (message.includes('targets a missing store file')) return true
  const text = `${message}\n${report.stack ?? ''}`
  return text.includes(`link '${storeRoot}`)
    || text.includes(`link "${storeRoot}`)
    || text.includes(`', link '${storeRoot}`)
    || (report as { code?: unknown }).code === 'ENOENT' && text.includes(storeRoot)
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
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n  cloudflared: false\n  cpu-features: false\n  ssh2: false\n  onnxruntime-node: false\n`
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
 * The files are read and hashed several at a time: the seed's own archives are the bulk of the work
 * (~300 MB across a handful of files), and reading them one after another leaves the disk idle
 * between each. Overlapping them on the libuv thread pool is what turns this step from a serial
 * read into a bounded parallel one without changing what it proves. The walk itself never yields
 * the event loop, but every `await` here does, so the startup window still repaints.
 * @param root - seed directory to inventory, excluding its own integrity inventory.
 * @param onProgress - receives the hashed fraction so a caller can show real progress.
 * @returns one record per file, in path order.
 */
async function seedFiles(
  root: string,
  onProgress?: (fraction: number) => void,
): Promise<readonly DesktopSeedIntegrityRecord[]> {
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
  const files: DesktopSeedIntegrityRecord[] = new Array<DesktopSeedIntegrityRecord>(paths.length)
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= paths.length) return
      const relativePath = paths[index] as string
      const body = await readFile(join(root, ...relativePath.split('/')))
      files[index] = {
        path: relativePath,
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      }
      done += 1
      if (paths.length > 0) onProgress?.(done / paths.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEED_HASH_CONCURRENCY, paths.length) }, worker))
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
 * @param onProgress - receives the hashed fraction so a caller can show real progress.
 * @returns resolves once every shipped seed file matches the inventory.
 */
export async function verifySeedIntegrity(
  seedDir: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const expected = readSeedIntegrity(seedDir)
  const actual = await seedFiles(seedDir, onProgress)
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
  // A profile installed by an earlier seed keeps a core package mapping that the package set
  // this release ships no longer reproduces. Reading the profile must still work, so a mismatch
  // is not fatal here: the install path re-checks it before it rewrites the tree.
  try {
    const packageSet = readDesktopCorePackageSet(projectDir, releaseFile(projectDir).version)
    const expectedOverrides = desktopCorePackageOverrides(packageSet)
    const intact = manifest.dependencies[DSH_PACKAGE] === desktopDshPackageSpec(packageSet)
      && Object.entries(expectedOverrides).every(([name, spec]) => manifest.dependencies[name] === spec)
      && workspaceMappingIsIntact(readFileSync(join(projectDir, 'pnpm-workspace.yaml'), 'utf8'), expectedOverrides)
    if (!intact) {
      void DESKTOP_PACKAGE_SET_FILE
    }
  } catch {
    // No package set at all: an older seed did not write one, and the bundle list is the truth.
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

/**
 * Records for whatever the profile actually installed. It reads the bundle list straight from the
 * manifest, so a profile whose core mapping no longer matches this release still lists its plugins.
 */
function lenientPluginRecords(projectDir: string): readonly DesktopPluginRecord[] {
  const value = readJson(join(projectDir, 'package.json'))
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  const bundles = Array.isArray(profile?.bundles) ? profile.bundles.filter((name): name is string => typeof name === 'string') : []
  const records: DesktopPluginRecord[] = []
  for (const name of bundles) {
    const path = join(projectDir, 'node_modules', name, 'package.json')
    if (!existsSync(path)) continue
    const entry = readJson(path)
    const version = isRecord(entry) && typeof entry.version === 'string' ? entry.version : ''
    records.push({ name, version, bundled: (DESKTOP_PROFILE_BUNDLES as readonly string[]).includes(name) })
  }
  return records
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
  return { name: requestedName, version: manifest.version, bundled: BUNDLED_PLUGIN_NAMES.has(requestedName) }
}

/** Transactional desktop npm project manager. */
export class DesktopProjectManager {
  private lockDescriptor: number | undefined
  /**
   * Run-log sink for the transaction in flight, set where the hooks are known.
   *
   * The package runner is reached from two entry points that hold different things: `install` has
   * the hooks in scope, and `mutate` receives them per call. Recording the sink here is what lets
   * the runner report how a machine reaches the registry without threading hooks through every
   * layer between them.
   */
  private note: ((message: string) => void) | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute bundled Node.js and pnpm entry paths.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
  ) {}

  /**
   * Recover an interrupted directory replacement before reading the active project.
   *
   * The journal exists only while an activation is uncommitted, so the runtime the move-aside
   * took is the only one here that was ever working: it goes back unless the journal already
   * recorded that the replacement booted, in which case the copy beside it is superseded. The
   * journal is removed only once the tree it names is settled, so a repair that cannot finish —
   * a directory another process still holds — is retried by the next launch instead of being
   * forgotten.
   * @returns what the interrupted launch left behind, or undefined when it left no journal.
   */
  recover(): DesktopRecoveryReport | undefined {
    if (!existsSync(this.paths.pending)) return undefined
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
    let restored = false
    let discardedRollback = false
    let discardedStaging = false
    // `prepared` is journaled before the move-aside runs, so the journal alone cannot tell a
    // launch that stopped before the move from one that stopped between the move and the next
    // step. The manifest the move carries with the profile is that evidence: an empty rollback
    // directory is one this launch created and never filled.
    const rollbackHoldsRuntime = existsSync(join(this.paths.rollback, DESKTOP_PROJECT_MANIFEST_FILE))
    if (rollbackHoldsRuntime && pending.step === 'staging-activated') {
      removeOwnedDirectory(this.paths.rollback)
      discardedRollback = true
    } else if (rollbackHoldsRuntime) {
      // Anything at the profile path now is the replacement this transaction staged: the
      // move-aside is what emptied the path, and only this transaction writes there.
      removeOwnedDirectory(this.paths.profile)
      mkdirSync(dirname(this.paths.profile), { recursive: true })
      try {
        renameOwnedDirectory(this.paths.rollback, this.paths.profile)
      } catch (error) {
        throw renameConflictError(this.paths.rollback, error)
      }
      restored = true
    }
    if (existsSync(pending.stagingProfile)) {
      removeOwnedDirectory(pending.stagingProfile)
      discardedStaging = true
    }
    unlinkSync(this.paths.pending)
    return { step: pending.step, rollback: this.paths.rollback, restored, discardedRollback, discardedStaging }
  }

  /**
   * Recover an interrupted activation and report it into the transaction log.
   *
   * Recovery is otherwise silent: it runs before anything else reads the profile, so a launch
   * that killed a directory replacement would leave only the absence of a step to notice.
   */
  private recoverNoted(): void {
    const report = this.recover()
    if (report === undefined) return
    for (const line of describeDesktopRecovery(report)) this.note?.(line)
  }

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    return pluginRecords(this.paths.profile)
  }

  /** The same inventory, resolved from the profile's own bundle list when reading it throws. */
  listPluginsLeniently(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    try {
      return pluginRecords(this.paths.profile)
    } catch {
      return lenientPluginRecords(this.paths.profile)
    }
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
    this.note = note
    const progress = (fraction: number): void => { hooks.progress?.(fraction) }
    // Each step owns a band of the overall bar, so a step can publish its own fraction
    // without knowing how the launch is weighted as a whole. The same call names the step, which
    // is what lets the shell show a percentage for the step and not only for the whole launch.
    const step = (label: string, from: number, to: number) => (fraction: number): void => {
      const completed = Math.min(Math.max(fraction, 0), 1)
      hooks.step?.(label, completed)
      progress(from + completed * (to - from))
    }
    return this.withLock(async () => {
      this.recoverNoted()
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
      await verifySeedIntegrity(seedDir, step('校验离线包内容', 0, 0.15))
      note('bundled seed verified')
      progress(0.15)
      verifyDesktopCorePackageSet(seedDir, target.version)
      // The store is keyed on the archives it was built from, not on the whole inventory: a
      // rebuild that changes only the application code publishes the same archives, and
      // unpacking them again would recreate entries the store already holds.
      const archives = storeIdentity(seedDir)
      // A store that has just been unpacked can still be missing content when the rebuild
      // reaches for it: the failure is `link '<store path>' -> '<profile path>' UNKNOWN`, and
      // the second attempt succeeds because the entries that were not yet on disk are there by
      // then. Retrying here is what keeps that from being a first launch the user has to repeat.
      // One retry only: a store that is still incomplete after a fresh unpack is a real fault,
      // and looping would turn a corrupt download into a launch that never finishes.
      let refreshedStore = false
      for (;;) {
        if (this.storeMatchesSeed(archives)) {
          note('package store already carries this seed')
        } else {
          note('unpacking the bundled package store')
          progress(0.3)
          await this.mergeSeedPnpmState(seedDir, step('展开软件包仓库', 0.3, 0.45))
          this.recordStoreSeed(archives)
          note('package store ready; rebuilding the desktop runtime')
          progress(0.45)
        }
        const stagingProfile = this.newStagingProfile()
        try {
          const plugins = await this.materializeProfile(
            seedDir,
            stagingProfile,
            identity,
            step('重建桌面运行时', 0.45, 0.75),
          )
          note('desktop runtime linked from the package store')
          progress(0.75)
          note('verifying the staged runtime')
          hooks.step?.('检查运行时完整性', 0)
          progress(0.85)
          await hooks.healthCheck(stagingProfile)
          hooks.step?.('检查运行时完整性', 1)
          note('staged runtime boots; activating it')
          progress(0.9)
          await this.activate(stagingProfile, hooks)
          note('desktop runtime activated')
          progress(0.94)
          if (plugins.length > 0) await this.restorePlugins(plugins)
          return true
        } catch (error) {
          // The staging tree is dropped either way, because a retry needs an empty one: the
          // links written so far would otherwise be confused with the ones still to write.
          try {
            removeOwnedDirectory(stagingProfile)
          } catch {
            // A staging tree that refuses removal must not replace the failure that caused the
            // retry; the next launch's recover() owns whatever is left behind.
          }
          if (refreshedStore || !isStoreLinkError(error, this.paths.pnpm.store)) {
            this.discardStaging(stagingProfile, error)
          }
          note('the package store was still incomplete after the rebuild; unpacking it again')
          refreshedStore = true
        }
      }
    })
  }

  /**
   * Build one staging profile from the seed's links, and report the plugins left to restore.
   *
   * Separated from {@link installSeed} so the caller can retry the whole build: linking out of
   * the store is where an unpacking store shows up as a failure, and the recovery for that is a
   * fresh staging directory rather than a patch of the half-linked one.
   * @param seedDir - verified seed directory.
   * @param stagingProfile - empty staging profile to fill.
   * @param identity - seed identity recorded for the next launch.
   * @param onProgress - progress sink for the linking band of the launch bar.
   * @returns plugins the user had moved off the bundled set, for the caller to restore.
   */
  private async materializeProfile(
    seedDir: string,
    stagingProfile: string,
    identity: string,
    onProgress: (fraction: number) => void,
  ): Promise<DesktopPluginRecord[]> {
    // The seed carries the installed tree as links into the store it just published, so
    // the runtime is rebuilt here instead of installed: pnpm would recreate exactly these
    // files, at several times the cost of one link each.
    // The seed's tree already carries every bundled plugin at its pinned version, so a
    // profile that only names those needs no pnpm run at all. A plugin the user added is the
    // only thing restored from the store: a bundled plugin whose recorded version differs is
    // the pin an older seed wrote, and this release bundles the version it ships, so the tree
    // already carries the version the profile should end up with.
    const bundled = bundledPluginDependencies()
    const plugins = (this.hasInstalledProfile() ? pluginRecords(this.paths.profile) : [])
      .filter(plugin => bundled[plugin.name] === undefined)
    copyMetadata(seedDir, stagingProfile)
    await materializeLinkedProfile(
      seedDir,
      stagingProfile,
      this.paths.pnpm.store,
      this.paths.profile,
      onProgress,
    )
    writeJson(join(stagingProfile, DESKTOP_SEED_IDENTITY_FILE), {
      schemaVersion: 1,
      integrity: identity,
    } satisfies DesktopSeedIdentity)
    return plugins
  }

  /**
   * Put back the plugins the user added, once the tree has taken its final path.
   *
   * pnpm cannot run inside a staged tree: the tree's dependencies are linked from the profile's
   * final location, so pnpm refuses the virtual store the staging path implies
   * (`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`). The restore therefore runs after activation, where
   * the tree is where its own links say it is. A restore that fails leaves a profile that works
   * without that plugin, so it is reported instead of failing a launch that already succeeded.
   * @param plugins - plugins the user added, with the versions their profile records.
   */
  private async restorePlugins(plugins: readonly DesktopPluginRecord[]): Promise<void> {
    this.note?.(`restoring ${String(plugins.length)} desktop plugin(s)`)
    try {
      await this.runPnpm(this.paths.profile, [
        'add',
        ...plugins.map(plugin => `${plugin.name}@${plugin.version}`),
        '--save-exact',
        '--offline',
      ])
      writeProfilePlugins(this.paths.profile, plugins)
    } catch (error) {
      this.note?.(
        `could not restore ${plugins.map(plugin => plugin.name).join(', ')}: `
        + `${errorOf(error, 'the plugin restore failed').message}`,
      )
    }
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
    this.note = (message) => { hooks.note?.(message) }
    try {
      await this.withLock(async () => {
        this.recoverNoted()
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
    } finally {
      this.note = undefined
    }
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
        assertNotBundled(requestedName)
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
        assertNotBundled(mutation.name)
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
        assertNotBundled(mutation.name)
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

  private async mergeSeedPnpmState(seedDir: string, onProgress?: (fraction: number) => void): Promise<void> {
    const transactionRoot = join(this.paths.staging, randomUUID())
    const extractedStore = join(transactionRoot, 'store')
    // Unpacking the shards dominates this step; publishing the store into place is a rename on
    // a cold machine, so the merge reports into the last quarter of the band.
    const merge = (fraction: number): void => { onProgress?.(0.75 + fraction * 0.25) }
    try {
      await extractPnpmStoreArchives(seedDir, extractedStore, onProgress === undefined
        ? undefined
        : (fraction) => { onProgress(fraction * 0.75) })
      await mergePnpmStore(extractedStore, this.paths.pnpm.store, merge)
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
      if (existsSync(this.paths.profile)) {
        try {
          renameOwnedDirectory(this.paths.profile, this.paths.rollback)
        } catch (error) {
          throw renameConflictError(this.paths.profile, error)
        }
        activeMoved = true
        // Journaled only now: a step claiming a move that never happened sends the next
        // launch's recovery looking for a tree that is still exactly where it always was.
        writeJson(this.paths.pending, { ...pending, step: 'active-moved' } satisfies DesktopPendingTransaction)
      }
      mkdirSync(dirname(this.paths.profile), { recursive: true, mode: 0o700 })
      try {
        renameOwnedDirectory(stagingProfile, this.paths.profile)
      } catch (error) {
        throw renameConflictError(stagingProfile, error)
      }
      await hooks.afterActivate()
      // The commit record: written only once the replacement booted, so a launch that stops
      // before this line is repaired back to the runtime the user had.
      writeJson(this.paths.pending, { ...pending, step: 'staging-activated' } satisfies DesktopPendingTransaction)
      unlinkSync(this.paths.pending)
    } catch (error) {
      // Undo only what this transaction changed. The cleanup that used to run here removed the
      // active profile whenever the move-aside had failed, which turned a profile another
      // process refused to release into a lost runtime and a second, unrelated failure.
      const settled = this.settleActivation(activeMoved)
      if (settled && existsSync(this.paths.pending)) unlinkSync(this.paths.pending)
      await hooks.afterActivate().catch(() => undefined)
      throw error
    }
  }

  /**
   * Undo an activation that did not commit and put the runtime the user had back.
   *
   * What sits at the profile path is this transaction's only when the move-aside ran: that move
   * is what emptied the path, so with it done anything there is the replacement this transaction
   * staged. Without it the active runtime was never touched and there is nothing to undo.
   * @param activeMoved - whether this transaction moved the active profile aside.
   * @returns whether the active profile is settled and the journal may be cleared.
   */
  private settleActivation(activeMoved: boolean): boolean {
    if (!activeMoved) return true
    try {
      removeOwnedDirectory(this.paths.profile)
      mkdirSync(dirname(this.paths.profile), { recursive: true, mode: 0o700 })
      renameOwnedDirectory(this.paths.rollback, this.paths.profile)
      return true
    } catch {
      // Names what it swallows: a runtime copy another process still holds. The journal stays
      // on disk, so the next launch's recovery repeats this same repair.
      return false
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
    // A machine that names its own registry is installed from it, and pnpm reaches it through the
    // file that named it — overriding either would break exactly the mirrors this has to work on.
    const registry = resolveRegistrySettings(npmrc)
    const registryArguments = [
      // The flag is what makes pnpm ignore the configuration file, so it is passed only when this
      // product's own default is the registry in play.
      ...(registry.registry === DEFAULT_REGISTRY ? [`--config.registry=${registry.registry}`] : []),
      ...(registry.userConfig === npmrc ? [`--config.userconfig=${npmrc}`] : []),
    ]
    const transport = registryTransportEnvironment()
    const report = (message: string): void => {
      if (this.note === undefined) return
      this.note(message)
      // One line per transaction: a plugin install runs pnpm once, and a first launch runs it once
      // as well, so the reader sees where packages came from without the log repeating it.
      this.note = undefined
    }
    if (transport.proxy !== undefined) report(`package installs use the configured proxy (${transport.proxy})`)
    if (transport.caFile !== undefined) {
      report(`package installs trust the configured certificate file (${transport.caFile})`)
    }
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    )))
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, [
        this.runtime.pnpm,
        ...registryArguments,
        `--config.store-dir=${this.paths.pnpm.store}`,
        '--config.enable-global-virtual-store=false',
        command,
        ...commandArgs,
      ], {
        cwd: projectDir,
        env: {
          ...inherited,
          ...transport.environment,
          COREPACK_HOME: this.paths.pnpm.home,
          NPM_CONFIG_REGISTRY: registry.registry,
          NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
          ...(registry.userConfig === npmrc ? { NPM_CONFIG_USERCONFIG: npmrc } : {}),
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
 * Describe one repaired activation in the words the run log uses.
 * @param report - what the interrupted launch left behind and what recovery did about it.
 * @returns one line per fact a later diagnosis needs.
 */
export function describeDesktopRecovery(report: DesktopRecoveryReport): readonly string[] {
  const lines = [`activation recovery: the previous launch stopped at ${report.step}`]
  if (report.restored) lines.push(`activation recovery: restored ${report.rollback} as the active profile`)
  if (report.discardedRollback) lines.push(`activation recovery: discarded the superseded runtime at ${report.rollback}`)
  if (report.discardedStaging) lines.push("activation recovery: discarded the interrupted launch's staging tree")
  if (!report.restored && !report.discardedRollback && !report.discardedStaging) {
    lines.push('activation recovery: the previous launch committed; nothing was left to repair')
  }
  return lines
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
