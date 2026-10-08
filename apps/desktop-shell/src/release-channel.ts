/**
 * Release channel for the unsigned Harness-CN Windows build.
 *
 * The channel is hand-rolled rather than taken from `tauri-plugin-updater` or
 * `electron-updater`: both want a signing keypair and one endpoint, while this product has
 * to work from a network where `github.com` is frequently unreachable. The useful property
 * is therefore being able to ask SEVERAL hosts and take whichever answers, which is why the
 * sources below are a list rather than a setting.
 *
 * Integrity follows what each host can actually prove. GitHub returns a `sha256:` digest for
 * every uploaded asset, so those downloads are verified. Gitee returns none, so its downloads
 * travel over TLS and are reported as unverified rather than silently treated as trusted.
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn as detachedSpawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DesktopUpdateBackend, DesktopUpdateDownload, DesktopUpdateIntegrity } from '../../desktop/src/update-backend.ts'
import { isNewer, releaseVersion } from './version.ts'

/** One host the channel may ask for a release. */
interface ReleaseSource {
  readonly id: string
  readonly kind: 'gitee' | 'github'
  readonly owner: string
  readonly repo: string
}

/** One installable file a release publishes. */
interface ReleaseAsset {
  readonly name: string
  readonly url: string
  readonly size: number | undefined
  readonly sha256: string
}

/** One release as the channel understands it, from either host. */
interface ReleaseFacts {
  readonly tag: string
  readonly page: string
  readonly assets: readonly ReleaseAsset[]
}

/**
 * Sources are tried in order and every one is asked; the newest version wins.
 *
 * Gitee leads because it answers from inside China, where the GitHub API often does not.
 * Its release attachments are capped at 100 MB while this installer is deliberately kept
 * under that, so either host can supply the file — but the ordering still matters for the
 * check, which is the request that has to succeed for the user to be told anything at all.
 */
export const RELEASE_SOURCES: readonly ReleaseSource[] = [
  { id: 'gitee', kind: 'gitee', owner: 'ph-wang', repo: 'Harness-CN' },
  { id: 'github', kind: 'github', owner: 'WPH666-py', repo: 'Harness-CN' },
]

const USER_AGENT = 'Harness-CN-updater'
const CHECK_TIMEOUT_MS = 20_000
const DOWNLOAD_TOTAL_MS = 30 * 60_000

/** Silent switch of the NSIS installer, which then replaces the previous installation in place. */
const NSIS_SILENT_SWITCH = '/S'

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** The file this channel installs, from whatever name a host gave it. */
function pickInstaller(assets: readonly ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find(asset => /[_-]setup\.exe$/iu.test(asset.name))
    ?? assets.find(asset => /\.exe$/iu.test(asset.name))
}

async function getJson(url: string, accept: string, fetchImpl: typeof globalThis.fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`)
  return await response.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** GitHub publishes an asset digest alongside every upload, which is what makes its files verifiable. */
async function readGithub(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts> {
  const releases = await getJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=30`,
    'application/vnd.github+json',
    fetchImpl,
  )
  if (!Array.isArray(releases)) throw new Error('GitHub answered with an unexpected release list')
  const newest = releases
    .filter(isRecord)
    .map((release) => {
      const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
      return { release, tag, version: releaseVersion(tag) }
    })
    .filter((entry): entry is { release: Record<string, unknown>; tag: string; version: string } =>
      entry.version !== undefined)
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : 1))[0]
  if (newest === undefined) throw new Error('GitHub published no release this channel can read')
  const assets = Array.isArray(newest.release.assets) ? newest.release.assets : []
  return {
    tag: newest.tag,
    page: typeof newest.release.html_url === 'string' ? newest.release.html_url : '',
    assets: assets.filter(isRecord).map((asset): ReleaseAsset => ({
      name: typeof asset.name === 'string' ? asset.name : '',
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      size: typeof asset.size === 'number' ? asset.size : undefined,
      // "sha256:abc..." -> "abc..."; older releases carry no digest at all.
      sha256: typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/iu, '') : '',
    })),
  }
}

/**
 * Gitee answers the same question with a different shape.
 *
 * Its `assets` array holds only the auto-generated source archives, so an uploaded attachment
 * has to be requested separately; and because a prerelease is a normal release there, the whole
 * list is read and compared with `semver` rather than trusting a "latest" endpoint that orders
 * prereleases differently from the updater.
 */
async function readGitee(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts> {
  const base = `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`
  const releases = await getJson(`${base}/releases?per_page=100`, 'application/json', fetchImpl)
  if (!Array.isArray(releases)) throw new Error('Gitee answered with an unexpected release list')
  const newest = releases
    .filter(isRecord)
    .map((release) => {
      const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
      return {
        assets: Array.isArray(release.assets) ? release.assets.filter(isRecord) : [],
        id: typeof release.id === 'number' ? release.id : undefined,
        tag,
        version: releaseVersion(tag),
      }
    })
    .filter((entry): entry is { assets: Record<string, unknown>[]; id: number | undefined; tag: string; version: string } =>
      entry.version !== undefined)
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : 1))[0]
  if (newest === undefined) throw new Error('Gitee published no release this channel can read')

  const assets: ReleaseAsset[] = []
  // A release also lists `/releases/download/` links; they are the fallback when the
  // attachment endpoint refuses, which it does for a repository that has none.
  for (const asset of newest.assets) {
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!url.includes('/releases/download/')) continue
    assets.push({
      name: typeof asset.name === 'string' ? asset.name : '',
      url,
      size: typeof asset.size === 'number' ? asset.size : undefined,
      sha256: '',
    })
  }
  if (newest.id !== undefined) {
    try {
      const files = await getJson(`${base}/releases/${String(newest.id)}/attach_files`, 'application/json', fetchImpl)
      if (Array.isArray(files)) {
        for (const file of files.filter(isRecord)) {
          const name = typeof file.title === 'string' ? file.title : (typeof file.name === 'string' ? file.name : '')
          if (name === '') continue
          // Gitee has answered this endpoint with a URL under more than one field name, and with no
          // URL at all. The canonical download path is derivable from facts this function already
          // holds, so a release whose attachment record carries only a title is still installable
          // rather than being silently skipped.
          const published = [file.download_url, file.browser_download_url, file.url]
            .find(candidate => typeof candidate === 'string' && candidate !== '')
          const url = typeof published === 'string'
            ? published
            : `https://gitee.com/${source.owner}/${source.repo}/releases/download/${newest.tag}/${encodeURIComponent(name)}`
          assets.push({ name, url, size: typeof file.size === 'number' ? file.size : undefined, sha256: '' })
        }
      }
    } catch {
      // The version is still usable without an attachment list, and the caller falls through
      // to the next source for a download URL.
    }
  }
  return {
    tag: newest.tag,
    page: `https://gitee.com/${source.owner}/${source.repo}/releases/tag/${newest.tag}`,
    assets,
  }
}

/** Where one download lands. Cleaned per attempt, so a half file can never pass for a good one. */
function downloadPath(directory: string, name: string): string {
  return `${directory}\\${String(name === '' ? 'update.exe' : name).replace(/[^\w.\-]/gu, '_')}`
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
    const answers = await Promise.all(RELEASE_SOURCES.map(async (source) => {
      try {
        const facts = source.kind === 'gitee'
          ? await readGitee(source, request)
          : await readGithub(source, request)
        return { facts, error: undefined }
      } catch (error) {
        return { facts: undefined, error: errorOf(error, 'release check failed') }
      }
    }))
    const readable = answers.filter((answer): answer is { facts: ReleaseFacts; error: undefined } => answer.facts !== undefined)
    if (readable.length === 0) {
      throw new AggregateError(
        answers.map(answer => answer.error ?? new Error('release check failed')),
        answers.map(answer => `${answer.error?.message ?? 'release check failed'}`).join('; '),
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
    await mkdir(options.downloadDirectory, { recursive: true })
    const target = downloadPath(options.downloadDirectory, asset.name)
    await rm(target, { force: true })
    try {
      const response = await request(asset.url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TOTAL_MS),
      })
      if (!response.ok || response.body === null) {
        throw new Error(`desktop update: download failed with ${String(response.status)}`)
      }
      const total = Number(response.headers.get('content-length')) || asset.size || 0
      const hash = createHash('sha256')
      let received = 0
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        received += chunk.byteLength
        if (total > 0) request_.progress(Math.min(1, received / total))
      })
      await pipeline(body, createWriteStream(target))
      request_.progress(1)
      const digest = hash.digest('hex')
      if (asset.sha256 !== '') {
        if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
          await rm(target, { force: true })
          throw new Error(`desktop update: checksum mismatch for ${asset.name}`)
        }
        downloaded = target
        return 'verified'
      }
      downloaded = target
      return 'unverified'
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      throw errorOf(error, 'desktop update: download failed')
    }
  }

  const install = async (): Promise<void> => {
    const target = downloaded
    if (target === undefined) throw new Error('desktop update: nothing has been downloaded')
    const size = await stat(target).then(entry => entry.size, () => 0)
    if (size === 0) throw new Error('desktop update: the downloaded installer is empty')
    // `/S` is the NSIS silent switch, and a `currentUser` install needs no elevation. The
    // installer upgrades in place, so nothing uninstalls first: doing that would leave a window
    // with nothing installed, and a failure inside it would take the application away.
    const child = spawnInstaller(target, [NSIS_SILENT_SWITCH], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  return { check, download, install }
}
