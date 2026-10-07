/**
 * The mutating endpoints: create, remove, copy, and move. Every one of them is
 * workspace-contained, so the containment refusal and the path-segment rules are
 * the gates under test here, beside the operations themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-mutate-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (): ReturnType<Harness['endpoint']> => harness.endpoint()

describe('workspaceFiles.createDirectory', () => {
  it('creates one directory under the root and reports its workspace path', async () => {
    const created = await endpoint().createDirectory(harness.scope, '.', 'src', signal())
    expect(created.path).toBe('src')
    expect(created.absolutePath.replace(/\\/g, '/')).toBe(`${workspace.replace(/\\/g, '/')}/src`)
    expect(typeof created.version).toBe('string')
    expect((await stat(join(workspace, 'src'))).isDirectory()).toBe(true)
  })

  it('creates a nested directory under a relative parent path', async () => {
    await mkdir(join(workspace, 'src'))
    const created = await endpoint().createDirectory(harness.scope, 'src', 'nested', signal())
    expect(created.path).toBe('src/nested')
    expect((await stat(join(workspace, 'src', 'nested'))).isDirectory()).toBe(true)
  })

  it('accepts the absolute parent path', async () => {
    const created = await endpoint().createDirectory(harness.scope, workspace, 'from-absolute', signal())
    expect(created.path).toBe('from-absolute')
    expect((await stat(join(workspace, 'from-absolute'))).isDirectory()).toBe(true)
  })

  it('refuses an occupied name', async () => {
    await mkdir(join(workspace, 'src'))
    const failure = await failureOf(endpoint().createDirectory(harness.scope, '.', 'src', signal()))
    expect(failure.code).toBe('workspace-file/exists')
    expect(failure.details).toMatchObject({ path: 'src' })
  })

  it('refuses a parent outside the workspace', async () => {
    const failure = await failureOf(endpoint().createDirectory(harness.scope, outside, 'escape', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })

  it('refuses a traversal that climbs out of the workspace', async () => {
    const failure = await failureOf(endpoint().createDirectory(harness.scope, '..', 'escape', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    await expect(stat(join(workspace, '..', 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a parent that is not a directory', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'x', 'utf8')
    const failure = await failureOf(endpoint().createDirectory(harness.scope, 'notes.txt', 'child', signal()))
    expect(failure.code).toBe('workspace-file/not-directory')
  })

  it('reports a missing parent as not found', async () => {
    const failure = await failureOf(endpoint().createDirectory(harness.scope, 'missing', 'child', signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })

  it('refuses an empty path', async () => {
    const failure = await failureOf(endpoint().createDirectory(harness.scope, '', 'child', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })
})

describe('workspaceFiles.createFile', () => {
  it('creates an empty file and reports its workspace path', async () => {
    const created = await endpoint().createFile(harness.scope, '.', 'notes.txt', signal())
    expect(created.path).toBe('notes.txt')
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('')
  })

  it('refuses any entry already at that name, file or directory', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'keep', 'utf8')
    await mkdir(join(workspace, 'src'))
    const file = await failureOf(endpoint().createFile(harness.scope, '.', 'notes.txt', signal()))
    expect(file.code).toBe('workspace-file/exists')
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('keep')

    const directory = await failureOf(endpoint().createFile(harness.scope, '.', 'src', signal()))
    expect(directory.code).toBe('workspace-file/exists')
  })

  it('refuses a parent outside the workspace', async () => {
    const failure = await failureOf(endpoint().createFile(harness.scope, outside, 'escape.txt', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })
})

describe('workspaceFiles — the name is one path segment', () => {
  const refused = [
    'a/b',
    'a\\b',
    '..',
    '.',
    '',
    '   ',
    ' leading',
    'trailing ',
  ]

  it('refuses a name that is not a single non-blank segment', async () => {
    for (const name of refused) {
      const failure = await failureOf(endpoint().createDirectory(harness.scope, '.', name, signal()))
      expect(failure.code, `name ${JSON.stringify(name)}`).toBe('gateway/bad-request')
    }
    expect(await readdir(workspace)).toEqual([])
  })

  it('refuses the same names for createFile', async () => {
    for (const name of refused) {
      const failure = await failureOf(endpoint().createFile(harness.scope, '.', name, signal()))
      expect(failure.code, `name ${JSON.stringify(name)}`).toBe('gateway/bad-request')
    }
    expect(await readdir(workspace)).toEqual([])
  })

  it('cannot escape through a separator even when the parent itself is inside', async () => {
    await mkdir(join(workspace, 'src'))
    const failure = await failureOf(endpoint().createDirectory(harness.scope, 'src', '..\\escape', signal()))
    expect(failure.code).toBe('gateway/bad-request')
    expect(await readdir(join(workspace, 'src'))).toEqual([])
  })
})

describe('workspaceFiles.remove', () => {
  it('removes a file and reports its workspace path', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'x', 'utf8')
    const removal = await endpoint().remove(harness.scope, 'notes.txt', {}, signal())
    expect(removal).toEqual({ sessionId: harness.scope.sessionId, path: 'notes.txt' })
    await expect(stat(join(workspace, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes an empty directory without recursive', async () => {
    await mkdir(join(workspace, 'src'))
    const removal = await endpoint().remove(harness.scope, 'src', {}, signal())
    expect(removal.path).toBe('src')
    await expect(stat(join(workspace, 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a non-empty directory without recursive and leaves it intact', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'a.ts'), 'x', 'utf8')
    const failure = await failureOf(endpoint().remove(harness.scope, 'src', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-empty')
    expect(failure.details).toMatchObject({ path: 'src' })
    expect(await readFile(join(workspace, 'src', 'a.ts'), 'utf8')).toBe('x')
  })

  it('removes a whole subtree with recursive', async () => {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'src', 'nested', 'a.ts'), 'x', 'utf8')
    const removal = await endpoint().remove(harness.scope, 'src', { recursive: true }, signal())
    expect(removal.path).toBe('src')
    await expect(stat(join(workspace, 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears a directory with contentsOnly and keeps the directory', async () => {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'src', 'nested', 'a.ts'), 'x', 'utf8')
    const removal = await endpoint().remove(harness.scope, 'src', { contentsOnly: true }, signal())
    expect(removal.path).toBe('src')
    expect((await stat(join(workspace, 'src'))).isDirectory()).toBe(true)
    expect(await readdir(join(workspace, 'src'))).toEqual([])
  })

  it('clears the workspace root with contentsOnly, keeping the root itself', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'notes.txt'), 'x', 'utf8')
    const removal = await endpoint().remove(harness.scope, '.', { contentsOnly: true }, signal())
    expect(removal.path).toBe('')
    expect(await readdir(workspace)).toEqual([])
  })

  it('refuses the workspace root itself', async () => {
    const failure = await failureOf(endpoint().remove(harness.scope, '.', { recursive: true }, signal()))
    expect(failure.code).toBe('gateway/bad-request')
    expect((await stat(workspace)).isDirectory()).toBe(true)
  })

  it('refuses a path outside the workspace, deleting nothing', async () => {
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
    const failure = await failureOf(endpoint().remove(harness.scope, join(outside, 'keep.txt'), { recursive: true }, signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('reports a missing target as not found', async () => {
    const failure = await failureOf(endpoint().remove(harness.scope, 'nope', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })
})

describe('workspaceFiles.copy', () => {
  it('copies a file to a new workspace path and leaves the source', async () => {
    await writeFile(join(workspace, 'a.txt'), 'content', 'utf8')
    const copied = await endpoint().copy(harness.scope, 'a.txt', 'b.txt', signal())
    expect(copied.path).toBe('b.txt')
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('content')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('content')
  })

  it('copies a directory subtree', async () => {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'src', 'nested', 'a.ts'), 'x', 'utf8')
    const copied = await endpoint().copy(harness.scope, 'src', 'src-copy', signal())
    expect(copied.path).toBe('src-copy')
    expect(await readFile(join(workspace, 'src-copy', 'nested', 'a.ts'), 'utf8')).toBe('x')
  })

  it('refuses an existing destination', async () => {
    await writeFile(join(workspace, 'a.txt'), 'source', 'utf8')
    await writeFile(join(workspace, 'b.txt'), 'destination', 'utf8')
    const failure = await failureOf(endpoint().copy(harness.scope, 'a.txt', 'b.txt', signal()))
    expect(failure.code).toBe('workspace-file/exists')
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('destination')
  })

  it('refuses a source outside the workspace', async () => {
    await writeFile(join(outside, 'a.txt'), 'x', 'utf8')
    const failure = await failureOf(endpoint().copy(harness.scope, join(outside, 'a.txt'), 'stolen.txt', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    await expect(stat(join(workspace, 'stolen.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a destination outside the workspace', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x', 'utf8')
    const failure = await failureOf(endpoint().copy(harness.scope, 'a.txt', join(outside, 'escape.txt'), signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    await expect(stat(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a destination nested inside the source', async () => {
    await mkdir(join(workspace, 'src'))
    const failure = await failureOf(endpoint().copy(harness.scope, 'src', 'src/inner', signal()))
    expect(failure.code).toBe('gateway/bad-request')
    expect(await readdir(join(workspace, 'src'))).toEqual([])
  })

  it('refuses the workspace root as the source', async () => {
    const failure = await failureOf(endpoint().copy(harness.scope, '.', 'copy', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })
})

describe('workspaceFiles.move', () => {
  it('moves a file and leaves nothing at the source', async () => {
    await writeFile(join(workspace, 'a.txt'), 'content', 'utf8')
    const moved = await endpoint().move(harness.scope, 'a.txt', 'b.txt', signal())
    expect(moved.path).toBe('b.txt')
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('content')
    await expect(stat(join(workspace, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves a directory into another directory', async () => {
    await mkdir(join(workspace, 'from-dir'))
    await mkdir(join(workspace, 'to-dir'))
    await writeFile(join(workspace, 'from-dir', 'a.ts'), 'x', 'utf8')
    const moved = await endpoint().move(harness.scope, 'from-dir', 'to-dir/from-dir', signal())
    expect(moved.path).toBe('to-dir/from-dir')
    expect(await readFile(join(workspace, 'to-dir', 'from-dir', 'a.ts'), 'utf8')).toBe('x')
  })

  it('refuses an existing destination, moving nothing', async () => {
    await writeFile(join(workspace, 'a.txt'), 'source', 'utf8')
    await writeFile(join(workspace, 'b.txt'), 'destination', 'utf8')
    const failure = await failureOf(endpoint().move(harness.scope, 'a.txt', 'b.txt', signal()))
    expect(failure.code).toBe('workspace-file/exists')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('source')
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('destination')
  })

  it('refuses a source outside the workspace', async () => {
    await writeFile(join(outside, 'a.txt'), 'x', 'utf8')
    const failure = await failureOf(endpoint().move(harness.scope, join(outside, 'a.txt'), 'imported.txt', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('x')
  })

  it('refuses a destination outside the workspace', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x', 'utf8')
    const failure = await failureOf(endpoint().move(harness.scope, 'a.txt', join(outside, 'escape.txt'), signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('x')
    await expect(stat(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a destination nested inside the source', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'a.ts'), 'x', 'utf8')
    const failure = await failureOf(endpoint().move(harness.scope, 'src', 'src/inner', signal()))
    expect(failure.code).toBe('gateway/bad-request')
    expect(await readFile(join(workspace, 'src', 'a.ts'), 'utf8')).toBe('x')
  })

  it('refuses the workspace root as the source', async () => {
    const failure = await failureOf(endpoint().move(harness.scope, '.', 'moved', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('reports a missing source as not found', async () => {
    const failure = await failureOf(endpoint().move(harness.scope, 'nope.txt', 'b.txt', signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })
})
