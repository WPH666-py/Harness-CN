/** GitHub Releases update channel for the unsigned Harness-CN Windows build. */

import { createHash, type Hash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn as detachedSpawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gt, valid } from 'semver'
import type { DesktopUpdateBackend, DesktopUpdateDownload, DesktopUpdateIntegrity } from './update-backend.ts'

/**
 * Repository whose releases are this fork's update channel.
 *
 * The fork publishes the Windows installer as a release asset there, so the
 * repository is the channel identity rather than a tunable: a build that
 * checks a different repository is a different product build.
 */
export const DESKTOP_UPDATE_RELEASE_REPOSITORY = 'WPH666-py/Harness-CN'

/** One request timeout's worth of GitHub's documented unauthenticated ceiling: 60 requests per hour per address. */
const RELEASES_PER_PAGE = 30

/** Silent `/S` switch of the NSIS installer, which then replaces the previous installation. */
const NSIS_SILENT_SWITCH = '/S'

/** Platform and architecture token this channel publishes installers for. */
const PLATFORM_TARGET = 'win-x64'

/** Longest wait for the releases request, which bounds a network that accepts the connection and then never answers. */
const CHECK_TIMEOUT_MS = 30_000

/** Longest gap between download bytes before the transfer is treated as stalled. */
const DOWNLOAD_STALL_MS = 60_000

/** Longest total download time, which bounds a transfer that trickles rather than stalls. */
const DOWNLOAD_TOTAL_MS = 30 * 60_000

/** HTTP statuses GitHub returns when the caller exceeded a rate limit. */
const RATE_LIMIT_STATUSES = new Set([403, 429])

/**
 * Describe one failed GitHub API response.
 *
 * GitHub's unauthenticated ceiling is 60 requests per hour per address, and a
 * 403 or 429 there means throttling rather than a broken channel, so the
 * message names that cause instead of leaving the bare status to read as a
 * wiring bug. The thrown error is ordinary: the coordinator suppresses it on
 * the automatic path and reports it only for a manual check.
 * @param status - HTTP status of the response.
 * @param statusText - reason phrase the response carried, empty when it carried none.
 * @returns message naming the failed request and its likely cause.
 */
function requestFailure(status: number, statusText: string): string {
  const suffix = statusText === '' ? '' : ` ${statusText}`
  if (RATE_LIMIT_STATUSES.has(status)) {
    return `desktop update: GitHub rate-limited the releases request (HTTP ${String(status)}${suffix});`
      + ' this build checks at most once per launch, so a later check succeeds'
  }
  return `desktop update: GitHub releases request failed with HTTP ${String(status)}${suffix}`
}

/** One release asset this channel can install from. */
export interface GithubReleaseAsset {
  /** Asset filename as uploaded. */
  readonly name: string
  /** Direct download URL for the asset. */
  readonly browserDownloadUrl: string
  /** GitHub's `sha256:<hex>` content digest, absent on releases that predate the field. */
  readonly digest?: string
}

/** Release metadata this channel reads; every other field of the API response is ignored. */
export interface GithubRelease {
  /** Release tag, which carries a leading `v` for this repository. */
  readonly tagName: string
  /** Whether the release is an unpublished draft. */
  readonly draft: boolean
  /** Assets attached to the release. */
  readonly assets: readonly GithubReleaseAsset[]
}

/**
 * Read one release from a GitHub API response.
 * @param value - one decoded element of a releases list.
 * @returns release metadata, or undefined when the element has no usable tag, draft flag, or asset list.
 */
function releaseOf(value: unknown): GithubRelease | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const tagName = record.tag_name
  const draft = record.draft
  const assets = record.assets
  if (typeof tagName !== 'string' || typeof draft !== 'boolean' || !Array.isArray(assets)) return undefined
  return {
    tagName,
    draft,
    assets: assets.flatMap((asset: unknown) => {
      const entry = assetOf(asset)
      return entry === undefined ? [] : [entry]
    }),
  }
}

/**
 * Read one asset from a GitHub API response.
 * @param value - one decoded element of a release's asset list.
 * @returns asset metadata, or undefined when the element has no usable name or download URL.
 */
function assetOf(value: unknown): GithubReleaseAsset | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = record.name
  const browserDownloadUrl = record.browser_download_url
  const digest = record.digest
  if (typeof name !== 'string' || typeof browserDownloadUrl !== 'string') return undefined
  return {
    name,
    browserDownloadUrl,
    ...(typeof digest === 'string' && digest !== '' ? { digest } : {}),
  }
}

/**
 * Convert one release tag to a comparable version.
 *
 * This release line ships prereleases such as `0.1.5-rc.1`, so the tag keeps
 * any prerelease part; semver then orders `0.1.5-rc.2` above `0.1.5-rc.1` and
 * `0.1.5` above both. Versions compare only against the running build, so a
 * newer release is offered whether or not either side is a prerelease.
 * @param tagName - release tag, with or without a leading `v`.
 * @returns the comparable version, or undefined when the tag is not a semantic version.
 */
export function releaseVersion(tagName: string): string | undefined {
  const trimmed = tagName.startsWith('v') ? tagName.slice(1) : tagName
  return valid(trimmed) ?? undefined
}

/**
 * Build the asset filename this repository uploads for one version.
 *
 * The release asset is named after the product and the version it installs,
 * independently of electron-builder's `artifactName` template, so the matcher
 * anchors on that name instead of the packaging pattern.
 * @param version - release version the installer carries.
 * @returns exact asset filename expected for the version.
 */
export function expectedAssetName(version: string): string {
  return `Harness-CN-${version}-win-x64-setup.exe`
}

/**
 * Find the installer asset for one release version.
 * @param assets - assets attached to the release.
 * @param version - version the release tag names.
 * @returns the matching asset, or undefined when the release carries no installer for this build.
 */
export function findInstallerAsset(
  assets: readonly GithubReleaseAsset[],
  version: string,
): GithubReleaseAsset | undefined {
  const expected = expectedAssetName(version)
  return assets.find(asset => asset.name.toLowerCase() === expected.toLowerCase())
}

/** Options for {@link DesktopGithubUpdateBackend}. */
export interface DesktopGithubUpdateBackendOptions {
  /** Version of the running application, as Electron reports it. */
  readonly currentVersion: string
  /** Directory the installer is downloaded into, normally under the platform temp directory. */
  readonly downloadDirectory: string
  /** JSON request implementation; tests inject one that never reaches the network. */
  readonly fetch: typeof globalThis.fetch
  /** Installer launcher; tests inject one that starts no process. */
  readonly spawn?: typeof detachedSpawn
  /** Overall deadline for the releases request; tests shorten it to bound a request that never settles. */
  readonly checkTimeoutMs?: number
  /** Longest gap between download bytes; tests shorten it to bound a stalled transfer. */
  readonly stallTimeoutMs?: number
}

/**
 * Update channel backed by this fork's GitHub Releases.
 *
 * Version choice reads the releases list rather than the single "latest"
 * release: `/releases/latest` omits releases GitHub flags as prereleases, which
 * would hide an rc release from the builds that most need it, while this
 * release line ships rc versions. Drafts are excluded, and the highest version
 * wins regardless of publication order.
 *
 * A release is only an offered update when it carries the installer this build
 * can run, because a release whose uploaded asset was named for a version other
 * than its tag would otherwise prompt the user and fail after the download. An
 * older installable release therefore wins over a newer one that is not.
 *
 * Integrity: the GitHub API reports each asset's `sha256:` digest. When the
 * release carries one, the downloaded bytes are hashed in the same pass that
 * writes them, and a mismatch deletes the file and fails the download.
 * Releases published before GitHub exposed that field carry no digest, and
 * such a download is installed unverified.
 */
export class DesktopGithubUpdateBackend implements DesktopUpdateBackend {
  private readonly spawn: typeof detachedSpawn
  private readonly checkTimeoutMs: number
  private readonly stallTimeoutMs: number
  private checkedRelease: GithubRelease | undefined
  private checkedVersion: string | undefined
  private downloadable: { readonly asset: GithubReleaseAsset; readonly file: string } | undefined

  /**
   * @param options - application version, download directory, and injectable request, spawn, and timeout implementations.
   */
  constructor(private readonly options: DesktopGithubUpdateBackendOptions) {
    this.spawn = options.spawn ?? detachedSpawn
    this.checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS
    this.stallTimeoutMs = options.stallTimeoutMs ?? DOWNLOAD_STALL_MS
  }

  /** Check the fork's release channel for a newer installed version. */
  async check(): Promise<string | undefined> {
    this.checkedRelease = undefined
    this.checkedVersion = undefined
    const controller = new AbortController()
    const expired = setTimeout(() => {
      controller.abort(new Error(
        'desktop update: the GitHub releases request did not answer within'
        + ` ${String(Math.round(this.checkTimeoutMs / 1000))} seconds and was aborted`,
      ))
    }, this.checkTimeoutMs)
    let response: Response
    try {
      response = await this.options.fetch(this.releasesEndpoint(), {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'Harness-CN-Desktop',
        },
        signal: controller.signal,
      })
    } catch (error) {
      // The deadline aborts the request, which surfaces as the transport's own abort error; the
      // recorded cause is the deadline the user and the log need to see.
      throw controller.signal.reason instanceof Error ? controller.signal.reason : error
    } finally {
      clearTimeout(expired)
    }
    if (!response.ok) throw new Error(requestFailure(response.status, response.statusText))
    const releases = this.releaseList(await response.json())
    let newest: { readonly version: string; readonly release: GithubRelease } | undefined
    for (const release of releases) {
      const version = releaseVersion(release.tagName)
      if (version === undefined || release.draft) continue
      if (findInstallerAsset(release.assets, version) === undefined) continue
      if (newest !== undefined && !gt(version, newest.version)) continue
      newest = { version, release }
    }
    if (newest === undefined || !gt(newest.version, this.options.currentVersion)) return undefined
    this.checkedRelease = newest.release
    this.checkedVersion = newest.version
    return newest.version
  }

  /**
   * Download and verify the installer for the version the last check retained.
   * @param request - version the last check retained and the progress sink for this download.
   * @returns `verified` when the release declared a digest that the bytes matched, `unverified` otherwise.
   */
  async download({ version, progress }: DesktopUpdateDownload): Promise<DesktopUpdateIntegrity> {
    const release = this.checkedRelease
    if (release === undefined || this.checkedVersion !== version) {
      throw new Error(`desktop update: version ${version} was not the version the last check retained`)
    }
    const asset = findInstallerAsset(release.assets, version)
    if (asset === undefined) {
      throw new Error(`desktop update: release ${release.tagName} carries no installer for ${PLATFORM_TARGET}`)
    }
    await mkdir(this.options.downloadDirectory, { recursive: true })
    const file = join(this.options.downloadDirectory, asset.name)
    const expectedDigest = sha256DigestOf(asset)
    // Hashing while the bytes are written verifies the installer with one pass over ~200 MB.
    const hash = createHash('sha256')
    await this.transfer(asset.browserDownloadUrl, file, progress, expectedDigest === undefined ? undefined : hash)
    if (expectedDigest === undefined) {
      // GitHub has exposed `digest` only since 2025; a release published before that, or created
      // through a path that omits it, arrives hashless, and this download is installed unverified.
      this.downloadable = { asset, file }
      return 'unverified'
    }
    if (hash.digest('hex') !== expectedDigest) {
      await rm(file, { force: true })
      throw new Error(`desktop update: ${asset.name} failed its SHA-256 digest check; the download was discarded`)
    }
    this.downloadable = { asset, file }
    return 'verified'
  }

  /** Start the verified installer silently and let it replace this installation. */
  async install(): Promise<void> {
    const downloadable = this.downloadable
    if (downloadable === undefined) {
      throw new Error('desktop update: no verified installer has been downloaded')
    }
    this.spawn(downloadable.file, [NSIS_SILENT_SWITCH], { detached: true, stdio: 'ignore' }).unref()
  }

  /**
   * Read the API response into releases.
   * @param payload - decoded response body.
   * @returns every release the response describes.
   */
  private releaseList(payload: unknown): readonly GithubRelease[] {
    if (!Array.isArray(payload)) {
      throw new Error('desktop update: GitHub releases response was not a release list')
    }
    return payload.flatMap((entry: unknown) => {
      const release = releaseOf(entry)
      return release === undefined ? [] : [release]
    })
  }

  /** @returns the newest-releases API URL of the fork's release channel. */
  private releasesEndpoint(): string {
    return `https://api.github.com/repos/${DESKTOP_UPDATE_RELEASE_REPOSITORY}/releases`
      + `?per_page=${String(RELEASES_PER_PAGE)}`
  }

  /**
   * Stream one asset to disk without buffering it in memory.
   * @param url - asset download URL.
   * @param file - destination path, replaced when it already exists.
   * @param progress - sink for the downloaded fraction.
   * @param hash - SHA-256 accumulator to feed, or undefined when the release declares no digest.
   */
  private async transfer(
    url: string,
    file: string,
    progress: (fraction: number) => void,
    hash: Hash | undefined,
  ): Promise<void> {
    const controller = new AbortController()
    let failure: Error | undefined
    let stall: NodeJS.Timeout | undefined
    const stalled = (): void => {
      failure = new Error(
        `desktop update: the download stalled for ${String(this.stallTimeoutMs / 1000)} seconds and was aborted`,
      )
      controller.abort(failure)
    }
    const restartStallTimer = (): void => {
      clearTimeout(stall)
      stall = setTimeout(stalled, this.stallTimeoutMs)
    }
    const total = setTimeout(() => {
      failure = new Error(
        `desktop update: the download did not finish within ${String(DOWNLOAD_TOTAL_MS / 60_000)} minutes and was aborted`,
      )
      controller.abort(failure)
    }, DOWNLOAD_TOTAL_MS)
    restartStallTimer()
    try {
      const response = await this.options.fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`desktop update: installer download failed with HTTP ${String(response.status)}`)
      }
      if (response.body === null) throw new Error('desktop update: installer download carried no body')
      const expected = declaredLength(response.headers)
      let received = 0
      // The platform's ReadableStream and the one `node:stream` converts describe the same object;
      // their declared read signatures differ, which is the only reason for the cast.
      const body = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      // A stream that already queued its first chunk delivers it inside `Readable.fromWeb`, before
      // any listener added afterwards runs, so the declaration is read first and the handler is
      // attached after the size is known.
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        restartStallTimer()
        hash?.update(chunk)
        progress(expected === undefined ? 0 : Math.min(1, received / expected))
      })
      const destination = createWriteStream(file)
      // A Hash is fed with `update` rather than used as a pipeline transform: pipelining it would
      // write its digest to the file instead of the installer bytes.
      const written = pipeline(body, destination)
      // Aborting the request does not by itself end a body that has stopped delivering bytes, so
      // the deadline races the transfer: the abort reason becomes the failure of this download.
      await Promise.race([written, once(controller.signal, 'abort')])
      if (failure !== undefined) throw failure
      if (expected !== undefined && received !== expected) {
        throw new Error(
          `desktop update: the download ended after ${String(received)} of ${String(expected)} bytes`,
        )
      }
      progress(1)
    } catch (error) {
      // A stall or overall timeout aborts the request, which surfaces as the transport's own
      // abort error; the recorded cause is the failure the user and the log need to see.
      throw failure ?? error
    } finally {
      clearTimeout(stall)
      clearTimeout(total)
    }
  }
}

/**
 * Read one asset's expected SHA-256 digest.
 * @param asset - asset the release describes.
 * @returns lowercase hex digest, or undefined when the release carries none.
 */
function sha256DigestOf(asset: GithubReleaseAsset): string | undefined {
  const digest = asset.digest
  if (digest === undefined) return undefined
  const [algorithm, hex] = digest.split(':')
  if (algorithm?.toLowerCase() !== 'sha256' || hex === undefined || !/^[0-9a-f]{64}$/iu.test(hex)) return undefined
  return hex.toLowerCase()
}

/**
 * Read the declared content length of a download response.
 * @param headers - response headers.
 * @returns declared byte length, or undefined when the response declares none.
 */
function declaredLength(headers: Headers): number | undefined {
  const value = Number(headers.get('content-length'))
  return Number.isFinite(value) && value > 0 ? value : undefined
}
