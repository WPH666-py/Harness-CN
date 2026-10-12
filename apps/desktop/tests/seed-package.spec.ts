/**
 * Behavior of the first launch's offline package: where it is looked for, and how it is obtained.
 *
 * The seed is ~300 MB, so these cases exercise the decision rather than the bytes: which sources
 * are consulted and in what order, whether a file the user placed by hand is used, and which
 * release an archive is taken from. `tar` is mocked to copy a prepared tree, which keeps the
 * extraction path under test without unpacking a real archive into the case's temporary directory.
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Directory the mocked unpacker copies from; set by each case that unpacks an archive. */
const unpackSource = vi.hoisted(() => ({ current: '' }))

vi.mock('tar', async () => {
  const { cpSync, readdirSync } = await import('node:fs')
  const { PassThrough } = await import('node:stream')
  return {
    // The real `extract` is a writable stream the decompressed archive flows into. These cases only
    // need the resulting tree, so the prepared directory is copied when that stream ends, which is
    // when the real unpacker has written its last entry; the filter and the inventory check around
    // it run exactly as they do in production.
    extract: (options: { cwd: string; filter: (path: string) => boolean }) => {
      const source = unpackSource.current
      const sink = new PassThrough()
      sink.on('end', () => {
        for (const entry of readdirSync(source)) {
          options.filter(entry)
          cpSync(join(source, entry), join(options.cwd, entry), { recursive: true })
        }
      })
      sink.resume()
      return sink
    },
  }
})

const { ensureSeedPackage, findSeedArchiveInDownloads, seedArchiveNames } = await import(
  '../../desktop-shell/src/seed-package.ts',
)
const { findPublishedAsset } = await import('../../desktop-shell/src/release-sources.ts')

/** One GitHub-shaped releases answer, every entry listed. */
function githubReleasesBody(entries: readonly { tag: string; assets: readonly string[] }[]): string {
  return JSON.stringify(entries.map(entry => ({
    tag_name: entry.tag,
    html_url: `https://github.com/WPH666-py/Harness-CN/releases/tag/${entry.tag}`,
    body: '',
    published_at: '2026-10-10T00:00:00Z',
    assets: entry.assets.map(name => ({
      name,
      size: 4,
      browser_download_url: `https://github.com/WPH666-py/Harness-CN/releases/download/${entry.tag}/${name}`,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  })))
}

/** One Gitee-shaped releases answer, every entry listed. */
function giteeReleasesBody(entries: readonly { tag: string; assets: readonly string[] }[]): string {
  return JSON.stringify(entries.map(entry => ({
    id: 1,
    tag_name: entry.tag,
    body: '',
    created_at: '2026-10-10T00:00:00Z',
    assets: entry.assets.map(name => ({
      name,
      size: 4,
      browser_download_url: `https://gitee.com/ph-wang/Harness-CN/releases/download/${entry.tag}/${name}`,
    })),
  })))
}

/** A prepared seed tree: an inventory file plus one runtime file. */
async function prepareSeedTree(root: string): Promise<string> {
  const source = join(root, 'prepared-seed')
  await mkdir(join(source, 'runtime'), { recursive: true })
  await writeFile(join(source, 'integrity.json'), '{"files":[]}')
  await writeFile(join(source, 'runtime', 'node.exe'), 'binary')
  return source
}

/**
 * Put a gzip archive at one published name.
 *
 * The bytes never need to be a real tar, because the unpacker itself is the mocked seam — but they
 * do have to be real gzip, which is what the launch pipes them through before that seam. A file of
 * arbitrary bytes fails in the decompressor, which is a failure of the fixture rather than of the
 * behavior under test.
 * @param path - published archive path to create.
 */
async function writeSeedArchive(path: string): Promise<void> {
  await pipeline(
    Readable.from([Buffer.alloc(1024, 7)]),
    createGzip(),
    createWriteStream(path),
  )
}

describe('desktop offline seed', () => {
  /** Temporary root standing in for `~/.dsh/desktop`. */
  let cacheRoot: string
  /** Temporary directory standing in for the installer's own resources. */
  let resourceDir: string
  /** Temporary root both of the above live under. */
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-cn-seed-'))
    cacheRoot = join(root, 'desktop')
    resourceDir = join(root, 'resources')
    await mkdir(cacheRoot, { recursive: true })
    await mkdir(resourceDir, { recursive: true })
  })

  afterEach(async () => {
    unpackSource.current = ''
    await rm(root, { recursive: true, force: true })
  })

  it('uses an archive the user placed in the download directory the failure message names', async () => {
    const version = '0.1.5-rc.17'
    // The gzip form, so the case also covers the extension a release published before the switch
    // to zstd still carries.
    const archive = seedArchiveNames(version)[1] ?? ''
    const downloads = join(cacheRoot, 'downloads')
    await mkdir(downloads, { recursive: true })
    await writeSeedArchive(join(downloads, archive))
    unpackSource.current = await prepareSeedTree(root)

    // A launch that reaches no host at all is exactly the case the manual copy exists for.
    const fetchImpl = (async () => { throw new Error('no host may be asked') }) as unknown as typeof globalThis.fetch
    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: fetchImpl })

    expect(seed.origin).toBe('manual')
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8')).toBe('{"files":[]}')
    // The user's own file is theirs to keep; only a fetched archive is deleted after unpacking.
    expect(existsSync(join(downloads, archive))).toBe(true)
  })

  it('finds an archive by its published name, and ignores anything else in that directory', async () => {
    const version = '0.1.5-rc.17'
    const downloads = join(cacheRoot, 'downloads')
    await mkdir(downloads, { recursive: true })
    await writeFile(join(downloads, 'something-else.tar.zst'), 'not a seed')

    expect(findSeedArchiveInDownloads(cacheRoot, version)).toBeUndefined()

    const archive = seedArchiveNames(version)[0] ?? ''
    await writeFile(join(downloads, archive), 'archive bytes')
    expect(findSeedArchiveInDownloads(cacheRoot, version)).toBe(join(downloads, archive))

    // The second published extension is accepted too, so a release from before the switch remains
    // installable by the same path.
    await rm(join(downloads, archive))
    const gzip = seedArchiveNames(version)[1] ?? ''
    await writeFile(join(downloads, gzip), 'archive bytes')
    expect(findSeedArchiveInDownloads(cacheRoot, version)).toBe(join(downloads, gzip))
  })

  it('keeps a cached seed ahead of any archive sitting in the download directory', async () => {
    const version = '0.1.5-rc.17'
    const cached = join(cacheRoot, `seed-${version}`)
    await mkdir(cached, { recursive: true })
    await writeFile(join(cached, 'integrity.json'), '{"files":[]}')
    const downloads = join(cacheRoot, 'downloads')
    await mkdir(downloads, { recursive: true })
    await writeFile(join(downloads, seedArchiveNames(version)[0] ?? ''), 'archive bytes')

    const fetchImpl = (async () => { throw new Error('no host may be asked') }) as unknown as typeof globalThis.fetch
    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: fetchImpl })

    expect(seed.origin).toBe('cache')
    expect(seed.directory).toBe(cached)
  })

  it('reports every host failed when the archive is neither at hand nor published', async () => {
    const version = '0.1.5-rc.17'
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as typeof globalThis.fetch

    await expect(ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: fetchImpl }))
      .rejects.toThrow(/找不到离线包/u)
  })
})

describe('published archive lookup', () => {
  it('finds a seed archive in an older release when the newest one does not carry it', async () => {
    const wanted = 'Harness-CN-seed-0.1.5-rc.17.tar.zst'
    // GitHub's newest release is the one that belongs to this build; Gitee's is newer still and
    // carries only an installer, which is the shape that used to end the search.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('gitee.com')) {
        return new Response(giteeReleasesBody([
          { tag: 'v0.1.5-rc.18', assets: ['Harness-CN_0.1.5-rc.18_x64-setup.exe'] },
          { tag: 'v0.1.5-rc.16', assets: ['Harness-CN-seed-0.1.5-rc.16.tar.zst'] },
        ]), { status: 200 })
      }
      return new Response(githubReleasesBody([
        { tag: 'v0.1.5-rc.17', assets: [wanted] },
        { tag: 'v0.1.5-rc.16', assets: ['Harness-CN-seed-0.1.5-rc.16.tar.zst'] },
      ]), { status: 200 })
    }) as typeof globalThis.fetch

    const found = await findPublishedAsset(fetchImpl, name => name === wanted)

    expect(found?.tag).toBe('v0.1.5-rc.17')
    expect(found?.asset.name).toBe(wanted)
  })

  it('prefers the newest release that publishes a matching file', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('gitee.com')) {
        return new Response(giteeReleasesBody([
          { tag: 'v0.1.5-rc.9', assets: ['Harness-CN-seed-0.1.5-rc.9.tar.zst'] },
          { tag: 'v0.1.5-rc.8', assets: ['Harness-CN-seed-0.1.5-rc.8.tar.zst'] },
        ]), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }) as typeof globalThis.fetch

    const found = await findPublishedAsset(fetchImpl, name => /Harness-CN-seed-.*\.tar\.zst$/u.test(name))

    expect(found?.tag).toBe('v0.1.5-rc.9')
  })

  it('answers nothing when no release carries the file', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => (
      String(input).includes('gitee.com')
        ? new Response(giteeReleasesBody([{ tag: 'v0.1.5-rc.9', assets: ['installer.exe'] }]), { status: 200 })
        : new Response('[]', { status: 200 })
    )) as typeof globalThis.fetch

    await expect(findPublishedAsset(fetchImpl, name => name === 'absent.tar.zst')).resolves.toBeUndefined()
  })
})
