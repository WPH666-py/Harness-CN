/**
 * The offline seed, as a package the first launch fetches rather than one the installer carries.
 *
 * WHY IT IS SEPARATE. The seed is ~314 MB of already-installed runtime: Node, pnpm, the first-party
 * tarballs, and a warmed pnpm store. Shipping it inside the installer made the installer 92.7 MB
 * against Gitee's 100 MB attachment limit — 7 MB of headroom, which one release of ordinary growth
 * would spend. Publishing it as its own attachment puts both files far under the limit and lets the
 * two be replaced independently.
 *
 * WHAT THAT COSTS. The first launch is no longer offline out of the box: it downloads ~87 MB once
 * and keeps the extracted result, so every later launch is offline as before. The launch reports
 * the download, and a machine that cannot reach either host is told what to fetch and from where
 * rather than being left at a progress bar.
 *
 * The extracted seed is verified by the same inventory check the bundled one went through
 * (`verifySeedIntegrity`), so "downloaded" is not a weaker claim than "shipped".
 */

import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { extract } from 'tar'
import { findPublishedAsset } from './release-sources.ts'
import { downloadVerified } from './release-channel.ts'

/** Prefix every published seed archive carries. */
export const SEED_ARCHIVE_PREFIX = 'Harness-CN-seed-'

/** Suffix every published seed archive carries. */
export const SEED_ARCHIVE_SUFFIX = '.tar.gz'

/** Name of the bounded inventory that proves a seed is exactly what was published. */
const SEED_INTEGRITY_FILE = 'integrity.json'

/**
 * The published name of one release's seed archive.
 * @param version - release version the seed belongs to.
 * @returns the file name the release publishes.
 */
export function seedArchiveName(version: string): string {
  return `${SEED_ARCHIVE_PREFIX}${version}${SEED_ARCHIVE_SUFFIX}`
}

/** Where a seed came from, for the run log. */
export type SeedOrigin = 'bundled' | 'cache' | 'download'

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
  /** Report what the fetch is doing, and how far it has come. */
  readonly onProgress?: (note: string, fraction?: number) => void
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Whether a directory holds a complete seed rather than a partial extraction. */
function isSeedDirectory(directory: string): boolean {
  return existsSync(join(directory, SEED_INTEGRITY_FILE))
}

/**
 * Extract one seed archive into a directory that is not published until it is complete.
 *
 * The rename is what makes the cache safe to trust on the next launch: a directory that exists is
 * a directory whose extraction finished, so a download interrupted halfway cannot be mistaken for
 * a seed and cannot brick the next launch.
 * @param archive - absolute path of the downloaded archive.
 * @param destination - absolute directory the seed should end up at.
 * @param staging - absolute directory the extraction runs in, beside the destination.
 */
async function extractSeed(archive: string, destination: string, staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    extract({
      cwd: staging,
      file: archive,
      // The published archive is gzipped; the extension is the only thing that says so.
      gzip: archive.endsWith('.gz'),
      noMtime: true,
      preservePaths: false,
      strict: true,
      sync: true,
    })
    if (!isSeedDirectory(staging)) {
      throw new Error(`the archive does not contain ${SEED_INTEGRITY_FILE}`)
    }
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw errorOf(error, 'the offline package could not be unpacked')
  }
}

/**
 * Produce a seed directory for this version, fetching it when it is not already at hand.
 *
 * The three sources are checked in the order that costs the user least: a seed shipped beside the
 * application (an offline or full installer), then one an earlier launch already fetched, and only
 * then the network. The result is always a directory carrying the seed's own inventory file; what
 * that inventory says about the bytes is checked by the caller, which is the same check regardless
 * of where the seed came from.
 * @param options - version to obtain, where to look, and how to report progress.
 * @returns the seed directory and where it came from.
 */
export async function ensureSeedPackage(options: SeedPackageOptions): Promise<SeedPackage> {
  const bundled = join(options.resourceDir, 'seed')
  if (isSeedDirectory(bundled)) return { directory: bundled, origin: 'bundled' }

  const cached = join(options.cacheRoot, `seed-${options.version}`)
  if (isSeedDirectory(cached)) return { directory: cached, origin: 'cache' }

  const request = options.fetch ?? globalThis.fetch
  const name = seedArchiveName(options.version)
  options.onProgress?.('正在查找离线包…')
  const published = await findPublishedAsset(request, candidate => candidate === name)
  if (published === undefined) {
    throw new Error(
      `找不到离线包 ${name}。\n\n`
      + `请确认网络可用后重试；也可以手动从发布页下载该文件，`
      + `放进 ${join(options.cacheRoot, 'downloads')} 后重新启动。`,
    )
  }

  const downloads = join(options.cacheRoot, 'downloads')
  const result = await downloadVerified({
    directory: downloads,
    name,
    url: published.asset.url,
    size: published.asset.size,
    sha256: published.asset.sha256,
    fetch: request,
    progress: (fraction) => {
      options.onProgress?.(
        `正在下载离线包… ${String(Math.round(fraction * 100))}%（${published.tag}）`,
        fraction,
      )
    },
  })

  options.onProgress?.('正在解包离线包…')
  await extractSeed(result.path, cached, `${cached}.partial`)
  // The archive is 87 MB and only useful once; keeping it would cost more than the seed itself
  // is worth to re-fetch, and it can be fetched again.
  await rm(result.path, { force: true }).catch(() => undefined)
  const bytes = await stat(cached).then(() => true, () => false)
  if (!bytes) throw new Error('the offline package could not be stored')
  options.onProgress?.('', undefined)
  return { directory: cached, origin: 'download' }
}
