/**
 * Behavior of the first launch's offline package: where it is looked for, and how it is obtained.
 *
 * The seed is ~300 MB, so these cases exercise the decision rather than the bytes: which sources
 * are consulted and in what order, whether a file the user placed by hand is used, and which
 * release an archive is taken from. `tar` is mocked to copy a prepared tree, which keeps the
 * extraction path under test without unpacking a real archive into the case's temporary directory.
 *
 * The second half of the file covers the state a launch can be handed rather than the order it
 * prefers: a directory an interrupted run left behind, one that cannot be deleted at all, and two
 * runs that overlap. Each of those once failed a first launch outright, so each is a case here.
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Directory the mocked unpacker copies from; set by each case that unpacks an archive. */
const unpackSource = vi.hoisted(() => ({ current: '' }))

/**
 * Refusals the cases below inject into one filesystem call.
 *
 * A leftover directory that Windows will not delete is the whole subject of these cases, and the
 * only way to reach that state deterministically is to make the deletion say so. The predicate is
 * consulted per call so a single seam can fail once, fail always, or fail for one directory only.
 */
const removalRefusals = vi.hoisted(() => ({
  block: undefined as
    | undefined
    | ((operation: 'rm' | 'rename', path: string) => NodeJS.ErrnoException | undefined),
}))

/**
 * A gate every unpacking pass waits at, when a case needs two runs to overlap on purpose.
 *
 * The interesting overlap is "both runs are past their own setup and neither has published yet".
 * Nothing in the code produces that on demand, so the unpacker's completion is held until the case
 * says otherwise; the passes still write into their own staging directories while they wait.
 */
const unpackGate = vi.hoisted(() => ({
  gate: undefined as undefined | Promise<void>,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const refuse = (path: unknown, operation: 'rm' | 'rename'): void => {
    const failure = removalRefusals.block?.(operation, String(path))
    if (failure !== undefined) throw failure
  }
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      refuse(path, 'rm')
      return actual.rm(path, options)
    },
    // Replacing a destination begins with moving it aside, so a destination that is held open is
    // a refused rename rather than a refused deletion; both are the same fault to the code above.
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      refuse(from, 'rename')
      return actual.rename(from, to)
    },
  }
})

vi.mock('tar', async () => {
  const { cpSync, readdirSync } = await import('node:fs')
  const { Writable } = await import('node:stream')
  return {
    // The real `extract` is a writable stream the decompressed archive flows into. These cases only
    // need the resulting tree, so the prepared directory is copied when that stream ends, which is
    // when the real unpacker has written its last entry; the filter and the inventory check around
    // it run exactly as they do in production. The copy happens inside `final`, so a case that holds
    // the gate keeps the whole extraction — not merely its completion event — waiting.
    extract: (options: { cwd: string; filter: (path: string) => boolean }) => new Writable({
      write(_chunk, _encoding, callback) { callback() },
      final(callback) {
        void (async () => {
          await unpackGate.gate
          const source = unpackSource.current
          for (const entry of readdirSync(source)) {
            options.filter(entry)
            cpSync(join(source, entry), join(options.cwd, entry), { recursive: true })
          }
          callback()
        })()
      },
    }),
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

/**
 * The state an interrupted or overlapping run leaves in the seed cache.
 *
 * Every case here starts from the same premise: the directory the extraction wants does not belong
 * to this run. Deletion is therefore not something any of these paths may depend on.
 */
describe('desktop offline seed: leftovers of a run that did not finish', () => {
  /** Temporary root standing in for `~/.dsh/desktop`. */
  let cacheRoot: string
  /** Temporary directory standing in for the installer's own resources. */
  let resourceDir: string
  /** Temporary root both of the above live under. */
  let root: string
  /** One env for a case that would otherwise reach a host. */
  const noHost = (async () => { throw new Error('no host may be asked') }) as unknown as typeof globalThis.fetch

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-cn-seed-leftover-'))
    cacheRoot = join(root, 'desktop')
    resourceDir = join(root, 'resources')
    await mkdir(cacheRoot, { recursive: true })
    await mkdir(resourceDir, { recursive: true })
  })

  afterEach(async () => {
    removalRefusals.block = undefined
    unpackGate.gate = undefined
    unpackSource.current = ''
    await (await import('node:fs/promises')).rm(root, { recursive: true, force: true })
  })

  /**
   * Leave an archive in the download directory under this version's gzip name.
   * @param version - release version the archive belongs to.
   */
  async function stageArchive(version: string): Promise<void> {
    const downloads = join(cacheRoot, 'downloads')
    await mkdir(downloads, { recursive: true })
    await writeSeedArchive(join(downloads, seedArchiveNames(version)[1] ?? ''))
  }

  /**
   * Wait until one of a directory's entries satisfies a predicate.
   * @param directory - directory to poll.
   * @param predicate - whether an entry is the wanted one.
   * @returns the entry that satisfied it, which the caller needs to tell one run's staging from another's.
   */
  async function waitForEntry(directory: string, predicate: (entry: string) => boolean): Promise<string> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const entries = await readdir(directory).catch(() => [] as string[])
      const found = entries.find(predicate)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`nothing matching appeared under ${directory}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('installs over a partial extraction left behind instead of failing on it', async () => {
    const version = '0.1.5-rc.20'
    const partial = join(cacheRoot, `seed-${version}.partial`)
    await mkdir(join(partial, 'desktop-packages'), { recursive: true })
    await writeFile(join(partial, 'desktop-packages', 'half-unpacked.tgz'), 'leftover')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    expect(seed.origin).toBe('manual')
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8')).toBe('{"files":[]}')
    // The leftover is gone from the name the next launch looks at, which is what makes this failure
    // a one-time event rather than the state every later launch starts from.
    expect(existsSync(partial)).toBe(false)
  })

  it('keeps going when the leftover cannot be deleted, and leaves the cache with one seed', async () => {
    const version = '0.1.5-rc.20'
    const partial = join(cacheRoot, `seed-${version}.partial`)
    await mkdir(join(partial, 'desktop-packages'), { recursive: true })
    await writeFile(join(partial, 'desktop-packages', 'half-unpacked.tgz'), 'held open')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)
    // The exact refusal the first launch died on: the directory is there, and emptying it is
    // refused. Nothing this run does may depend on that changing. Only deletion is refused — the
    // name it holds can still be freed by moving it aside, which is the whole point of doing that.
    removalRefusals.block = (operation, path) => {
      if (operation !== 'rm' || path !== partial) return undefined
      const refusal: NodeJS.ErrnoException = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`)
      refusal.code = 'ENOTEMPTY'
      return refusal
    }

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    expect(seed.origin).toBe('manual')
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8')).toBe('{"files":[]}')
    // The launch finished, and the directory it could not delete no longer holds a name anything
    // looks for. What remains is one complete seed and nothing else, which is the state a launch is
    // allowed to depend on: the leftover is never inspected, only worked around.
    expect(existsSync(partial)).toBe(false)
    const entries = await readdir(cacheRoot)
    expect(entries.sort()).toEqual(['downloads', `seed-${version}`])
  })

  it('never dies on a leftover it can neither delete nor move', async () => {
    const version = '0.1.5-rc.20'
    const partial = join(cacheRoot, `seed-${version}.partial`)
    await mkdir(join(partial, 'desktop-packages'), { recursive: true })
    await writeFile(join(partial, 'desktop-packages', 'half-unpacked.tgz'), 'held open')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)
    // The hardest state a machine can be in: something else holds the leftover, so it can neither be
    // emptied nor renamed. Every step this launch needs is in a name of its own, so the only correct
    // outcome is to say so and finish — a launch that cannot start because of debris it never wrote
    // is the failure this whole path exists to remove.
    removalRefusals.block = (_operation, path) => {
      if (path !== partial) return undefined
      const refusal: NodeJS.ErrnoException = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`)
      refusal.code = 'ENOTEMPTY'
      return refusal
    }
    const notes: string[] = []

    const seed = await ensureSeedPackage({
      version,
      resourceDir,
      cacheRoot,
      fetch: noHost,
      onProgress: note => notes.push(note),
    })

    expect(seed.origin).toBe('manual')
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8')).toBe('{"files":[]}')
    // Named in the run log rather than silently ignored: the space it costs is the user's, and the
    // next launch will try again.
    expect(notes.some(note => note.includes('无法删除也无法改名'))).toBe(true)
    expect(existsSync(join(partial, 'desktop-packages', 'half-unpacked.tgz'))).toBe(true)
  })

  it('gives up on the directory the second attempt of a deletion succeeds', async () => {
    const version = '0.1.5-rc.20'
    const partial = join(cacheRoot, `seed-${version}.partial`)
    await mkdir(join(partial, 'desktop-packages'), { recursive: true })
    await writeFile(join(partial, 'desktop-packages', 'half-unpacked.tgz'), 'leftover')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)
    let attempts = 0
    removalRefusals.block = (operation, path) => {
      if (operation !== 'rm' || path !== partial) return undefined
      attempts += 1
      if (attempts > 1) return undefined
      const refusal: NodeJS.ErrnoException = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`)
      refusal.code = 'ENOTEMPTY'
      return refusal
    }

    await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    // A refusal that is only the file being busy is waited out rather than worked around: the
    // ordinary case is a scanner letting go, and then nothing has to be set aside at all.
    expect(attempts).toBeGreaterThan(1)
    expect(existsSync(partial)).toBe(false)
    const entries = await readdir(cacheRoot)
    expect(entries.some(entry => entry.startsWith(`seed-${version}.stale-`))).toBe(false)
  })

  it('cleans up after a run that was killed, including seeds of other versions', async () => {
    const version = '0.1.5-rc.20'
    const oldPartial = join(cacheRoot, 'seed-0.1.5-rc.19.partial')
    const oldSeed = join(cacheRoot, 'seed-0.1.5-rc.19')
    await mkdir(oldPartial, { recursive: true })
    await rm(oldSeed, { recursive: true, force: true })
    await mkdir(oldSeed, { recursive: true })
    await writeFile(join(oldSeed, 'integrity.json'), '{"files":[]}')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    expect(seed.origin).toBe('manual')
    expect(existsSync(oldPartial)).toBe(false)
    // Another version's seed is what a downgrade would want; it is ~300 MB of nothing on a machine
    // that has moved on, and a launch that keeps every version it ever ran grows without bound.
    expect(existsSync(oldSeed)).toBe(false)
  })

  it('finishes the launch whose destination another run is holding', async () => {
    const version = '0.1.5-rc.20'
    const cached = join(cacheRoot, `seed-${version}`)
    // Not a seed: a run interrupted while unpacking left this name behind, and something is still
    // holding a file inside it. The launch has to replace it, not read it.
    await mkdir(join(cached, 'desktop-packages'), { recursive: true })
    await writeFile(join(cached, 'desktop-packages', 'half-unpacked.tgz'), 'held open by another process')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)
    // Moving the destination aside is what gets refused: renaming the directory renames the entry
    // inside it, and that is the step a held handle refuses. One held handle, seen from here.
    removalRefusals.block = (operation, path) => {
      if (operation !== 'rename' || path !== cached) return undefined
      const refusal: NodeJS.ErrnoException = new Error(`EPERM: operation not permitted, rename '${path}'`)
      refusal.code = 'EPERM'
      return refusal
    }

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    // The seed returned is the fresh one: a destination that cannot be replaced must not decide
    // whether this launch proceeds, only when the replacement becomes permanent.
    expect(seed.directory).not.toBe(cached)
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8')).toBe('{"files":[]}')
    // Both trees are kept, because each holds something the other does not: the fresh content and
    // the name. Neither is deleted while the other is unreachable, so the next launch still finds a
    // complete seed under the name it looks for and can replace it then.
    expect(existsSync(join(cached, 'desktop-packages', 'half-unpacked.tgz'))).toBe(true)
    expect(existsSync(join(seed.directory, 'runtime', 'node.exe'))).toBe(true)
  })

  it('leaves the directory another live run is unpacking into alone', async () => {
    const version = '0.1.5-rc.20'
    // This process is a run that is still working: the installer's prebuild and a launch can be
    // exactly this, one process each. A sweep must not be able to delete a sibling's half-written
    // tree, which is what a launch dying on a file that was there a moment ago looks like.
    const working = join(cacheRoot, `seed-${version}.partial-${String(process.pid)}-live-00000000`)
    // A run that was killed leaves the same shape behind with no process attached to it.
    const abandoned = join(cacheRoot, `seed-${version}.partial-2147483647-dead-00000000`)
    await mkdir(join(working, 'desktop-packages'), { recursive: true })
    await mkdir(join(abandoned, 'desktop-packages'), { recursive: true })
    await writeFile(join(working, 'desktop-packages', 'half-unpacked.tgz'), 'still being written')
    await writeFile(join(abandoned, 'desktop-packages', 'half-unpacked.tgz'), 'from a run that died')
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    expect(seed.origin).toBe('manual')
    expect(existsSync(join(working, 'desktop-packages', 'half-unpacked.tgz'))).toBe(true)
    // The debris a sweep exists for is still swept: a run that is gone cannot come back for it.
    expect(existsSync(abandoned)).toBe(false)
  })

  it('installs from the seed another run published when its own tree is taken away', async () => {
    const version = '0.1.5-rc.20'
    const destination = join(cacheRoot, `seed-${version}`)
    await stageArchive(version)
    unpackSource.current = await prepareSeedTree(root)
    // A sweep by an older build, or a cleaner in the temp directory, can delete this run's tree
    // between unpacking it and publishing it. The other run has published a complete seed by then.
    removalRefusals.block = (operation, path) => {
      if (operation !== 'rename' || !path.includes('.partial-')) return undefined
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'integrity.json'), '{"files":["published-by-the-other-run"]}')
      const refusal: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, rename '${path}'`)
      refusal.code = 'ENOENT'
      return refusal
    }

    const seed = await ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })

    expect(seed.directory).toBe(destination)
    expect(await readFile(join(seed.directory, 'integrity.json'), 'utf8'))
      .toBe('{"files":["published-by-the-other-run"]}')
    // Nothing of this run's own attempt is left behind: the tree it was holding is gone, and the
    // run installed from the one that is there.
    expect((await readdir(cacheRoot)).filter(entry => entry.includes('.partial-'))).toEqual([])
  })

  it('never lets two overlapping runs take each other’s half-written tree', async () => {
    const version = '0.1.5-rc.20'
    await stageArchive(version)
    const first = await prepareSeedTree(join(root, 'first'))
    const second = await prepareSeedTree(join(root, 'second'))
    await writeFile(join(first, 'integrity.json'), '{"files":["first"]}')
    await writeFile(join(second, 'integrity.json'), '{"files":["second"]}')
    // Both runs unpack, and neither publishes, until the case lets them. That is the overlap the
    // installer's prebuild and a launch can actually produce on one machine.
    let release = (): void => undefined
    unpackGate.gate = new Promise<void>((resolve) => { release = resolve })

    unpackSource.current = first
    const firstRun = ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })
    const firstStaging = await waitForEntry(cacheRoot, entry => entry.includes('.partial-'))
    unpackSource.current = second
    const secondRun = ensureSeedPackage({ version, resourceDir, cacheRoot, fetch: noHost })
    await waitForEntry(cacheRoot, entry => entry.includes('.partial-') && entry !== firstStaging)
    release()
    const [a, b] = await Promise.all([firstRun, secondRun])

    // Neither run reported the other's directory as debris, so neither deleted it: the staging name
    // a run works in is its own. Both runs then finished, and the published directory is one of the
    // two complete trees rather than a mixture of them.
    expect(await readFile(join(a.directory, 'integrity.json'), 'utf8')).toMatch(/\{"files":\["(?:first|second)"\]\}/u)
    expect(await readFile(join(b.directory, 'integrity.json'), 'utf8')).toMatch(/\{"files":\["(?:first|second)"\]\}/u)
    const published = join(cacheRoot, `seed-${version}`)
    expect(await readFile(join(published, 'integrity.json'), 'utf8')).toMatch(/\{"files":\["(?:first|second)"\]\}/u)
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
