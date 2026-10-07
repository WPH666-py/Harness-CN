/**
 * The remote provider's path-changing operations: create, remove, copy, and
 * move, including the cross-device move fallback that a single remote
 * filesystem cannot otherwise reach. The sandbox is the fake in the sibling
 * spec, so both suites exercise the same controller surface.
 */
import { posix } from 'node:path'
import { FileType, type EntryInfo } from '@deepseek-ai/dsh-e2b'
import { describe, expect, it } from 'vitest'
import { FakeRemote } from './fake-remote.ts'
import { expectCode, setup } from './harness.ts'

describe('E2BFileSystem.createDirectory', () => {
  it('creates one directory under an existing parent and reports its version', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    const outcome = await fs.createDirectory(await fs.resolve('src'))
    expect(outcome.type).toBe('directory')
    expect(outcome.target.displayPath).toBe('/workspace/src')
    expect(typeof outcome.version).toBe('string')
    expect(remote.nodes.get('/workspace/src')?.type).toBe(FileType.DIR)
  })

  it('creates missing ancestors with recursive', async () => {
    const { fs } = await setup()
    const outcome = await fs.createDirectory(await fs.resolve('a/b/c'), { recursive: true })
    expect(outcome.type).toBe('directory')
  })

  it('treats an existing directory as a success only with recursive', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    const { fs } = await setup(remote)
    await expectCode(fs.createDirectory(await fs.resolve('src')), 'FS_ALREADY_EXISTS')
    const recursive = await fs.createDirectory(await fs.resolve('src'), { recursive: true })
    expect(recursive.type).toBe('directory')
  })

  it('refuses a file at the target, with and without recursive', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/notes.txt', 'x')
    const { fs } = await setup(remote)
    await expectCode(fs.createDirectory(await fs.resolve('notes.txt')), 'FS_ALREADY_EXISTS')
    await expectCode(fs.createDirectory(await fs.resolve('notes.txt'), { recursive: true }), 'FS_ALREADY_EXISTS')
    expect(remote.nodes.get('/workspace/notes.txt')?.type).toBe(FileType.FILE)
  })

  it('refuses a missing parent without recursive', async () => {
    const { fs } = await setup()
    await expectCode(fs.createDirectory(await fs.resolve('missing/child')), 'FS_NOT_FOUND')
  })
})

describe('E2BFileSystem.createFile', () => {
  it('creates an empty regular file', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    const outcome = await fs.createFile(await fs.resolve('new.txt'))
    expect(outcome.type).toBe('file')
    expect(remote.nodes.get('/workspace/new.txt')?.data.byteLength).toBe(0)
  })

  it('refuses any entry already at the target', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/notes.txt', 'keep')
    remote.dir('/workspace/src')
    const { fs } = await setup(remote)
    await expectCode(fs.createFile(await fs.resolve('notes.txt')), 'FS_ALREADY_EXISTS')
    await expectCode(fs.createFile(await fs.resolve('src')), 'FS_ALREADY_EXISTS')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/notes.txt')?.data)).toBe('keep')
  })

  it('refuses a missing parent directory', async () => {
    const { fs } = await setup()
    await expectCode(fs.createFile(await fs.resolve('missing/new.txt')), 'FS_NOT_FOUND')
  })
})

describe('E2BFileSystem.remove', () => {
  it('removes a regular file', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'x')
    const { fs } = await setup(remote)
    expect(await fs.remove(await fs.resolve('a.txt'))).toEqual({ type: 'file' })
    expect(remote.nodes.has('/workspace/a.txt')).toBe(false)
  })

  it('removes an empty directory without recursive', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/empty')
    const { fs } = await setup(remote)
    expect(await fs.remove(await fs.resolve('empty'))).toEqual({ type: 'directory' })
    expect(remote.nodes.has('/workspace/empty')).toBe(false)
  })

  it('refuses a non-empty directory without recursive and removes nothing', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    remote.file('/workspace/src/a.txt', 'x')
    const { fs } = await setup(remote)
    await expectCode(fs.remove(await fs.resolve('src')), 'FS_NOT_EMPTY')
    expect(remote.nodes.has('/workspace/src/a.txt')).toBe(true)
    expect(remote.removals).toEqual([])
  })

  it('removes a whole subtree with recursive', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src/nested')
    remote.file('/workspace/src/nested/a.txt', 'x')
    const { fs } = await setup(remote)
    expect(await fs.remove(await fs.resolve('src'), { recursive: true })).toEqual({ type: 'directory' })
    expect(remote.nodes.has('/workspace/src/nested/a.txt')).toBe(false)
  })

  it('reports a missing target as not found', async () => {
    const { fs } = await setup()
    await expectCode(fs.remove(await fs.resolve('nope')), 'FS_NOT_FOUND')
  })
})

describe('E2BFileSystem.copy', () => {
  it('copies a regular file and leaves the source', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'content')
    const { fs } = await setup(remote)
    const outcome = await fs.copy(await fs.resolve('a.txt'), await fs.resolve('b.txt'))
    expect(outcome).toMatchObject({ type: 'file' })
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/b.txt')?.data)).toBe('content')
    expect(remote.nodes.has('/workspace/a.txt')).toBe(true)
  })

  it('copies a directory subtree, nesting included', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src/nested')
    remote.file('/workspace/src/nested/a.txt', 'a')
    remote.file('/workspace/src/top.txt', 't')
    const { fs } = await setup(remote)
    const outcome = await fs.copy(await fs.resolve('src'), await fs.resolve('src-copy'))
    expect(outcome.type).toBe('directory')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/src-copy/nested/a.txt')?.data)).toBe('a')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/src-copy/top.txt')?.data)).toBe('t')
    expect(remote.nodes.has('/workspace/src/nested/a.txt')).toBe(true)
  })

  it('reproduces a link through the shell instead of following it', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    remote.file('/workspace/outside.txt', 'secret')
    remote.symlink('/workspace/src/link.txt', '/workspace/outside.txt')
    const { fs } = await setup(remote)
    await fs.copy(await fs.resolve('src'), await fs.resolve('src-copy'))
    expect(remote.commands).toContain("ln -s -- '/workspace/outside.txt' '/workspace/src-copy/link.txt'")
  })

  it('refuses an existing destination', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'source')
    remote.file('/workspace/b.txt', 'destination')
    const { fs } = await setup(remote)
    await expectCode(fs.copy(await fs.resolve('a.txt'), await fs.resolve('b.txt')), 'FS_ALREADY_EXISTS')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/b.txt')?.data)).toBe('destination')
  })

  it('reports a missing source as not found', async () => {
    const { fs } = await setup()
    await expectCode(fs.copy(await fs.resolve('nope.txt'), await fs.resolve('dst.txt')), 'FS_NOT_FOUND')
  })
})

describe('E2BFileSystem.move', () => {
  it('renames through the controller and leaves nothing at the source', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'content')
    const { fs } = await setup(remote)
    const outcome = await fs.move(await fs.resolve('a.txt'), await fs.resolve('b.txt'))
    expect(outcome).toMatchObject({ type: 'file' })
    expect(remote.renames).toEqual([{ from: '/workspace/a.txt', to: '/workspace/b.txt' }])
    expect(remote.nodes.has('/workspace/a.txt')).toBe(false)
  })

  it('reports a moved directory as a directory', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    const { fs } = await setup(remote)
    const outcome = await fs.move(await fs.resolve('src'), await fs.resolve('dst'))
    expect(outcome.type).toBe('directory')
  })

  it('refuses an existing destination, moving nothing', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'source')
    remote.file('/workspace/b.txt', 'destination')
    const { fs } = await setup(remote)
    await expectCode(fs.move(await fs.resolve('a.txt'), await fs.resolve('b.txt')), 'FS_ALREADY_EXISTS')
    expect(remote.renames).toEqual([])
    expect(remote.nodes.has('/workspace/a.txt')).toBe(true)
  })

  it('reports a missing source as not found', async () => {
    const { fs } = await setup()
    await expectCode(fs.move(await fs.resolve('nope.txt'), await fs.resolve('dst.txt')), 'FS_NOT_FOUND')
  })

  it('falls back to copy-then-remove across remote filesystems', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    remote.file('/workspace/src/a.txt', 'a')
    remote.nextRenameError = new Error('EXDEV: invalid cross-device link')
    const { fs } = await setup(remote)
    const outcome = await fs.move(await fs.resolve('src'), await fs.resolve('dst'))
    expect(outcome.type).toBe('directory')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/dst/a.txt')?.data)).toBe('a')
    expect(remote.nodes.has('/workspace/src/a.txt')).toBe(false)
    expect(remote.removals).toContain('/workspace/src')
  })

  it('leaves the source in place when the rename fails for another reason', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'x')
    remote.nextRenameError = new Error('permission denied')
    const { fs } = await setup(remote)
    await expectCode(fs.move(await fs.resolve('a.txt'), await fs.resolve('b.txt')), 'FS_PERMISSION_DENIED')
    expect(remote.nodes.has('/workspace/a.txt')).toBe(true)
    expect(remote.nodes.has('/workspace/b.txt')).toBe(false)
  })

  it('leaves the destination and the source when the fallback copy cannot complete', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a.txt', 'x')
    remote.nextRenameError = new Error('EXDEV: invalid cross-device link')
    remote.nextReadError = new Error('read failed')
    const { fs } = await setup(remote)
    await expectCode(fs.move(await fs.resolve('a.txt'), await fs.resolve('b.txt')), 'FS_IO_ERROR')
    expect(remote.nodes.has('/workspace/a.txt')).toBe(true)
    expect(remote.removals).toEqual([])
  })
})

describe('E2BFileSystem — the alias the copy reports', () => {
  it('reports the destination kind from the entry it committed', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/src')
    await setup(remote)
    const entries: EntryInfo[] = await remote.sandbox.files.list('/workspace', { depth: 1 })
    expect(entries.map(entry => posix.basename(entry.path))).toContain('src')
  })
})
