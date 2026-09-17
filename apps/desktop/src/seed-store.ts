/** Deterministic archive transport for the desktop seed's pnpm store. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { link } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { create, extract } from 'tar'
import { COOPERATIVE_BATCH_ENTRIES, yieldToEventLoop } from './event-loop.ts'
import { renameOwnedDirectory } from './owned-directory.ts'

/** Directory containing the seed's uncompressed pnpm store archives. */
export const SEED_STORE_ARCHIVE_DIR = 'store-archives'

/** Manifest describing the deterministic pnpm store archive set. */
export const SEED_STORE_ARCHIVE_MANIFEST = 'store-archives.json'

/** Seed file mapping every installed profile entry that is a hard link into the pnpm store. */
export const SEED_PROFILE_LINK_MANIFEST = 'profile-links.json'

/** Seed archive carrying every installed profile entry the pnpm store does not own. */
export const SEED_PROFILE_FILE_ARCHIVE = 'profile-files.tar'

const DEFAULT_SHARD_COUNT = 16
const ARCHIVE_NAME_PATTERN = /^store-[0-9a-f]{2}\.tar$/u
const STORE_VERSION_PATTERN = /^v\d+$/u

/**
 * Store paths whose file name is the file's own content digest.
 *
 * pnpm addresses the store this way, so an entry that is already present holds exactly these
 * bytes and needs no write. That matters because replacing a store file is not a rewrite in
 * place: the old entry is unlinked and a new one created, and a scanner that inspects every
 * created file turns that into the slowest part of publishing a refreshed store.
 */
const CONTENT_ADDRESSED_STORE_PATTERN = /^v\d+\/files\//u

interface SeedStoreArchiveRecord {
  readonly file: string
  readonly entries: number
}

interface SeedStoreArchiveManifest {
  readonly schemaVersion: 1
  readonly shardCount: number
  readonly archives: readonly SeedStoreArchiveRecord[]
}

/** Manifest mapping one installed profile tree onto the files a pnpm store owns. */
interface SeedProfileLinkManifest {
  readonly schemaVersion: 1
  readonly links: Readonly<Record<string, string>>
}

/** What one profile archive recorded, for the build log and its own gates. */
export interface LinkedProfileArchiveSummary {
  /** Profile entries recorded as links into the pnpm store. */
  readonly linkedFiles: number
  /** Profile entries the archive carries verbatim. */
  readonly archivedFiles: number
  /** Profile directories the archive carries. */
  readonly archivedDirectories: number
}

function storeFiles(storeRoot: string): readonly string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop seed: pnpm store contains a symbolic link: ${relative(storeRoot, path)}`)
      }
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`desktop seed: pnpm store contains an unsupported file: ${relative(storeRoot, path)}`)
      }
      files.push(relative(storeRoot, path).split(sep).join('/'))
    }
  }
  visit(storeRoot)
  return files.sort((left, right) => left.localeCompare(right))
}

function shardFor(path: string, shardCount: number): number {
  return createHash('sha256').update(path).digest().readUInt32BE(0) % shardCount
}

function readArchiveManifest(seedRoot: string): SeedStoreArchiveManifest {
  const path = join(seedRoot, SEED_STORE_ARCHIVE_MANIFEST)
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error(`desktop seed: invalid pnpm store archive manifest ${path}`)
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.shardCount)
    || (candidate.shardCount as number) < 1 || (candidate.shardCount as number) > 256
    || !Array.isArray(candidate.archives) || candidate.archives.length === 0) {
    throw new Error(`desktop seed: invalid pnpm store archive manifest ${path}`)
  }
  const names = new Set<string>()
  const archives = candidate.archives.map((entry): SeedStoreArchiveRecord => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`desktop seed: invalid pnpm store archive record in ${path}`)
    }
    const record = entry as Record<string, unknown>
    if (typeof record.file !== 'string' || !ARCHIVE_NAME_PATTERN.test(record.file)
      || names.has(record.file) || !Number.isSafeInteger(record.entries) || (record.entries as number) < 1) {
      throw new Error(`desktop seed: invalid pnpm store archive record in ${path}`)
    }
    const shard = Number.parseInt(record.file.slice('store-'.length, -'.tar'.length), 16)
    if (shard >= (candidate.shardCount as number)) {
      throw new Error(`desktop seed: pnpm store archive shard is outside the manifest range in ${path}`)
    }
    names.add(record.file)
    return { file: record.file, entries: record.entries as number }
  })
  return {
    schemaVersion: 1,
    shardCount: candidate.shardCount as number,
    archives,
  }
}

function assertArchivePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop seed: unsafe pnpm store archive path ${JSON.stringify(path)}`)
  }
}

/**
 * Remove pnpm's registrations for projects that populated the seed store.
 * @param storeRoot - pnpm store directory included in the desktop seed.
 */
export function removePnpmProjectRegistrations(storeRoot: string): void {
  for (const entry of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+$/u.test(entry.name)) continue
    rmSync(join(storeRoot, entry.name, 'projects'), { recursive: true, force: true })
  }
}

function mergeStoreIndex(source: string, destination: string): void {
  if (!existsSync(destination)) {
    copyFileSync(source, destination)
    return
  }
  const database = new DatabaseSync(destination)
  let attached = false
  try {
    database.exec('PRAGMA busy_timeout=5000')
    database.prepare('ATTACH DATABASE ? AS seed').run(source)
    attached = true
    database.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      database.exec('INSERT OR REPLACE INTO package_index (key, data) SELECT key, data FROM seed.package_index')
      database.exec('COMMIT')
      committed = true
    } finally {
      if (!committed) database.exec('ROLLBACK')
    }
  } finally {
    if (attached) database.exec('DETACH DATABASE seed')
    database.close()
  }
}

/**
 * Merge a completely extracted seed store into Desktop's persistent pnpm store.
 *
 * An absent destination is published by moving the verified extraction into place. Both trees
 * live under the same Desktop root, so that move costs one directory rename instead of
 * rewriting every store file; the move retries the transient Windows refusals a just-written
 * tree attracts, and anything it cannot move still falls through to the copy below. A
 * destination that already holds a store receives only the entries it is missing, which is
 * what keeps a refresh cheap and preserves the packages user plugins brought in.
 * @param source - Verified temporary store extraction.
 * @param destination - Desktop-owned persistent pnpm store.
 */
export async function mergePnpmStore(source: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  if (!existsSync(destination)) {
    try {
      renameOwnedDirectory(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EXDEV') {
        throw error
      }
    }
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const indexPaths = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STORE_VERSION_PATTERN.test(entry.name)
      && existsSync(join(source, entry.name, 'index.db')))
    .map(entry => `${entry.name}/index.db`)
  await copyStoreEntries(source, destination, new Set(indexPaths))
  for (const path of indexPaths) {
    mergeStoreIndex(join(source, ...path.split('/')), join(destination, ...path.split('/')))
  }
}

/**
 * Copy the entries one store tree has that another does not.
 *
 * A content-addressed entry that is already present is left untouched: its name is its
 * digest, and the size check only guards against a copy an earlier run left half-written.
 * @param source - extracted seed store.
 * @param destination - persistent store that receives the missing entries.
 * @param skipped - store-relative paths the caller merges itself, such as `index.db`.
 */
async function copyStoreEntries(source: string, destination: string, skipped: ReadonlySet<string>): Promise<void> {
  const directories: string[] = []
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(source, path).split(sep).join('/')
      if (skipped.has(relativePath)) continue
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop seed: pnpm store contains a symbolic link: ${relativePath}`)
      }
      if (entry.isDirectory()) {
        directories.push(relativePath)
        visit(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`desktop seed: pnpm store contains an unsupported file: ${relativePath}`)
      }
      files.push(relativePath)
    }
  }
  visit(source)
  for (const directory of directories) {
    mkdirSync(join(destination, ...directory.split('/')), { recursive: true, mode: 0o700 })
  }
  let examined = 0
  for (const relativePath of files) {
    const from = join(source, ...relativePath.split('/'))
    const to = join(destination, ...relativePath.split('/'))
    if (!needsStoreCopy(relativePath, from, to)) {
      examined += 1
      if (examined % COOPERATIVE_BATCH_ENTRIES === 0) await yieldToEventLoop()
      continue
    }
    copyFileSync(from, to)
    examined += 1
    if (examined % COOPERATIVE_BATCH_ENTRIES === 0) await yieldToEventLoop()
  }
}

function needsStoreCopy(relativePath: string, source: string, destination: string): boolean {
  if (!existsSync(destination)) return true
  if (!CONTENT_ADDRESSED_STORE_PATTERN.test(relativePath)) return true
  return statSync(source).size !== statSync(destination).size
}

/**
 * Replace a prepared loose pnpm store with deterministic uncompressed archive shards.
 * @param seedRoot - seed directory that owns the archive output.
 * @param storeRoot - populated pnpm store to archive and remove after success.
 * @param shardCount - stable shard count used to limit update churn.
 */
export function archivePnpmStore(
  seedRoot: string,
  storeRoot: string,
  shardCount = DEFAULT_SHARD_COUNT,
): void {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 256) {
    throw new Error(`desktop seed: invalid pnpm store shard count ${shardCount}`)
  }
  const archiveRoot = join(seedRoot, SEED_STORE_ARCHIVE_DIR)
  const manifestPath = join(seedRoot, SEED_STORE_ARCHIVE_MANIFEST)
  rmSync(archiveRoot, { recursive: true, force: true })
  rmSync(manifestPath, { force: true })
  mkdirSync(archiveRoot, { recursive: true })
  const shards = Array.from({ length: shardCount }, (): string[] => [])
  for (const path of storeFiles(storeRoot)) (shards[shardFor(path, shardCount)] as string[]).push(path)
  const archives: SeedStoreArchiveRecord[] = []
  for (const [index, paths] of shards.entries()) {
    if (paths.length === 0) continue
    const file = `store-${index.toString(16).padStart(2, '0')}.tar`
    create({
      cwd: storeRoot,
      file: join(archiveRoot, file),
      noDirRecurse: true,
      noMtime: true,
      portable: true,
      sync: true,
    }, paths)
    chmodSync(join(archiveRoot, file), 0o644)
    archives.push({ file, entries: paths.length })
  }
  if (archives.length === 0) throw new Error('desktop seed: pnpm store is empty')
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, shardCount, archives }, undefined, 2)}\n`)
  rmSync(storeRoot, { recursive: true })
}

/**
 * Validate and extract a packaged pnpm store archive set into an empty directory.
 *
 * One `extract` pass validates and writes. node-tar calls the filter with each entry's raw
 * archive path before that entry reaches the filesystem, so the entry type, path, shard, and
 * duplicate checks run there instead of in a preceding `list` pass over the same bytes. A
 * rejected archive therefore fails mid-pass, which is safe because the destination is a
 * disposable extraction directory that the caller discards with its transaction.
 * @param seedRoot - verified packaged seed directory.
 * @param destination - empty Desktop-owned temporary extraction directory.
 */
export async function extractPnpmStoreArchives(seedRoot: string, destination: string): Promise<void> {
  const manifest = readArchiveManifest(seedRoot)
  const archiveRoot = join(seedRoot, SEED_STORE_ARCHIVE_DIR)
  const actualFiles = readdirSync(archiveRoot, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`desktop seed: invalid pnpm store archive entry ${entry.name}`)
    }
    return entry.name
  }).sort()
  const expectedFiles = manifest.archives.map(archive => archive.file).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('desktop seed: pnpm store archive set does not match its manifest')
  }
  if (existsSync(destination) && readdirSync(destination).length !== 0) {
    throw new Error(`desktop seed: pnpm store extraction directory is not empty: ${destination}`)
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const paths = new Set<string>()
  for (const archive of manifest.archives) {
    const archivePath = join(archiveRoot, archive.file)
    const archiveShard = Number.parseInt(archive.file.slice('store-'.length, -'.tar'.length), 16)
    let entries = 0
    extract({
      chmod: true,
      cwd: destination,
      file: archivePath,
      filter: (path, entry) => {
        if (!('type' in entry)) throw new Error('desktop seed: pnpm store archive entry was not parsed')
        if (entry.type !== 'File' && entry.type !== 'OldFile') {
          throw new Error(`desktop seed: unsupported pnpm store archive entry type ${entry.type}`)
        }
        assertArchivePath(path)
        if (shardFor(path, manifest.shardCount) !== archiveShard) {
          throw new Error(`desktop seed: pnpm store path is assigned to the wrong archive shard: ${path}`)
        }
        if (paths.has(path)) {
          throw new Error(`desktop seed: duplicate pnpm store archive path ${path}`)
        }
        paths.add(path)
        entries += 1
        return true
      },
      noMtime: true,
      preservePaths: false,
      processUmask: 0,
      strict: true,
      sync: true,
    })
    if (entries !== archive.entries) {
      throw new Error(`desktop seed: pnpm store archive ${archive.file} has an unexpected entry count`)
    }
    // One archive is bounded work; yielding between them keeps the shell able to paint.
    await yieldToEventLoop()
  }
}

/**
 * Store-relative path one file's bytes occupy in a pnpm store.
 *
 * pnpm names a stored file after its own content: the digest's first two hex characters are
 * the bucket directory and the rest is the file name. Matching on content rather than on file
 * identity is what makes the mapping safe to build — an inode number is a 64-bit value on
 * Windows that Node reports as a double, so two unrelated files can share one, and a wrong
 * pairing would put another file's bytes into the rebuilt tree.
 * @param storeVersion - store version directory, for example `v11`.
 * @param body - file bytes to address.
 * @returns store-relative path, or undefined when the store version is not the digests' owner.
 */
function contentAddressedStorePath(storeVersion: string, body: Buffer): string {
  const digest = createHash('sha512').update(body).digest('hex')
  return `${storeVersion}/files/${digest.slice(0, 2)}/${digest.slice(2)}`
}

/** Store version directory of one populated pnpm store. */
function storeVersionDirectory(storeRoot: string): string {
  const versions = readdirSync(storeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STORE_VERSION_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (versions.length !== 1) {
    throw new Error(`desktop seed: pnpm store ${storeRoot} holds ${String(versions.length)} version directories`)
  }
  return versions[0] as string
}

/**
 * Replace one installed profile tree with a link manifest plus an archive of what the store
 * does not own.
 *
 * pnpm materializes a hoisted tree by hard-linking store files, so almost every installed
 * profile file is already a store file the seed ships. Recording that relationship lets a
 * first launch rebuild the tree by linking instead of installing: one `linkSync` costs about
 * a fifth of one extracted file on Windows, and the shared bytes never enter the seed twice.
 *
 * Every recorded path is relative to the profile root rather than to `node_modules`, because
 * tar reads a path beginning with `@` as a file listing further paths to pack —and a scoped
 * package (`@scope/name/...`) is exactly such a path.
 *
 * The manifest is built from the store as it will ship, after signing and registration
 * cleanup, so no recorded link can dangle at install time.
 * @param seedRoot - seed directory that owns the manifest and archive output.
 * @param storeRoot - populated pnpm store the profile tree links into.
 * @param profileRoot - installed profile whose `node_modules` the manifest describes.
 * @returns what the manifest and archive recorded.
 */
export function archiveLinkedProfile(
  seedRoot: string,
  storeRoot: string,
  profileRoot: string,
): LinkedProfileArchiveSummary {
  const storeVersion = storeVersionDirectory(storeRoot)
  const links: Record<string, string> = {}
  const archived: string[] = []
  let archivedFiles = 0
  let archivedDirectories = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(profileRoot, path).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop seed: installed profile contains a symbolic link: ${relativePath}`)
      }
      if (entry.isDirectory()) {
        archived.push(relativePath)
        archivedDirectories += 1
        visit(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`desktop seed: installed profile contains an unsupported entry: ${relativePath}`)
      }
      // The store publishes these bytes under this exact name, or publishes them nowhere: a
      // file the install generated itself carries no store entry and ships in the archive.
      const storePath = contentAddressedStorePath(storeVersion, readFileSync(path))
      if (existsSync(join(storeRoot, ...storePath.split('/')))) {
        links[relativePath] = storePath
      } else {
        archived.push(relativePath)
        archivedFiles += 1
      }
    }
  }
  visit(join(profileRoot, 'node_modules'))
  const linkedFiles = Object.keys(links).length
  if (linkedFiles === 0) {
    throw new Error('desktop seed: installed profile shares no file with the pnpm store')
  }
  writeFileSync(
    join(seedRoot, SEED_PROFILE_LINK_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, links } satisfies SeedProfileLinkManifest)}\n`,
  )
  const archivePath = join(seedRoot, SEED_PROFILE_FILE_ARCHIVE)
  rmSync(archivePath, { force: true })
  create({
    cwd: profileRoot,
    file: archivePath,
    noDirRecurse: true,
    noMtime: true,
    portable: true,
    sync: true,
  }, archived.sort((left, right) => left.localeCompare(right)))
  return { linkedFiles, archivedFiles, archivedDirectories }
}

function readProfileLinkManifest(seedRoot: string): SeedProfileLinkManifest {
  const path = join(seedRoot, SEED_PROFILE_LINK_MANIFEST)
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error(`desktop seed: invalid profile link manifest ${path}`)
  }
  const candidate = value as Record<string, unknown>
  const links = candidate.links
  if (candidate.schemaVersion !== 1 || typeof links !== 'object' || links === null || Array.isArray(links)) {
    throw new Error(`desktop seed: invalid profile link manifest ${path}`)
  }
  const entries = Object.entries(links as Record<string, unknown>)
  if (entries.length === 0) throw new Error(`desktop seed: profile link manifest ${path} records no links`)
  for (const [profilePath, storePath] of entries) {
    assertArchivePath(profilePath)
    if (typeof storePath !== 'string') {
      throw new Error(`desktop seed: invalid profile link target for ${profilePath} in ${path}`)
    }
    assertArchivePath(storePath)
  }
  return { schemaVersion: 1, links: links as Record<string, string> }
}

/**
 * Point one materialized tree's pnpm record at the locations it actually occupies.
 *
 * The archived tree records the build-time store and the temporary directory pnpm installed
 * it in, and pnpm refuses to operate on a tree whose recorded store differs from the
 * configured one (`ERR_PNPM_UNEXPECTED_STORE`), which breaks every later plugin operation.
 * Both path facts are therefore rewritten to where this profile is installed — the same
 * values pnpm itself writes when it installs there.
 * @param profileDir - staging profile that received the tree.
 * @param storeRoot - published pnpm store the links resolve against.
 * @param installedProfileDir - path the staging profile takes once it is activated.
 */
function recordInstalledPnpmPaths(profileDir: string, storeRoot: string, installedProfileDir: string): void {
  const modulesPath = join(profileDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesPath)) return
  const storeVersion = readdirSync(storeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STORE_VERSION_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()[0]
  if (storeVersion === undefined) {
    throw new Error(`desktop seed: package store ${storeRoot} holds no version directory`)
  }
  const content = readFileSync(modulesPath, 'utf8')
  const rewritten = content
    .replace(/^(\s*)"?storeDir"?\s*:.*$/mu, `$1"storeDir": ${JSON.stringify(join(storeRoot, storeVersion))}`)
    .replace(
      /^(\s*)"?virtualStoreDir"?\s*:.*$/mu,
      `$1"virtualStoreDir": ${JSON.stringify(join(installedProfileDir, 'node_modules', '.pnpm'))}`,
    )
  // A tree that records neither path has nothing to correct, and rewriting more of pnpm's own
  // record than these two facts would be guesswork about a format this module does not own.
  if (rewritten !== content) writeFileSync(modulesPath, rewritten)
}

/**
 * Rebuild one installed profile tree from its link manifest and archived entries.
 *
 * Every link resolves against a file the published store already owns, so the store has to be
 * in place first and is deliberately not copied: activation renames the tree and the store
 * separately, which leaves each pair sharing the inode the extraction created.
 * @param seedRoot - verified seed directory holding the manifest and entry archive.
 * @param profileDir - staging profile that receives the tree.
 * @param storeRoot - published pnpm store the links resolve against.
 * @param installedProfileDir - path this staging profile takes once it is activated.
 */
export async function materializeLinkedProfile(
  seedRoot: string,
  profileDir: string,
  storeRoot: string,
  installedProfileDir: string,
): Promise<void> {
  const manifest = readProfileLinkManifest(seedRoot)
  extract({
    chmod: true,
    cwd: profileDir,
    file: join(seedRoot, SEED_PROFILE_FILE_ARCHIVE),
    noMtime: true,
    preservePaths: false,
    processUmask: 0,
    strict: true,
    sync: true,
  })
  // The archive carries every directory the install created, so these only cover a manifest
  // link whose parent the archive omitted; creating them once beats one mkdir per link.
  const parents = new Set<string>()
  for (const profilePath of Object.keys(manifest.links)) {
    const parent = posix.dirname(profilePath)
    if (parent !== '.' && parent !== '/') parents.add(parent)
  }
  for (const parent of [...parents].sort((left, right) => left.localeCompare(right))) {
    mkdirSync(join(profileDir, ...parent.split('/')), { recursive: true, mode: 0o755 })
  }
  // Links are created concurrently: the work is one syscall per entry, so overlapping them
  // costs nothing and hides the per-entry latency Windows charges for each new name.
  const entries = Object.entries(manifest.links)
  for (let start = 0; start < entries.length; start += COOPERATIVE_BATCH_ENTRIES) {
    await Promise.all(entries.slice(start, start + COOPERATIVE_BATCH_ENTRIES).map(async ([profilePath, storePath]) => {
      try {
        await link(join(storeRoot, ...storePath.split('/')), join(profileDir, ...profilePath.split('/')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        throw new Error(`desktop seed: profile link ${profilePath} targets a missing store file ${storePath}`)
      }
    }))
    await yieldToEventLoop()
  }
  recordInstalledPnpmPaths(profileDir, storeRoot, installedProfileDir)
}
