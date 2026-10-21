/**
 * The offline seed, as a package the first launch fetches rather than one the installer carries.
 *
 * WHY IT IS SEPARATE. The seed is ~314 MB of already-installed runtime: Node, pnpm, the first-party
 * tarballs, and a warmed pnpm store. Shipping it inside the installer made the installer 92.7 MB
 * against Gitee's 100 MB attachment limit — 7 MB of headroom, which one release of ordinary growth
 * would spend. Publishing it as its own attachment puts both files far under the limit and lets the
 * two be replaced independently.
 *
 * WHAT THAT COSTS. The first launch is no longer offline out of the box: it downloads ~68 MB once
 * and keeps the extracted result, so every later launch is offline as before. The launch reports
 * the download, and a machine that cannot reach either host is told what to fetch and from where
 * rather than being left at a progress bar.
 *
 * The extracted seed is verified by the same inventory check the bundled one went through
 * (`verifySeedIntegrity`), so "downloaded" is not a weaker claim than "shipped".
 */

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { extract } from 'tar'
import { findPublishedAsset, findPublishedAssets, type ReleaseAsset } from './release-sources.ts'
import { downloadVerified } from './release-channel.ts'

/** Prefix every published seed archive carries. */
export const SEED_ARCHIVE_PREFIX = 'Harness-CN-seed-'

/**
 * Extensions a published seed archive may carry, best first.
 *
 * zstd is what this build publishes: it is about a fifth smaller than gzip on this content, and the
 * download is the user's wall clock. The gzip form is still accepted so a release published before
 * the switch remains fetchable by the same code path.
 */
export const SEED_ARCHIVE_EXTENSIONS = ['.tar.zst', '.tar.gz'] as const

/** Name of the bounded inventory that proves a seed is exactly what was published. */
const SEED_INTEGRITY_FILE = 'integrity.json'

/**
 * Directory under the cache root that holds seed archives.
 *
 * Every message that tells a user how to supply the archive by hand names this directory, and the
 * launch reads it before it asks any host, so the two are one fact rather than a string repeated
 * where they could drift apart.
 */
const SEED_DOWNLOADS_DIRECTORY = 'downloads'

/**
 * The published names of one release's seed archive, best first.
 * @param version - release version the seed belongs to.
 * @returns the file names the release may publish.
 */
export function seedArchiveNames(version: string): readonly string[] {
  return SEED_ARCHIVE_EXTENSIONS.map(extension => `${SEED_ARCHIVE_PREFIX}${version}${extension}`)
}

/**
 * File name of one part of a split archive.
 *
 * One host caps an attachment at 100 MB, and the seed is past that, so the same archive may be
 * published cut into numbered parts. This pattern is the contract between the publisher and this
 * reader: `<archive name>.part<number>`, numbered from one.
 */
const SEED_PART_PATTERN = /^Harness-CN-seed-(.+)\.tar\.zst\.part(\d+)$/u

/** One numbered part of a split seed archive, as published. */
interface SeedPart {
  readonly index: number
  readonly asset: ReleaseAsset
}

/**
 * Part number in a published file name, when that name is a part of this version's archive.
 * @param version - release version the part must belong to.
 * @param name - published file name.
 * @returns the part number, or undefined when the name is something else.
 */
function seedPartIndex(version: string, name: string): number | undefined {
  const match = SEED_PART_PATTERN.exec(name)
  if (match === null) return undefined
  const [, fileVersion, digits] = match
  if (fileVersion !== version || digits === undefined) return undefined
  const index = Number(digits)
  return Number.isSafeInteger(index) && index > 0 ? index : undefined
}

/**
 * The parts of one release's seed archive, ordered by number.
 *
 * A gap in the numbering is an error rather than something to work around: joining parts 1 and 3
 * produces a file that fails the archive check much later, and the user would have waited for a
 * download that could never succeed.
 * @param request - request implementation.
 * @param version - release version the parts belong to.
 * @returns the ordered parts, or undefined when the release publishes none.
 */
async function findPublishedSeedParts(
  request: typeof globalThis.fetch,
  version: string,
): Promise<readonly SeedPart[] | undefined> {
  const published = await findPublishedAssets(request, candidate => seedPartIndex(version, candidate) !== undefined)
  if (published === undefined) return undefined
  const parts = published.assets
    .map((asset): SeedPart => ({ asset, index: seedPartIndex(version, asset.name) ?? 0 }))
    .sort((left, right) => left.index - right.index)
  for (const [position, part] of parts.entries()) {
    if (part.index !== position + 1) {
      throw new Error(
        `离线包分卷不连续：${published.tag} 缺少 .part${String(position + 1)}`,
      )
    }
  }
  return parts
}

/**
 * Download every part at once and join them into the single archive the extractor expects.
 *
 * The parts are the same bytes the whole-file path would have fetched, so the joined file goes
 * through the same extraction and the same inventory check; only the transfer differs. Each part is
 * verified against its own digest where the host publishes one, and the joined size has to equal the
 * sum of the parts before anything is extracted.
 * @param options - cache root, request implementation, parts, version, and progress reporter.
 * @returns absolute path of the joined archive.
 */
async function downloadSeedParts(options: {
  readonly cacheRoot: string
  readonly fetch: typeof globalThis.fetch
  readonly parts: readonly SeedPart[]
  readonly version: string
  readonly onProgress?: SeedPackageOptions['onProgress']
}): Promise<string> {
  const directory = join(options.cacheRoot, SEED_DOWNLOADS_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const fractions = options.parts.map(() => 0)
  const report = (): void => {
    const average = fractions.reduce((sum, value) => sum + value, 0) / fractions.length
    options.onProgress?.(
      `正在并行下载离线包… ${String(Math.round(average * 100))}%（${String(options.parts.length)} 个分卷）`,
      average,
      '下载离线包',
    )
  }
  const downloaded = await Promise.all(options.parts.map(async (part, position) => {
    const result = await downloadVerified({
      directory,
      fetch: options.fetch,
      name: part.asset.name,
      sha256: part.asset.sha256,
      size: part.asset.size,
      url: part.asset.url,
      progress: (fraction) => {
        fractions[position] = fraction
        report()
      },
    })
    fractions[position] = 1
    report()
    return result
  }))

  const merged = join(directory, `${SEED_ARCHIVE_PREFIX}${options.version}${SEED_ARCHIVE_EXTENSIONS[0]}`)
  await rm(merged, { force: true })
  const sink = createWriteStream(merged)
  try {
    for (const file of downloaded) await pipeline(createReadStream(file.path), sink, { end: false })
  } finally {
    sink.end()
  }
  const expected = downloaded.reduce((sum, file) => sum + file.bytes, 0)
  const actual = statSync(merged).size
  if (actual !== expected) {
    await rm(merged, { force: true })
    throw new Error(`离线包分卷合并后大小不符：${String(actual)} != ${String(expected)}`)
  }
  // The parts are only useful until the join succeeded; keeping them would double the cache's cost.
  await Promise.all(downloaded.map(file => rm(file.path, { force: true })))
  return merged
}

/** Where a seed came from, for the run log. */
export type SeedOrigin = 'bundled' | 'cache' | 'download' | 'manual'

/** A seed that is present on disk and ready to be installed from. */
export interface SeedPackage {
  /** Absolute directory holding the seed. */
  readonly directory: string
  readonly origin: SeedOrigin
}

/** Options for {@link ensureSeedPackage}. */
export interface SeedPackageOptions {
  /** Release version this build binds its profile to. */
  readonly version: string
  /** Absolute directory that may carry a `seed` beside the runtime; an offline install does. */
  readonly resourceDir: string
  /** Absolute directory the fetched seed is kept under, one subdirectory per version. */
  readonly cacheRoot: string
  /** Request implementation; replaceable for tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Report what the fetch is doing, how far it has come, and which step that fraction belongs to. */
  readonly onProgress?: (note: string, fraction?: number, step?: SeedPackageStep) => void
}

/**
 * Which part of obtaining the offline package a report belongs to.
 *
 * The shell shows one step at a time with its own percentage, and looking for the package, fetching
 * it, and unpacking it are three different waits with three different denominators. They are named
 * here rather than parsed back out of the message, which exists to be read by a person.
 */
export type SeedPackageStep = '查找离线包' | '下载离线包' | '解包离线包'

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/**
 * A suffix no other run of the same program can produce.
 *
 * Temporary and set-aside directories carry this, which is what makes every directory a run writes
 * private to that run. Two runs that overlap — the installer's prebuild and a launch, or a launch
 * and a relaunch after a kill — then cannot delete or rename each other's files, which is the fault
 * this suffix exists to remove.
 */
function stamp(): string {
  return `${String(process.pid)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** Whether a directory holds a complete seed rather than a partial extraction. */
function isSeedDirectory(directory: string): boolean {
  return existsSync(join(directory, SEED_INTEGRITY_FILE))
}

/**
 * Whether a leftover directory is still being written by a run that is alive.
 *
 * Every temporary name this module creates carries the process that made it, so the question can be
 * answered from the name alone. A run that is still unpacking owns an incomplete directory on
 * purpose, and deleting it would fail that run on a file that was plainly there a moment ago: the
 * installer's prebuild and a launch overlapping is exactly when both exist at once. A run that was
 * killed leaves its name behind and nothing else, and that is what a sweep is for.
 * @param entry - one entry name from the cache directory.
 * @returns whether a live process is still working in that directory.
 */
function isLiveLeftover(entry: string): boolean {
  const marker = '.partial-'
  const owner = entry.slice(entry.indexOf(marker) + marker.length).split('-')[0] ?? ''
  const pid = Number.parseInt(owner, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process this one may not signal still exists, and is still writing. Only a missing process
    // makes a directory debris.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The decompressor one published archive needs, chosen by the name the host gave it. */
function decompressorFor(archive: string): ReturnType<typeof createGunzip> | undefined {
  if (archive.endsWith('.gz')) return createGunzip()
  if (archive.endsWith('.zst')) return createZstdDecompress()
  return undefined
}

/**
 * Filesystem faults that say "not now" rather than "not this".
 *
 * Windows reports a just-closed file as still occupied, a directory that is being emptied as still
 * occupied, and a rename over a file another process holds as a plain permission denial. None of
 * them describes the content being unpacked, so none of them should end a first launch.
 */
const TRANSIENT_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

/** Attempts one transient filesystem step gets before it is treated as a real refusal. */
const FILE_ATTEMPTS = 4

function transientErrorOf(reason: unknown): NodeJS.ErrnoException | undefined {
  const code = (reason as NodeJS.ErrnoException | undefined)?.code
  return code !== undefined && TRANSIENT_FILE_ERRORS.has(code)
    ? reason as NodeJS.ErrnoException
    : undefined
}

/**
 * Run one filesystem step, pausing between attempts while the fault is a transient one.
 * @param action - the step to run.
 * @param what - what the step is doing, for the error a real failure carries.
 */
async function withFileRetry<T>(action: () => Promise<T>, what: string): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < FILE_ATTEMPTS; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      if (transientErrorOf(error) === undefined) throw error
      last = error
      await new Promise(resolve => setTimeout(resolve, 80 * 2 ** attempt))
    }
  }
  throw errorOf(last, `${what} failed`)
}

/**
 * Remove a directory, or at least stop it from being in the way.
 *
 * Removal is what is wanted, and on a quiet machine it is what happens. When the directory cannot
 * be removed at all — a scanner still holding a file inside it, a handle from a run that was killed
 * — the directory is moved aside instead, under a name no later attempt looks for. That is the
 * difference this function exists for: a leftover extraction must never be able to fail a launch
 * twice, and deletion is the only step above that a locked file can refuse permanently.
 *
 * A directory that can neither be deleted nor moved aside is reported and left where it is. Every
 * caller of this is housekeeping — the name is one this run does not work in — so the directory is
 * a cost in disk space rather than a reason to fail, and the next launch tries again.
 * @param directory - absolute directory to get out of the way.
 * @param report - receives a line for the run log when deletion had to be worked around.
 * @returns whether the directory is gone from the name it was holding.
 */
async function clearDirectoryOrSetAside(
  directory: string,
  report?: (note: string, step?: SeedPackageStep) => void,
): Promise<boolean> {
  let refusal: unknown
  try {
    await withFileRetry(async () => rm(directory, { recursive: true, force: true }), `remove ${directory}`)
    return true
  } catch (error) {
    refusal = error
  }
  const setAside = `${directory}.stale-${stamp()}`
  try {
    await withFileRetry(async () => rename(directory, setAside), `set aside ${directory}`)
  } catch {
    // A directory that is already gone is the outcome that was wanted; one that is still there and
    // still cannot be moved is reported. The name it holds is the one that stays in the way, which
    // is why the caller is told: it is the difference between debris and a refusal.
    if (existsSync(directory)) {
      report?.(`${directory} 无法删除也无法改名，本次启动会绕开它：${errorOf(refusal, '').message}`)
      return false
    }
    return true
  }
  report?.(`${directory} 无法删除，已改名让位。`)
  // The name is what this call had to free. Its bytes are no longer this launch's problem: they are
  // under a name nothing looks for, and the next launch sweeps them.
  await rm(setAside, { recursive: true, force: true }).catch(() => undefined)
  return true
}

/**
 * Publish freshly unpacked content, replacing whatever is at the destination.
 *
 * A directory that is in the way is moved aside and only then deleted: an occupied destination then
 * costs one rename rather than the whole launch. Two runs can still reach the publish step at the
 * same time on one machine — the installer's prebuild and a launch — and Windows refuses a rename
 * onto a name that appeared after it was read. Both of those are the same situation from here: the
 * destination is not what this run read, so it is looked at again rather than failed on.
 * @param from - absolute directory holding the complete content.
 * @param to - absolute directory it should be published as.
 * @param report - receives a line for the run log when the destination could not be replaced.
 * @returns where the content ended up, which is the destination unless it was still held open.
 */
async function replaceDirectory(
  from: string,
  to: string,
  report?: (note: string, step?: SeedPackageStep) => void,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    let previous: string | undefined
    if (existsSync(to)) {
      const setAside = `${to}.old-${stamp()}`
      previous = setAside
      try {
        await withFileRetry(async () => rename(to, setAside), `set aside ${to}`)
      } catch {
        // The destination is held open by something this process cannot wait out. Unpacking beside it
        // has already produced a complete seed, and the next launch will replace the destination
        // then, so the attempt that did the work is allowed to succeed and to say where it worked.
        report?.(`${to} 仍被占用，暂不替换；下次启动会再次尝试。`)
        return from
      }
    }
    try {
      await withFileRetry(async () => rename(from, to), `publish ${to}`)
    } catch (error) {
      // Whatever went wrong, a complete seed under the destination is one this launch can install
      // from: another run got there first, and which run unpacks it is not the user's problem.
      if (isSeedDirectory(to)) {
        if (previous !== undefined) {
          await rm(previous, { recursive: true, force: true }).catch(() => undefined)
        }
        report?.(`${to} 已有另一个进程发布的离线包，本次改用该副本。`)
        return to
      }
      // The destination appeared between reading it and publishing over it, and it is not a seed:
      // another run is midway through the same unpack. One more pass moves it aside first.
      if (attempt === 0 && (error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      throw error
    }
    if (previous !== undefined) {
      await rm(previous, { recursive: true, force: true }).catch(() => undefined)
    }
    return to
  }
}

/**
 * Take back the space a previous run was interrupted in.
 *
 * A launch that was killed while unpacking, or that found the download blocked, leaves a directory
 * that is not a seed and is not wanted. Cleaning them up at the start is what keeps them from
 * accumulating forever, and it is also the cheapest place to notice one that cannot be removed: it
 * happens before the user is watching a progress bar.
 * @param cacheRoot - directory the fetched seed is kept under.
 * @param version - release version the current launch is obtaining.
 * @param report - receives a line for the run log when something could not be cleaned up.
 */
async function sweepSeedLeftovers(
  cacheRoot: string,
  version: string,
  report?: (note: string) => void,
): Promise<void> {
  const current = `seed-${version}`
  let entries: string[]
  try {
    entries = await readdir(cacheRoot)
  } catch {
    // No cache directory yet is the ordinary first launch.
    return
  }
  for (const entry of entries) {
    // The current version's own directory is the one this run is about to use or write; everything
    // else that carries the seed prefix is debris from a run that did not finish, including the
    // temporary and set-aside names this module itself creates.
    if (!entry.startsWith('seed-') || entry === current) continue
    // A directory another live run is unpacking into is not debris, it is a sibling at work. Both
    // are removed by the run that owns them or by a later launch, so skipping it costs nothing.
    if (isLiveLeftover(entry)) continue
    const directory = join(cacheRoot, entry)
    try {
      await withFileRetry(
        async () => rm(directory, { recursive: true, force: true }),
        `remove ${directory}`,
      )
    } catch {
      report?.(`未能清理上次遗留的 ${directory}，本次启动会绕开它。`)
    }
  }
}

/**
 * Extract one seed archive into a directory that is not published until it is complete.
 *
 * The extraction is streamed straight from the archive through its decompressor into tar, so the
 * 314 MB that come out never exist a second time on disk as an intermediate tar. The rename is what
 * makes the cache safe to trust on the next launch: a directory that exists is a directory whose
 * extraction finished, so a download interrupted halfway cannot be mistaken for a seed.
 *
 * Every directory this function writes to is private to this run, and a directory that this run
 * cannot have written is retired before the run depends on it. Two runs that overlap — the
 * installer's prebuild and a launch — therefore cannot take each other's half-written tree, and a
 * locked leftover from a killed run cannot fail the launch that follows it.
 * @param archive - absolute path of the downloaded archive.
 * @param destination - absolute directory the seed should end up at.
 * @param report - receives a line for the run log about what had to be cleaned up first.
 * @param onProgress - receives the fraction of the archive that has been read through.
 * @returns the directory the complete seed is at, which is the destination unless another process
 * held it open and the fresh tree is therefore still under its own name.
 */
async function extractSeed(
  archive: string,
  destination: string,
  report?: (note: string, step?: SeedPackageStep) => void,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  await clearDirectoryOrSetAside(`${destination}.partial`, report)
  // Staging is private to this run. A shared staging directory is what let an interrupted run and
  // its replacement delete each other's files halfway through, which is how a first launch could
  // fail on a directory that was plainly still there.
  const staging = `${destination}.partial-${stamp()}`
  await mkdir(staging, { recursive: true })
  let installed = ''
  try {
    const unpack = extract({
      cwd: staging,
      noMtime: true,
      preservePaths: false,
      // An entry that leaves the extraction directory is refused rather than sanitized: the archive
      // is one this product published, so a traversal attempt is a fault worth failing on.
      filter: (path) => {
        if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
          throw new Error(`the archive contains an unsafe path: ${path}`)
        }
        return true
      },
    })
    // What this pass writes is a fixed, much larger expansion of the archive, and measuring that
    // would mean measuring the disk rather than the work: the bytes that have gone in are what
    // tracks the pass, and they are already known exactly from the file's own size.
    const total = statSync(archive).size
    let read = 0
    let reported = -1
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        read += chunk.byteLength
        const percent = total === 0 ? 100 : Math.floor((read / total) * 100)
        if (percent !== reported) {
          reported = percent
          onProgress?.(total === 0 ? 1 : Math.min(read / total, 1))
        }
        callback(null, chunk)
      },
    })
    const decompressor = decompressorFor(archive)
    await pipeline(
      createReadStream(archive),
      counter,
      ...(decompressor === undefined ? [] : [decompressor]),
      unpack,
    )
    if (!isSeedDirectory(staging)) {
      throw new Error(`the archive does not contain ${SEED_INTEGRITY_FILE}`)
    }
    installed = await replaceDirectory(staging, destination, report)
    onProgress?.(1)
    return installed
  } catch (error) {
    throw errorOf(error, 'the offline package could not be unpacked')
  } finally {
    // Whichever directory was published holds the content. Staging that is still there and is not
    // what this run installed from is a tree that never became a seed, and leaving it would be
    // exactly the debris the next launch has to clean up.
    if (installed !== staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The archive a user put in the download directory by hand, when one is there.
 *
 * The failure message every unavailable network path ends with tells the user to fetch the archive
 * from a release page and drop it in this directory, so this is the other half of that instruction:
 * the directory is read, by the exact published names, before any host is asked. A machine that
 * cannot reach either release host at all still installs from a file that is already on the disk.
 * @param cacheRoot - directory the fetched seed is kept under; the download directory is inside it.
 * @param version - release version this build binds its profile to.
 * @returns the archive's absolute path, or undefined when the directory holds none.
 */
export function findSeedArchiveInDownloads(cacheRoot: string, version: string): string | undefined {
  const directory = join(cacheRoot, SEED_DOWNLOADS_DIRECTORY)
  const names = seedArchiveNames(version)
  for (const name of names) {
    const candidate = join(directory, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // The next published extension may still be there; a directory that does not exist at all
      // reports ENOENT for every name, which is the ordinary first-launch case.
    }
  }
  return undefined
}

/**
 * Produce a seed directory for this version, fetching it when it is not already at hand.
 *
 * The four sources are checked in the order that costs the user least: a seed shipped beside the
 * application (an offline or full installer), one an earlier launch already fetched, an archive the
 * user downloaded by hand into the download directory, and only then the network. The result is
 * always a directory carrying the seed's own inventory file; what that inventory says about the
 * bytes is checked by the caller, which is the same check regardless of where the seed came from.
 * @param options - version to obtain, where to look, and how to report progress.
 * @returns the seed directory and where it came from.
 */
export async function ensureSeedPackage(options: SeedPackageOptions): Promise<SeedPackage> {
  const bundled = join(options.resourceDir, 'seed')
  if (isSeedDirectory(bundled)) return { directory: bundled, origin: 'bundled' }

  const cached = join(options.cacheRoot, `seed-${options.version}`)
  if (isSeedDirectory(cached)) return { directory: cached, origin: 'cache' }

  // Everything a previous run left behind is dealt with before this run needs any of it: a killed
  // unpack must not be able to fail the launch that follows it, and a locked directory must be
  // discovered here rather than in the middle of an extraction the user is waiting on.
  options.onProgress?.('正在准备离线包…', undefined, '解包离线包')
  await sweepSeedLeftovers(options.cacheRoot, options.version, (note) => {
    options.onProgress?.(note, undefined, '解包离线包')
  })

  const request = options.fetch ?? globalThis.fetch
  const names = seedArchiveNames(options.version)
  // A file the user placed by hand is used as it is: the names it is looked up by are this
  // product's own, and the seed's own inventory is verified before anything is installed from it,
  // so "downloaded" and "hand-copied" are vouched for by the same check.
  const manual = findSeedArchiveInDownloads(options.cacheRoot, options.version)
  let archive = manual
  const origin = manual === undefined ? 'download' : 'manual'
  if (archive === undefined) {
    options.onProgress?.('正在查找离线包…', undefined, '查找离线包')
    const published = await findPublishedAsset(request, candidate => names.includes(candidate))
    if (published === undefined) {
      // A release may publish the same archive as numbered parts so that each file fits the smaller
      // attachment limit of the second host. The parts are that archive cut at byte boundaries, so
      // fetching them together is the same transaction over more connections; nothing about the
      // result is weaker, because the joined file still has to be a valid archive.
      const parts = await findPublishedSeedParts(request, options.version)
      if (parts === undefined) {
        throw new Error(
          `找不到离线包 ${names[0] ?? ''}（或其分卷 ${SEED_ARCHIVE_PREFIX}${options.version}${String(SEED_ARCHIVE_EXTENSIONS[0])}.part1…）。\n\n`
          + '请确认网络可用后重试；也可以手动从发布页下载该文件（分卷需全部下载后按序号拼接），'
          + `放进 ${join(options.cacheRoot, SEED_DOWNLOADS_DIRECTORY)} 后重新启动。`,
        )
      }
      archive = await downloadSeedParts({
        cacheRoot: options.cacheRoot,
        fetch: request,
        parts,
        version: options.version,
        onProgress: options.onProgress,
      })
    } else {
      const downloaded = await downloadVerified({
        directory: join(options.cacheRoot, SEED_DOWNLOADS_DIRECTORY),
        name: published.asset.name,
        url: published.asset.url,
        size: published.asset.size,
        sha256: published.asset.sha256,
        fetch: request,
        progress: (fraction) => {
          options.onProgress?.(
            `正在下载离线包… ${String(Math.round(fraction * 100))}%（${published.tag}）`,
            fraction,
            '下载离线包',
          )
        },
      })
      archive = downloaded.path
    }
  }

  options.onProgress?.('正在解包离线包… 0%', 0, '解包离线包')
  // Where the seed ended up, which is the cache directory unless something else was holding it: a
  // launch installs from a complete tree either way, and only the name differs.
  const directory = await extractSeed(
    archive,
    cached,
    (note, step) => { options.onProgress?.(note, undefined, step ?? '解包离线包') },
    (fraction) => {
      options.onProgress?.(
        `正在解包离线包… ${String(Math.round(fraction * 100))}%`,
        fraction,
        '解包离线包',
      )
    },
  )
  // A fetched archive is only useful once, and keeping it would cost more than re-fetching it is
  // worth. The user's own file is left where they put it: they chose that directory, and it is
  // theirs to keep or delete.
  if (manual === undefined) await rm(archive, { force: true }).catch(() => undefined)
  options.onProgress?.('', 1, '解包离线包')
  return { directory, origin }
}
