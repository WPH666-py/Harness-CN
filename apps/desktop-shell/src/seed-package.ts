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

import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { extract } from 'tar'
import { findPublishedAsset } from './release-sources.ts'
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
 * The published names of one release's seed archive, best first.
 * @param version - release version the seed belongs to.
 * @returns the file names the release may publish.
 */
export function seedArchiveNames(version: string): readonly string[] {
  return SEED_ARCHIVE_EXTENSIONS.map(extension => `${SEED_ARCHIVE_PREFIX}${version}${extension}`)
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

/** The decompressor one published archive needs, chosen by the name the host gave it. */
function decompressorFor(archive: string): ReturnType<typeof createGunzip> | undefined {
  if (archive.endsWith('.gz')) return createGunzip()
  if (archive.endsWith('.zst')) return createZstdDecompress()
  return undefined
}

/**
 * Extract one seed archive into a directory that is not published until it is complete.
 *
 * The extraction is streamed straight from the archive through its decompressor into tar, so the
 * 314 MB that come out never exist a second time on disk as an intermediate tar. The rename is what
 * makes the cache safe to trust on the next launch: a directory that exists is a directory whose
 * extraction finished, so a download interrupted halfway cannot be mistaken for a seed.
 * @param archive - absolute path of the downloaded archive.
 * @param destination - absolute directory the seed should end up at.
 * @param staging - absolute directory the extraction runs in, beside the destination.
 */
async function extractSeed(archive: string, destination: string, staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
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
    const decompressor = decompressorFor(archive)
    await (decompressor === undefined
      ? pipeline(createReadStream(archive), unpack)
      : pipeline(createReadStream(archive), decompressor, unpack))
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
  const names = seedArchiveNames(options.version)
  options.onProgress?.('正在查找离线包…')
  const published = await findPublishedAsset(request, candidate => names.includes(candidate))
  if (published === undefined) {
    throw new Error(
      `找不到离线包 ${names[0] ?? ''}。\n\n`
      + `请确认网络可用后重试；也可以手动从发布页下载该文件，`
      + `放进 ${join(options.cacheRoot, 'downloads')} 后重新启动。`,
    )
  }

  const result = await downloadVerified({
    directory: join(options.cacheRoot, 'downloads'),
    name: published.asset.name,
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
  // The archive is only useful once; keeping it would cost more than re-fetching it is worth.
  await rm(result.path, { force: true }).catch(() => undefined)
  options.onProgress?.('', undefined)
  return { directory: cached, origin: 'download' }
}
