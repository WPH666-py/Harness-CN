import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveLinkedProfile,
  archivePnpmStore,
  extractPnpmStoreArchives,
  materializeLinkedProfile,
  mergePnpmStore,
  removePnpmProjectRegistrations,
  SEED_PROFILE_LINK_MANIFEST,
  SEED_STORE_ARCHIVE_DIR,
  SEED_STORE_ARCHIVE_MANIFEST,
} from '../src/seed-store.ts'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-store-'))
  temporaryRoots.push(root)
  return root
}

function archiveBytes(seed: string): readonly { path: string; body: Buffer }[] {
  return [SEED_STORE_ARCHIVE_MANIFEST, ...readdirSync(join(seed, SEED_STORE_ARCHIVE_DIR))]
    .map(path => ({
      path,
      body: readFileSync(path === SEED_STORE_ARCHIVE_MANIFEST
        ? join(seed, path)
        : join(seed, SEED_STORE_ARCHIVE_DIR, path)),
    }))
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop seed store cleanup', () => {
  it('removes project registrations without removing package data', () => {
    const storeRoot = temporaryRoot()
    mkdirSync(join(storeRoot, 'v11', 'projects', 'temporary-project'), { recursive: true })
    mkdirSync(join(storeRoot, 'v12', 'projects'), { recursive: true })
    mkdirSync(join(storeRoot, 'metadata', 'projects'), { recursive: true })
    writeFileSync(join(storeRoot, 'v11', 'package-data'), 'package')

    removePnpmProjectRegistrations(storeRoot)

    expect(existsSync(join(storeRoot, 'v11', 'projects'))).toBe(false)
    expect(existsSync(join(storeRoot, 'v12', 'projects'))).toBe(false)
    expect(existsSync(join(storeRoot, 'v11', 'package-data'))).toBe(true)
    expect(existsSync(join(storeRoot, 'metadata', 'projects'))).toBe(true)
  })
})

describe('desktop seed store merge', () => {
  it('adds the store entries one tree is missing and leaves the entries it already holds', { timeout: 30_000 }, async () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    for (const store of [source, destination]) {
      mkdirSync(join(store, 'v11', 'files'), { recursive: true })
      const database = new DatabaseSync(join(store, 'v11', 'index.db'))
      database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
      const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
      if (store === source) {
        insert.run('seed-only', Buffer.from('seed'))
        insert.run('shared', Buffer.from('new'))
      } else {
        insert.run('plugin-only', Buffer.from('plugin'))
        insert.run('shared', Buffer.from('old'))
      }
      database.close()
    }
    // Different bytes carry different content-addressed names, so a package the seed changed
    // arrives at a new path and never rewrites the entry the store already holds.
    writeFileSync(join(source, 'v11', 'files', 'shared-new'), 'new')
    writeFileSync(join(destination, 'v11', 'files', 'shared-old'), 'old')
    writeFileSync(join(destination, 'v11', 'files', 'plugin'), 'plugin')

    await mergePnpmStore(source, destination)

    const database = new DatabaseSync(join(destination, 'v11', 'index.db'), { readOnly: true })
    const records = database.prepare('SELECT key, data FROM package_index ORDER BY key').all() as {
      key: string
      data: Uint8Array
    }[]
    database.close()
    expect(records.map(record => [record.key, Buffer.from(record.data).toString()])).toEqual([
      ['plugin-only', 'plugin'],
      ['seed-only', 'seed'],
      ['shared', 'new'],
    ])
    expect(readFileSync(join(destination, 'v11', 'files', 'shared-new'), 'utf8')).toBe('new')
    expect(readFileSync(join(destination, 'v11', 'files', 'shared-old'), 'utf8')).toBe('old')
    expect(readFileSync(join(destination, 'v11', 'files', 'plugin'), 'utf8')).toBe('plugin')
  })

  it('publishes a store that does not exist yet by moving the verified extraction', async () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const destination = join(root, 'pnpm', 'store')
    mkdirSync(join(source, 'v11', 'files'), { recursive: true })
    writeFileSync(join(source, 'v11', 'files', 'package'), 'package')

    await mergePnpmStore(source, destination)

    expect(readFileSync(join(destination, 'v11', 'files', 'package'), 'utf8')).toBe('package')
    expect(existsSync(source)).toBe(false)
  })
})

describe('desktop linked profile', () => {
  /** Store-relative path pnpm gives a file with these bytes. */
  function storePathFor(version: string, body: string): string {
    const digest = createHash('sha512').update(body).digest('hex')
    return `${version}/files/${digest.slice(0, 2)}/${digest.slice(2)}`
  }

  /** One store entry a profile links to, one generated profile file, and their directories. */
  function linkedProfileFixture(root: string): { seed: string; store: string; profile: string } {
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    const seed = join(root, 'seed')
    mkdirSync(join(store, 'v11', 'files'), { recursive: true })
    mkdirSync(join(profile, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(profile, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(seed, { recursive: true })
    // The store names each entry after its own content, and the installed tree links to those
    // entries; anything the install generated itself has no entry and ships verbatim.
    for (const body of ['alpha', 'bravo']) {
      const storePath = storePathFor('v11', body)
      mkdirSync(join(store, ...storePath.split('/').slice(0, -1)), { recursive: true })
      writeFileSync(join(store, ...storePath.split('/')), body)
    }
    linkSync(join(store, ...storePathFor('v11', 'alpha').split('/')), join(profile, 'node_modules', 'pkg', 'index.js'))
    linkSync(join(store, ...storePathFor('v11', 'bravo').split('/')), join(profile, 'node_modules', 'pkg', 'helper.js'))
    writeFileSync(join(profile, 'node_modules', '.bin', 'pkg'), 'shim')
    return { seed, store, profile }
  }

  it('records store links plus the remainder and rebuilds the tree from both', async () => {
    const root = temporaryRoot()
    const { seed, store, profile } = linkedProfileFixture(root)

    const summary = archiveLinkedProfile(seed, store, profile)

    expect(summary.linkedFiles).toBe(2)
    expect(summary.archivedFiles).toBe(1)
    const manifest = JSON.parse(readFileSync(join(seed, SEED_PROFILE_LINK_MANIFEST), 'utf8')) as {
      links: Record<string, string>
    }
    expect(Object.keys(manifest.links).sort()).toEqual([
      'node_modules/pkg/helper.js',
      'node_modules/pkg/index.js',
    ])
    expect(manifest.links['node_modules/pkg/index.js']).toBe(storePathFor('v11', 'alpha'))

    rmSync(profile, { recursive: true, force: true })
    const rebuilt = join(root, 'rebuilt')
    mkdirSync(rebuilt, { recursive: true })
    await materializeLinkedProfile(seed, rebuilt, store, rebuilt)

    expect(readFileSync(join(rebuilt, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('alpha')
    expect(readFileSync(join(rebuilt, 'node_modules', '.bin', 'pkg'), 'utf8')).toBe('shim')
    // The rebuilt file is the store's own entry, so one copy of the bytes serves both trees.
    expect(statSync(join(rebuilt, 'node_modules', 'pkg', 'index.js')).ino)
      .toBe(statSync(join(store, ...storePathFor('v11', 'alpha').split('/'))).ino)
  })

  it('points a rebuilt tree at the store and profile it is installed under', async () => {
    const root = temporaryRoot()
    const store = join(root, 'store')
    const profile = join(root, 'profile')
    const seed = join(root, 'seed')
    mkdirSync(join(store, 'v11', 'files'), { recursive: true })
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    mkdirSync(seed, { recursive: true })
    const storePath = storePathFor('v11', 'alpha')
    mkdirSync(join(store, ...storePath.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(store, ...storePath.split('/')), 'alpha')
    linkSync(join(store, ...storePath.split('/')), join(profile, 'node_modules', 'linked.js'))
    // What a seed-side install records: the build-time store and the temporary directory.
    writeFileSync(join(profile, 'node_modules', '.modules.yaml'), [
      '"layoutVersion": 5,',
      '"nodeLinker": "hoisted",',
      '"storeDir": "C:\\\\Temp\\\\build-store\\\\v11",',
      '"virtualStoreDir": "C:\\\\Temp\\\\staging\\\\profile\\\\node_modules\\\\.pnpm",',
      '',
    ].join('\n'))
    archiveLinkedProfile(seed, store, profile)

    const rebuilt = join(root, 'rebuilt')
    const installed = join(root, 'installed')
    mkdirSync(rebuilt, { recursive: true })
    await materializeLinkedProfile(seed, rebuilt, store, installed)

    const modules = readFileSync(join(rebuilt, 'node_modules', '.modules.yaml'), 'utf8')
    expect(modules).toContain(`"storeDir": ${JSON.stringify(join(store, 'v11'))}`)
    expect(modules).toContain(`"virtualStoreDir": ${JSON.stringify(join(installed, 'node_modules', '.pnpm'))}`)
    expect(modules).not.toContain('build-store')
  })

  it('rejects a manifest whose link escapes the profile directory', async () => {
    const root = temporaryRoot()
    const { seed, store } = linkedProfileFixture(root)
    archiveLinkedProfile(seed, store, join(root, 'profile'))
    writeFileSync(join(seed, SEED_PROFILE_LINK_MANIFEST), `${JSON.stringify({
      schemaVersion: 1,
      links: { '../escape': 'v11/files/a' },
    })}\n`)

    await expect(materializeLinkedProfile(seed, join(root, 'rebuilt'), store, join(root, 'rebuilt')))
      .rejects.toThrow(/unsafe pnpm store archive path/u)
  })

  it('rejects a link whose store file is not in the published store', async () => {
    const root = temporaryRoot()
    const { seed, store } = linkedProfileFixture(root)
    archiveLinkedProfile(seed, store, join(root, 'profile'))
    rmSync(join(store, ...storePathFor('v11', 'alpha').split('/')))
    const rebuilt = join(root, 'rebuilt')
    mkdirSync(rebuilt, { recursive: true })

    await expect(materializeLinkedProfile(seed, rebuilt, store, rebuilt))
      .rejects.toThrow(/targets a missing store file/u)
  })
})

describe('desktop seed store archives', () => {
  it('extracts package bytes and executable modes without retaining loose seed files', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const store = join(seed, 'store')
    const executable = join(store, 'v10', 'files', 'native-addon')
    mkdirSync(join(store, 'v10', 'files'), { recursive: true })
    writeFileSync(executable, 'native')
    chmodSync(executable, 0o755)
    writeFileSync(join(store, 'v10', 'files', 'package-data'), 'package')

    archivePnpmStore(seed, store)
    const destination = join(root, 'extracted')
    await extractPnpmStoreArchives(seed, destination)

    expect(existsSync(store)).toBe(false)
    expect(readFileSync(join(destination, 'v10', 'files', 'package-data'), 'utf8')).toBe('package')
    if (process.platform !== 'win32') {
      expect(statSync(join(destination, 'v10', 'files', 'native-addon')).mode & 0o111).toBe(0o111)
    }
  })

  it('produces identical shards for identical paths, bytes, and modes', () => {
    const root = temporaryRoot()
    const seeds = [join(root, 'first'), join(root, 'second')]
    for (const [index, seed] of seeds.entries()) {
      const store = join(seed, 'store')
      mkdirSync(join(store, 'nested'), { recursive: true })
      const paths = index === 0 ? ['alpha', 'nested/beta'] : ['nested/beta', 'alpha']
      for (const path of paths) {
        const target = join(store, path)
        writeFileSync(target, path)
        utimesSync(target, new Date(index * 10_000), new Date(index * 20_000))
      }
      archivePnpmStore(seed, store)
    }

    const first = archiveBytes(seeds[0] as string)
    const second = archiveBytes(seeds[1] as string)
    expect(second.map(entry => entry.path)).toEqual(first.map(entry => entry.path))
    expect(second.map(entry => entry.body)).toEqual(first.map(entry => entry.body))
  })

  it('rejects an archive entry that is not a file while extracting it', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const store = join(root, 'store')
    mkdirSync(join(store, 'v10'), { recursive: true })
    writeFileSync(join(store, 'v10', 'package-data'), 'package')
    mkdirSync(join(seed, SEED_STORE_ARCHIVE_DIR), { recursive: true })
    // A directory entry is what a store archived without `noDirRecurse` would carry; the
    // extraction pass has to refuse it rather than create a directory the store never had.
    create({
      cwd: store,
      file: join(seed, SEED_STORE_ARCHIVE_DIR, 'store-00.tar'),
      noMtime: true,
      portable: true,
      sync: true,
    }, ['.'])
    writeFileSync(join(seed, SEED_STORE_ARCHIVE_MANIFEST), `${JSON.stringify({
      schemaVersion: 1,
      shardCount: 16,
      archives: [{ file: 'store-00.tar', entries: 1 }],
    })}\n`)

    await expect(extractPnpmStoreArchives(seed, join(root, 'extracted')))
      .rejects.toThrow(/unsupported pnpm store archive entry type/u)
  })

  it('rejects an archive whose entry count differs from the manifest', async () => {
    const root = temporaryRoot()
    const seed = join(root, 'seed')
    const store = join(seed, 'store')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'package-data'), 'package')
    archivePnpmStore(seed, store)
    const manifestPath = join(seed, SEED_STORE_ARCHIVE_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      archives: { entries: number }[]
    }
    const archive = manifest.archives[0]
    if (archive === undefined) throw new Error('test seed has no archive')
    archive.entries += 1
    writeFileSync(manifestPath, JSON.stringify(manifest))

    await expect(extractPnpmStoreArchives(seed, join(root, 'extracted'))).rejects.toThrow(/unexpected entry count/u)
  })
})
