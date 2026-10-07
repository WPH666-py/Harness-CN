import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_UPDATE_RELEASE_REPOSITORY,
  DesktopGithubUpdateBackend,
  expectedAssetName,
  findInstallerAsset,
  releaseVersion,
  type GithubRelease,
  type GithubReleaseAsset,
} from '../src/update-github-backend.ts'

/** One request a stub recorded. */
interface RecordedRequest {
  readonly url: string
  readonly init: RequestInit | undefined
}

/**
 * Build a fetch-like function that answers one API list.
 * @param status - HTTP status the releases response carries.
 * @param body - decoded JSON body the releases response carries.
 * @param statusText - reason phrase the response carries, empty when it carries none.
 * @returns stub fetch plus the list it recorded requests into.
 */
function apiFetch(
  status: number,
  body: unknown,
  statusText = 'OK',
): { readonly fetch: typeof globalThis.fetch; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: new Headers(),
      json: async () => body,
    }
  }) as unknown as typeof globalThis.fetch
  return { fetch, requests }
}

/**
 * Build a fetch-like function that serves one installer body.
 * @param body - bytes the download response carries.
 * @param contentLength - declared content length; 0 declares none.
 * @returns stub fetch plus the list it recorded requests into.
 */
function downloadFetch(
  body: Uint8Array,
  contentLength?: number,
): { readonly fetch: typeof globalThis.fetch; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const headers = new Headers()
  if (contentLength === undefined || contentLength > 0) {
    headers.set('content-length', String(contentLength ?? body.length))
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers,
      body: Readable.toWeb(Readable.from([Buffer.from(body)])),
    }
  }) as unknown as typeof globalThis.fetch
  return { fetch, requests }
}

/**
 * Build a fetch-like function whose body emits one chunk and then never ends.
 * @param body - bytes emitted before the stream stalls.
 * @returns stub fetch that declares more bytes than it delivers.
 */
function stallingFetch(body: Uint8Array): typeof globalThis.fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(body.length * 100) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body)
        // Never closed: the transfer must end on its own deadline, not on the response.
      },
    }),
  })) as unknown as typeof globalThis.fetch
}

/**
 * Build a fetch-like function that answers the download with a failed response.
 * @param status - HTTP status the response carries.
 * @param body - response body, null when the response carries none.
 * @returns stub fetch.
 */
function responseFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Service Unavailable',
    headers: new Headers(),
    body,
  })) as unknown as typeof globalThis.fetch
}

/**
 * Build one release asset as the API reports it.
 *
 * The fixtures carry the API's own field names, because the response body is
 * where the parser reads them; the cast stands for that decoding step.
 * @param name - asset filename as uploaded.
 * @param digest - `sha256:<hex>` content digest, omitted when the release declares none.
 * @returns one decoded API asset object.
 */
function assetFixture(name: string, digest?: string): GithubReleaseAsset {
  return {
    name,
    browser_download_url: `https://github.com/${DESKTOP_UPDATE_RELEASE_REPOSITORY}/releases/download/tag/${name}`,
    ...(digest === undefined ? {} : { digest }),
  } as unknown as GithubReleaseAsset
}

/**
 * Build one release as the API reports it.
 * @param tagName - release tag.
 * @param assets - assets attached to the release, in API field names.
 * @param draft - whether the release is an unpublished draft.
 * @returns one decoded API release object.
 */
function releaseFixture(
  tagName: string,
  assets: readonly unknown[],
  draft = false,
): GithubRelease {
  return { tag_name: tagName, draft, prerelease: false, assets: [...assets] } as unknown as GithubRelease
}

/**
 * SHA-256 of one buffer in the `sha256:<hex>` form the API reports.
 * @param bytes - bytes to hash.
 * @returns GitHub's digest field value.
 */
function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Real temporary directory each test downloads into, so the transfer exercises the filesystem. */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-cn-update-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * Build a backend over one API response.
 * @param options - API status and body plus the installed version to compare against.
 * @returns backend plus the requests its API stub recorded.
 */
function backendOver(options: {
  status?: number
  statusText?: string
  body: unknown
  currentVersion: string
  checkTimeoutMs?: number
  spawn?: typeof import('node:child_process').spawn
}): { readonly backend: DesktopGithubUpdateBackend; readonly requests: RecordedRequest[] } {
  const api = apiFetch(options.status ?? 200, options.body, options.statusText)
  const backend = new DesktopGithubUpdateBackend({
    currentVersion: options.currentVersion,
    downloadDirectory: join(directory, 'downloads'),
    fetch: api.fetch,
    ...(options.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: options.checkTimeoutMs }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  })
  return { backend, requests: api.requests }
}

/**
 * Build a backend that already retained the release one download test installs.
 *
 * One stub answers both requests the backend makes: the releases list, and then
 * the asset transfer. Splitting them inside the stub keeps every download test
 * on the real check-then-download sequence instead of seeding private state.
 * @param options - release version, asset digest, download stub, spawn stub, and stall timeout.
 * @returns backend holding a retained release, plus the download requests it recorded.
 */
async function checkedBackend(options: {
  version?: string
  digest?: string
  transfer: typeof globalThis.fetch
  spawn?: typeof import('node:child_process').spawn
  stallTimeoutMs?: number
}): Promise<{
  readonly backend: DesktopGithubUpdateBackend
  readonly downloadRequests: RecordedRequest[]
}> {
  const version = options.version ?? '0.1.6'
  const downloadRequests: RecordedRequest[] = []
  const api = apiFetch(200, [releaseFixture(`v${version}`, [assetFixture(expectedAssetName(version), options.digest)])])
  const routed = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('https://api.github.com/')) return await api.fetch(input, init)
    downloadRequests.push({ url: String(input), init })
    return await options.transfer(input, init)
  }) as typeof globalThis.fetch
  const backend = new DesktopGithubUpdateBackend({
    currentVersion: '0.1.5-rc.1',
    downloadDirectory: join(directory, 'downloads'),
    fetch: routed,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
  })
  await backend.check()
  return { backend, downloadRequests }
}

describe('desktop GitHub release channel metadata', () => {
  it('names the fork release channel in the request URL', () => {
    expect(DESKTOP_UPDATE_RELEASE_REPOSITORY).toBe('WPH666-py/Harness-CN')
  })

  it('accepts release tags with and without a leading v and rejects non-versions', () => {
    expect(releaseVersion('v0.1.5-rc.1')).toBe('0.1.5-rc.1')
    expect(releaseVersion('0.1.6')).toBe('0.1.6')
    expect(releaseVersion('latest')).toBeUndefined()
    expect(releaseVersion('v2')).toBeUndefined()
  })

  it('expects the asset name the release actually uploads', () => {
    expect(expectedAssetName('0.1.5-rc.1')).toBe('Harness-CN-0.1.5-rc.1-win-x64-setup.exe')
    expect(findInstallerAsset([
      assetFixture('harness-cn-0.1.6-win-x64.exe'),
      assetFixture('Harness-CN-0.1.6-win-x64-setup.exe'),
    ], '0.1.6')?.name).toBe('Harness-CN-0.1.6-win-x64-setup.exe')
    expect(findInstallerAsset([assetFixture('Harness-CN-0.1.6-win-x64-setup.exe')], '0.1.6'))
      .toMatchObject({ name: 'Harness-CN-0.1.6-win-x64-setup.exe' })
    expect(findInstallerAsset([assetFixture('Harness-CN-0.1.5-rc.1-win-x64-setup.exe')], '0.1.6'))
      .toBeUndefined()
  })
})

describe('desktop GitHub release channel check', () => {
  it('sends the headers GitHub requires for an unauthenticated request', async () => {
    const { backend, requests } = backendOver({
      body: [releaseFixture('v0.1.5-rc.1', [assetFixture(expectedAssetName('0.1.5-rc.1'))])],
      currentVersion: '0.1.5-rc.1',
    })

    await backend.check()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url)
      .toBe(`https://api.github.com/repos/${DESKTOP_UPDATE_RELEASE_REPOSITORY}/releases?per_page=30`)
    expect(requests[0]?.init?.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'Harness-CN-Desktop',
    })
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('offers the highest version regardless of publication order', async () => {
    const { backend } = backendOver({
      body: [
        releaseFixture('v0.1.5-rc.1', [assetFixture(expectedAssetName('0.1.5-rc.1'))]),
        releaseFixture('v0.2.0', [assetFixture(expectedAssetName('0.2.0'))]),
        releaseFixture('v0.1.6', [assetFixture(expectedAssetName('0.1.6'))]),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBe('0.2.0')
  })

  it('orders prereleases below their release and skips drafts', async () => {
    const { backend } = backendOver({
      body: [
        releaseFixture('v0.1.5-rc.2', [assetFixture(expectedAssetName('0.1.5-rc.2'))]),
        releaseFixture('v0.1.5', [assetFixture(expectedAssetName('0.1.5'))]),
        releaseFixture('v0.9.0', [assetFixture(expectedAssetName('0.9.0'))], true),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBe('0.1.5')
  })

  it('offers a prerelease to a build on a stable version', async () => {
    const { backend } = backendOver({
      body: [releaseFixture('v0.1.6-rc.1', [assetFixture(expectedAssetName('0.1.6-rc.1'))])],
      currentVersion: '0.1.5',
    })

    await expect(backend.check()).resolves.toBe('0.1.6-rc.1')
  })

  it('treats an equal, older, unversioned, or renamed-asset release as current', async () => {
    const { backend } = backendOver({
      body: [
        releaseFixture('v0.1.5-rc.1', [assetFixture(expectedAssetName('0.1.5-rc.1'))]),
        releaseFixture('v0.1.4', [assetFixture(expectedAssetName('0.1.4'))]),
        releaseFixture('nightly', [assetFixture(expectedAssetName('0.3.0'))]),
        releaseFixture('v0.3.0', [assetFixture('Harness-CN-0.3.0-win-x64-setup.exe.bak')]),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBeUndefined()
  })

  it('falls through to an older release when the newest carries no installer', async () => {
    const { backend } = backendOver({
      body: [
        releaseFixture('v0.3.0', [assetFixture('Harness-CN-0.1.5-rc.1-win-x64-setup.exe')]),
        releaseFixture('v0.2.0', [assetFixture(expectedAssetName('0.2.0'))]),
        releaseFixture('v0.1.6', [assetFixture(expectedAssetName('0.1.6'))]),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBe('0.2.0')
  })

  it('reports the build current when no release carries an installer', async () => {
    const { backend } = backendOver({
      body: [
        releaseFixture('v0.3.0', []),
        releaseFixture('v0.2.0', [assetFixture('harness-cn-0.2.0-win-x64.exe')]),
        releaseFixture('v0.1.6', [assetFixture('Harness-CN-0.1.5-rc.1-win-x64-setup.exe')]),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBeUndefined()
  })

  it('never offers a release whose asset is named for another version', async () => {
    const { backend } = backendOver({
      body: [releaseFixture('v0.3.0', [assetFixture('Harness-CN-0.2.0-win-x64-setup.exe')])],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBeUndefined()
    await expect(backend.download({ version: '0.3.0', progress: () => {} }))
      .rejects.toThrow(/was not the version the last check retained/u)
  })

  it('names GitHub rate limiting as the cause of a refused request', async () => {
    const { backend } = backendOver({
      status: 403,
      statusText: 'Forbidden',
      body: { message: 'API rate limit exceeded' },
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).rejects.toThrow(/rate-limited the releases request \(HTTP 403 Forbidden\)/u)
  })

  it('reports an unexpected status as a failed request', async () => {
    const { backend } = backendOver({ status: 500, statusText: '', body: {}, currentVersion: '0.1.5-rc.1' })

    await expect(backend.check()).rejects.toThrow('desktop update: GitHub releases request failed with HTTP 500')
  })

  it('reports a response that is not a release list', async () => {
    const { backend } = backendOver({ body: { message: 'Not Found' }, currentVersion: '0.1.5-rc.1' })

    await expect(backend.check()).rejects.toThrow(/was not a release list/u)
  })

  it('skips release entries the API describes incompletely', async () => {
    const { backend } = backendOver({
      body: [
        null,
        { tag_name: 'v0.4.0' },
        { tag_name: 4, draft: false, assets: [] },
        { tag_name: 'v0.5.0', draft: false, assets: [null, { name: 7 }, assetFixture('notes.txt')] },
        releaseFixture('v0.6.0', [assetFixture(expectedAssetName('0.6.0'))]),
      ],
      currentVersion: '0.1.5-rc.1',
    })

    await expect(backend.check()).resolves.toBe('0.6.0')
  })

  it('bounds a releases request that never answers', async () => {
    // The fake honours the request signal the way the platform's fetch does, because a fake that
    // ignored it would leave the deadline unreachable and the test vacuous rather than red.
    const never: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) return
      if (signal.aborted) { reject(signal.reason); return }
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
    const backend = new DesktopGithubUpdateBackend({
      currentVersion: '0.1.5-rc.1',
      downloadDirectory: join(directory, 'downloads'),
      fetch: never,
      checkTimeoutMs: 20,
    })

    await expect(backend.check()).rejects.toThrow(/did not answer within 0 seconds and was aborted/u)
  })
})

describe('desktop GitHub release channel download', () => {
  const version = '0.1.6'
  const installer = Buffer.from('installer bytes')

  it('streams the installer, reports progress, and hashes it in the same pass', async () => {
    const transfer = downloadFetch(installer)
    const { backend, downloadRequests } = await checkedBackend({ transfer: transfer.fetch, digest: digestOf(installer) })
    const progress: number[] = []

    await expect(backend.download({ version, progress: fraction => progress.push(fraction) }))
      .resolves.toBe('verified')

    expect(downloadRequests).toHaveLength(1)
    await expect(readFile(join(directory, 'downloads', expectedAssetName(version)))).resolves.toEqual(installer)
    expect(progress.at(-1)).toBe(1)
  })

  it('refuses a digest mismatch and deletes the download', async () => {
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({ transfer: transfer.fetch, digest: `sha256:${'0'.repeat(64)}` })

    await expect(backend.download({ version, progress: () => {} }))
      .rejects.toThrow(/failed its SHA-256 digest check; the download was discarded/u)
    await expect(readdir(join(directory, 'downloads'))).resolves.toEqual([])
  })

  it('downloads an installer whose release declares no digest', async () => {
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({ transfer: transfer.fetch })

    await expect(backend.download({ version, progress: () => {} })).resolves.toBe('unverified')

    await expect(readFile(join(directory, 'downloads', expectedAssetName(version)))).resolves.toEqual(installer)
  })

  it('does not treat a digest of another algorithm as verification', async () => {
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({ transfer: transfer.fetch, digest: 'sha512:not-a-sha256-digest' })

    await expect(backend.download({ version, progress: () => {} })).resolves.toBe('unverified')

    await expect(readFile(join(directory, 'downloads', expectedAssetName(version)))).resolves.toEqual(installer)
  })

  it('runs the verified installer silently in its own process group', async () => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ unref })) as unknown as typeof import('node:child_process').spawn
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({ transfer: transfer.fetch, digest: digestOf(installer), spawn })
    await backend.download({ version, progress: () => {} })

    await backend.install()

    expect(spawn).toHaveBeenCalledWith(
      join(directory, 'downloads', expectedAssetName(version)),
      ['/S'],
      { detached: true, stdio: 'ignore' },
    )
    expect(unref).toHaveBeenCalledOnce()
  })

  it('refuses to install before a download completed', async () => {
    const spawn = vi.fn()
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({
      transfer: transfer.fetch,
      spawn: spawn as unknown as typeof import('node:child_process').spawn,
    })

    await expect(backend.install()).rejects.toThrow(/no verified installer has been downloaded/u)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a version the last check did not retain', async () => {
    const transfer = downloadFetch(installer)
    const { backend } = await checkedBackend({ transfer: transfer.fetch })

    await expect(backend.download({ version: '0.9.9', progress: () => {} }))
      .rejects.toThrow(/was not the version the last check retained/u)
  })

  it('keeps the missing-installer refusal as the backstop when a retained release carries none', async () => {
    // A release entry is only an offered update while its asset list holds the installer, so the
    // check cannot retain an installable release without one. The refusal in `download` therefore
    // guards the state where the retained release loses its asset before the transfer starts.
    const api = apiFetch(200, [releaseFixture('v0.1.5', [assetFixture(expectedAssetName('0.1.5'))])])
    const backend = new DesktopGithubUpdateBackend({
      currentVersion: '0.1.5-rc.1',
      downloadDirectory: join(directory, 'downloads'),
      fetch: api.fetch,
    })
    await expect(backend.check()).resolves.toBe('0.1.5')
    const retained = (backend as unknown as { checkedRelease: { assets: unknown[] } }).checkedRelease
    retained.assets = []

    await expect(backend.download({ version: '0.1.5', progress: () => {} }))
      .rejects.toThrow(/carries no installer for win-x64/u)
  })

  it('fails a transfer that ends short of its declared length', async () => {
    const transfer = downloadFetch(installer, installer.length + 4096)
    const { backend } = await checkedBackend({ transfer: transfer.fetch })

    await expect(backend.download({ version, progress: () => {} }))
      .rejects.toThrow(new RegExp(`ended after ${String(installer.length)} of ${String(installer.length + 4096)} bytes`, 'u'))
  })

  it('aborts a transfer that stops delivering bytes', async () => {
    const { backend } = await checkedBackend({ transfer: stallingFetch(installer), stallTimeoutMs: 20 })

    await expect(backend.download({ version, progress: () => {} }))
      .rejects.toThrow(/the download stalled for 0.02 seconds and was aborted/u)
  })

  it('reports a failed installer response', async () => {
    const { backend } = await checkedBackend({ transfer: responseFetch(503, undefined) })

    await expect(backend.download({ version, progress: () => {} }))
      .rejects.toThrow(/installer download failed with HTTP 503/u)
  })

  it('reports an installer response with no body', async () => {
    const { backend } = await checkedBackend({ transfer: responseFetch(200, null) })

    await expect(backend.download({ version, progress: () => {} }))
      .rejects.toThrow(/installer download carried no body/u)
  })

  it('reports a transfer without a declared length through progress alone', async () => {
    // A response that declares no length cannot be measured, so the only reports are the start of
    // an unmeasurable transfer and its completion; the file still arrives whole.
    const transfer = downloadFetch(installer, 0)
    const { backend } = await checkedBackend({ transfer: transfer.fetch })
    const progress: number[] = []

    await expect(backend.download({ version, progress: fraction => progress.push(fraction) }))
      .resolves.toBe('unverified')

    expect(progress).toEqual([0, 1])
    await expect(readFile(join(directory, 'downloads', expectedAssetName(version)))).resolves.toEqual(installer)
  })
})
