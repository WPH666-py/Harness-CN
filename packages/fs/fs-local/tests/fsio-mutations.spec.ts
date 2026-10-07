/**
 * Cordis-free tests for the path-changing local-filesystem operations: create a
 * directory or an empty file, remove, copy a subtree, and move (including the
 * cross-device fallback, driven through the rename seam because a second
 * mounted filesystem is not available to a unit test). Symbolic links are
 * exercised through entries the fixtures materialize on the platform that
 * supports them; no test creates one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyPath, createDirectory, createFile, movePath, removePath } from '../src/fsio.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fsio-mutate-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Every path below `root`, POSIX-joined, for whole-tree assertions. */
async function tree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    paths.push(relative)
    if (entry.isDirectory()) paths.push(...await tree(join(root, entry.name), relative))
  }
  return paths.sort()
}

describe('createDirectory', () => {
  it('creates exactly one directory', async () => {
    const path = join(dir, 'one')
    const outcome = await createDirectory(path, undefined)
    expect(outcome.type).toBe('directory')
    expect(outcome.target.displayPath).toBe(path)
    expect(typeof outcome.version).toBe('string')
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it('refuses a missing parent without recursive, and creates the chain with it', async () => {
    const deep = join(dir, 'a', 'b', 'c')
    await expect(createDirectory(deep, undefined)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(stat(join(dir, 'a'))).rejects.toMatchObject({ code: 'ENOENT' })

    const outcome = await createDirectory(deep, { recursive: true })
    expect(outcome.type).toBe('directory')
    expect((await stat(deep)).isDirectory()).toBe(true)
  })

  it('reports an existing directory as a success only when recursive', async () => {
    const path = join(dir, 'existing')
    await mkdir(path)
    await expect(createDirectory(path, undefined)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })

    const recursive = await createDirectory(path, { recursive: true })
    expect(recursive.type).toBe('directory')
    expect(recursive.target.displayPath).toBe(path)
  })

  it('refuses a file at the target under both recursive and non-recursive', async () => {
    const path = join(dir, 'file.txt')
    await writeFile(path, 'x')
    await expect(createDirectory(path, undefined)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    await expect(createDirectory(path, { recursive: true })).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect(await readFile(path, 'utf8')).toBe('x')
  })

  it('refuses a parent that is a regular file', async () => {
    const parent = join(dir, 'parent.txt')
    await writeFile(parent, 'x')
    await expect(createDirectory(join(parent, 'child'), undefined)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('honors a pre-aborted signal without creating anything', async () => {
    const path = join(dir, 'aborted')
    await expect(createDirectory(path, undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('createFile', () => {
  it('creates an empty regular file and reports its version', async () => {
    const path = join(dir, 'new.txt')
    const outcome = await createFile(path)
    expect(outcome.type).toBe('file')
    expect(await readFile(path, 'utf8')).toBe('')
    expect(typeof outcome.version).toBe('string')
  })

  it('refuses any entry already at the target, including a directory and a dangling link', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'keep')
    await expect(createFile(file)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect(await readFile(file, 'utf8')).toBe('keep')

    const directory = join(dir, 'a-directory')
    await mkdir(directory)
    await expect(createFile(directory)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
  })

  it('refuses a missing parent directory', async () => {
    await expect(createFile(join(dir, 'missing', 'a.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('honors a pre-aborted signal without creating anything', async () => {
    const path = join(dir, 'aborted.txt')
    await expect(createFile(path, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('removePath', () => {
  it('removes a regular file', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, 'x')
    expect(await removePath(path, undefined)).toEqual({ type: 'file' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes an empty directory without recursive', async () => {
    const path = join(dir, 'empty')
    await mkdir(path)
    expect(await removePath(path, undefined)).toEqual({ type: 'directory' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a non-empty directory without recursive and leaves it intact', async () => {
    const path = join(dir, 'full')
    await mkdir(path)
    await writeFile(join(path, 'child.txt'), 'x')
    await expect(removePath(path, undefined)).rejects.toMatchObject({ code: 'FS_NOT_EMPTY' })
    expect(await readFile(join(path, 'child.txt'), 'utf8')).toBe('x')
  })

  it('removes a whole subtree with recursive', async () => {
    const path = join(dir, 'full')
    await mkdir(join(path, 'nested'), { recursive: true })
    await writeFile(join(path, 'nested', 'deep.txt'), 'x')
    await writeFile(join(path, 'top.txt'), 'y')
    expect(await removePath(path, { recursive: true })).toEqual({ type: 'directory' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a missing target as not found', async () => {
    await expect(removePath(join(dir, 'nope'), undefined)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('refuses a symbolic link rather than unlinking it', async () => {
    const real = join(dir, 'real.txt')
    await writeFile(real, 'x')
    await mkdir(join(dir, 'links'))
    // The link is created by the fixture only where the platform allows it.
    const link = join(dir, 'links', 'to-real.txt')
    if (!(await linkOrSkip(real, link))) return
    await expect(removePath(link, undefined)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('honors a pre-aborted signal without removing anything', async () => {
    const path = join(dir, 'keep.txt')
    await writeFile(path, 'x')
    await expect(removePath(path, undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await readFile(path, 'utf8')).toBe('x')
  })
})

describe('copyPath', () => {
  it('copies a file, byte for byte, and leaves the source in place', async () => {
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    await writeFile(from, 'content')
    const outcome = await copyPath(from, to)
    expect(outcome).toMatchObject({ type: 'file' })
    expect(outcome.target.displayPath).toBe(to)
    expect(await readFile(to, 'utf8')).toBe('content')
    expect(await readFile(from, 'utf8')).toBe('content')
  })

  it('copies a payload that is not valid UTF-8 verbatim', async () => {
    const from = join(dir, 'a.bin')
    const to = join(dir, 'b.bin')
    const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80])
    await writeFile(from, payload)
    await copyPath(from, to)
    expect(await readFile(to)).toEqual(payload)
  })

  it('copies a whole directory subtree, nesting included', async () => {
    const from = join(dir, 'src')
    await mkdir(join(from, 'nested', 'deeper'), { recursive: true })
    await writeFile(join(from, 'a.txt'), 'a')
    await writeFile(join(from, 'nested', 'b.txt'), 'b')
    await writeFile(join(from, 'nested', 'deeper', 'c.txt'), 'c')

    const outcome = await copyPath(from, join(dir, 'dst'))
    expect(outcome.type).toBe('directory')
    expect(await tree(join(dir, 'dst'))).toEqual(['a.txt', 'nested', 'nested/b.txt', 'nested/deeper', 'nested/deeper/c.txt'])
    expect(await readFile(join(dir, 'dst', 'nested', 'deeper', 'c.txt'), 'utf8')).toBe('c')
    expect(await tree(from)).toEqual(['a.txt', 'nested', 'nested/b.txt', 'nested/deeper', 'nested/deeper/c.txt'])
  })

  it('reproduces a link inside the copied subtree instead of following it', async () => {
    const from = join(dir, 'src')
    const outside = join(dir, 'outside.txt')
    await mkdir(from)
    await writeFile(outside, 'secret')
    const link = join(from, 'link.txt')
    if (!(await linkOrSkip(outside, link))) return

    await copyPath(from, join(dir, 'dst'))
    expect(await readlink(join(dir, 'dst', 'link.txt'))).toBe(outside)
    // The link is a link in the copy too: it does not become a second copy of
    // the file it points at.
    expect((await lstat(join(dir, 'dst', 'link.txt'))).isSymbolicLink()).toBe(true)
  })

  it('refuses an existing destination of either kind and copies nothing', async () => {
    const from = join(dir, 'a.txt')
    await writeFile(from, 'new')
    const fileTo = join(dir, 'b.txt')
    await writeFile(fileTo, 'old')
    await expect(copyPath(from, fileTo)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect(await readFile(fileTo, 'utf8')).toBe('old')

    const directoryTo = join(dir, 'b-dir')
    await mkdir(directoryTo)
    await expect(copyPath(from, directoryTo)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect((await stat(directoryTo)).isDirectory()).toBe(true)
  })

  it('reports a missing source as not found', async () => {
    await expect(copyPath(join(dir, 'nope'), join(dir, 'dst'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('refuses a symbolic link at the top rather than following it', async () => {
    const real = join(dir, 'real.txt')
    await writeFile(real, 'x')
    const link = join(dir, 'link.txt')
    if (!(await linkOrSkip(real, link))) return
    await expect(copyPath(link, join(dir, 'dst.txt'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(stat(join(dir, 'dst.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors a pre-aborted signal and leaves no destination', async () => {
    const from = join(dir, 'a.txt')
    await writeFile(from, 'x')
    const to = join(dir, 'b.txt')
    await expect(copyPath(from, to, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(to)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('movePath', () => {
  it('renames a file and leaves nothing at the source', async () => {
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    await writeFile(from, 'content')
    const outcome = await movePath(from, to)
    expect(outcome).toMatchObject({ type: 'file' })
    expect(outcome.target.displayPath).toBe(to)
    expect(await readFile(to, 'utf8')).toBe('content')
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves a whole directory subtree', async () => {
    const from = join(dir, 'src')
    await mkdir(join(from, 'nested'), { recursive: true })
    await writeFile(join(from, 'nested', 'a.txt'), 'a')
    const outcome = await movePath(from, join(dir, 'dst'))
    expect(outcome.type).toBe('directory')
    expect(await tree(join(dir, 'dst'))).toEqual(['nested', 'nested/a.txt'])
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an existing destination', async () => {
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    await writeFile(from, 'source')
    await writeFile(to, 'destination')
    await expect(movePath(from, to)).rejects.toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect(await readFile(from, 'utf8')).toBe('source')
    expect(await readFile(to, 'utf8')).toBe('destination')
  })

  it('reports a missing source as not found', async () => {
    await expect(movePath(join(dir, 'nope'), join(dir, 'dst'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('refuses a symbolic link at the source rather than moving it', async () => {
    const real = join(dir, 'real.txt')
    await writeFile(real, 'x')
    const link = join(dir, 'link.txt')
    if (!(await linkOrSkip(real, link))) return
    await expect(movePath(link, join(dir, 'dst.txt'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect(await readlink(link)).toBe(real)
  })

  it('falls back to copy-then-remove across devices, leaving the source removed once the copy is complete', async () => {
    const from = join(dir, 'src')
    await mkdir(join(from, 'nested'), { recursive: true })
    await writeFile(join(from, 'nested', 'a.txt'), 'a')
    const to = join(dir, 'dst')
    // The rename seam stands in for the second mounted filesystem a unit test
    // cannot acquire; the fallback after it is the production path.
    const outcome = await movePath(from, to, undefined, {
      renameFile: async () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    })
    expect(outcome.type).toBe('directory')
    expect(await tree(to)).toEqual(['nested', 'nested/a.txt'])
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the source in place when the fallback copy cannot complete', async () => {
    const from = join(dir, 'src')
    await mkdir(from)
    await writeFile(join(from, 'a.txt'), 'a')
    const to = join(dir, 'dst')
    const failure = await movePath(from, to, undefined, {
      renameFile: async () => {
        // The destination appears after the preflight, so the fallback copy
        // fails and the source must survive for the caller to retry.
        await mkdir(to)
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FS_ALREADY_EXISTS' })
    expect(await readFile(join(from, 'a.txt'), 'utf8')).toBe('a')
  })

  it('propagates a rename failure that is not a cross-device move', async () => {
    const from = join(dir, 'a.txt')
    await writeFile(from, 'x')
    const to = join(dir, 'b.txt')
    await expect(movePath(from, to, undefined, {
      renameFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
    })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(await readFile(from, 'utf8')).toBe('x')
  })

  it('honors a pre-aborted signal and moves nothing', async () => {
    const from = join(dir, 'a.txt')
    await writeFile(from, 'x')
    const to = join(dir, 'b.txt')
    await expect(movePath(from, to, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await readFile(from, 'utf8')).toBe('x')
    await expect(stat(to)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/**
 * Create a symbolic link, or report that this host refuses to.
 * @param target - the link's destination.
 * @param path - the link to create.
 * @returns whether the link exists afterwards.
 */
async function linkOrSkip(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path)
    return true
  } catch {
    // A Windows host without Developer Mode or elevation refuses symlink
    // creation (EPERM); the link-dependent assertions are then not runnable.
    return false
  }
}
