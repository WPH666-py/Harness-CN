/**
 * Release channel for the unsigned Harness-CN Windows build.
 *
 * The channel is hand-rolled rather than taken from `tauri-plugin-updater` or `electron-updater`:
 * both want a signing keypair and one endpoint, while this product has to work from a network where
 * `github.com` is frequently unreachable. The useful property is therefore being able to ask
 * SEVERAL hosts and take whichever answers, which is what `release-sources.ts` provides.
 *
 * This module decides WHICH version to offer and hands the file to the platform installer. The
 * download itself is shared with the first-launch seed fetch, because both need the same thing:
 * bytes on disk, reported as they arrive, vouched for exactly as far as the host allows.
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn as detachedSpawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DesktopUpdateBackend, DesktopUpdateDownload, DesktopUpdateIntegrity } from '../../desktop/src/update-backend.ts'
import {
  RELEASE_SOURCES,
  USER_AGENT,
  readReleaseAnswers,
  type ReleaseAsset,
  type ReleaseFacts,
} from './release-sources.ts'
import { isNewer, releaseVersion } from './version.ts'

/** Longest total download time, which bounds a transfer that trickles rather than stalls. */
const DOWNLOAD_TOTAL_MS = 30 * 60_000

/** Silent switch of the NSIS installer, which then replaces the previous installation in place. */
const NSIS_SILENT_SWITCH = '/S'

/** The file this channel installs, from whatever name a host gave it. */
function pickInstaller(assets: readonly ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find(asset => /[_-]setup\.exe$/iu.test(asset.name))
    ?? assets.find(asset => /\.exe$/iu.test(asset.name))
}

/** One download's inputs, and how to report it. */
export interface VerifiedDownloadRequest {
  /** Absolute path of the directory the file lands in. */
  readonly directory: string
  /** File name to store it under, as the host published it. */
  readonly name: string
  /** URL the host published. */
  readonly url: string
  /** Published size, used for progress when the response carries no length. */
  readonly size?: number | undefined
  /** Published `sha256`, empty when the host does not offer one. */
  readonly sha256: string
  /** Completed fraction of the transfer, from 0 through 1. */
  readonly progress?: ((fraction: number) => void) | undefined
  /** Request implementation. */
  readonly fetch: typeof globalThis.fetch
}

/** Where one download landed, and how far it could be vouched for. */
export interface VerifiedDownload {
  readonly path: string
  readonly bytes: number
  readonly integrity: DesktopUpdateIntegrity
}

/** Turn a published name into something safe to use as a file name. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]/gu, '_')
  return cleaned === '' ? 'download.bin' : cleaned
}

/**
 * Fetch one published file, reporting progress and verifying it as far as the host allows.
 *
 * A file the host gave a digest for is checked against it and deleted when it disagrees; a file
 * with no digest is reported as `unverified` rather than `verified`, because "we could not check
 * this" and "we checked this and it is correct" must not look the same to the person about to run
 * it. What that means for a caller is that only the first result is a claim about the bytes.
 * @param request - what to fetch, where to put it, and how to report progress.
 * @returns the file's path, its size, and how it was vouched for.
 */
export async function downloadVerified(request: VerifiedDownloadRequest): Promise<VerifiedDownload> {
  await mkdir(request.directory, { recursive: true })
  const target = `${request.directory}\\${safeFileName(request.name)}`
  await rm(target, { force: true })
  try {
    const response = await request.fetch(request.url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TOTAL_MS),
    })
    if (!response.ok || response.body === null) {
      throw new Error(`download failed with ${String(response.status)}`)
    }
    const total = Number(response.headers.get('content-length')) || request.size || 0
    const hash = createHash('sha256')
    let received = 0
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.byteLength
      if (total > 0) request.progress?.(Math.min(1, received / total))
    })
    await pipeline(body, createWriteStream(target))
    request.progress?.(1)
    const digest = hash.digest('hex')
    if (request.sha256 !== '' && digest.toLowerCase() !== request.sha256.toLowerCase()) {
      await rm(target, { force: true })
      throw new Error(`checksum mismatch for ${request.name}`)
    }
    return {
      path: target,
      bytes: (await stat(target)).size,
      integrity: request.sha256 === '' ? 'unverified' : 'verified',
    }
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Options for {@link createReleaseChannel}. */
export interface ReleaseChannelOptions {
  /** Version of the running application. */
  readonly currentVersion: string
  /** Directory the installer is downloaded into. */
  readonly downloadDirectory: string
  /** Request implementation; replaceable for tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Process spawner; replaceable for tests. */
  readonly spawn?: typeof detachedSpawn
}

/**
 * Create the release channel this build checks, downloads from, and installs through.
 * @param options - running version, download directory, and injectable transport.
 * @returns a channel the update coordinator can drive.
 */
export function createReleaseChannel(options: ReleaseChannelOptions): DesktopUpdateBackend {
  const request = options.fetch ?? globalThis.fetch
  const spawnInstaller = options.spawn ?? detachedSpawn
  let offered: ReleaseFacts | undefined
  let offeredAsset: ReleaseAsset | undefined
  let downloaded: string | undefined

  const check = async (): Promise<string | undefined> => {
    const answers = await readReleaseAnswers(request, RELEASE_SOURCES)
    const readable = answers.filter(
      (answer): answer is (typeof answer) & { facts: ReleaseFacts } => answer.facts !== undefined,
    )
    if (readable.length === 0) {
      throw new AggregateError(
        answers.map(answer => answer.error ?? new Error('release check failed')),
        answers.map(answer => answer.error?.message ?? 'release check failed').join('; '),
      )
    }
    // The newest tag across the hosts, so a stale mirror cannot pin this build to an old release.
    const newest = readable.reduce((best, answer) => {
      const left = releaseVersion(answer.facts.tag)
      const right = releaseVersion(best.facts.tag)
      if (left === undefined) return best
      if (right === undefined) return answer
      return isNewer(left, right) ? answer : best
    })
    // Among the hosts offering that same release, prefer one that can actually supply the
    // installer: a host that reports a version but publishes no file would otherwise offer an
    // update the same screen then refuses to download.
    const tied = readable.filter(answer => releaseVersion(answer.facts.tag) === releaseVersion(newest.facts.tag))
    const chosen = tied.find(answer => pickInstaller(answer.facts.assets) !== undefined) ?? newest
    offered = chosen.facts
    offeredAsset = pickInstaller(chosen.facts.assets)
    const version = releaseVersion(chosen.facts.tag)
    if (version === undefined || !isNewer(version, options.currentVersion)) return undefined
    if (offeredAsset === undefined) throw new Error(`release ${chosen.facts.tag} publishes no installer`)
    return version
  }

  const download = async (request_: DesktopUpdateDownload): Promise<DesktopUpdateIntegrity> => {
    const asset = offeredAsset
    if (asset === undefined || offered === undefined) throw new Error('desktop update: no release has been checked')
    if (releaseVersion(offered.tag) !== request_.version) {
      throw new Error('desktop update: the offered release changed since it was checked')
    }
    const result = await downloadVerified({
      directory: options.downloadDirectory,
      name: asset.name,
      url: asset.url,
      size: asset.size,
      sha256: asset.sha256,
      progress: request_.progress,
      fetch: request,
    })
    downloaded = result.path
    return result.integrity
  }

  const install = async (): Promise<void> => {
    const target = downloaded
    if (target === undefined) throw new Error('desktop update: nothing has been downloaded')
    const size = await stat(target).then(entry => entry.size, () => 0)
    if (size === 0) throw new Error('desktop update: the downloaded installer is empty')
    // `/S` is the NSIS silent switch, and a `currentUser` install needs no elevation. The installer
    // upgrades in place, so nothing uninstalls first: doing that would leave a window with nothing
    // installed, and a failure inside it would take the application away.
    const child = spawnInstaller(target, [NSIS_SILENT_SWITCH], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  return { check, download, install }
}
