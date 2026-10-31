/**
 * The text-writing endpoint: one complete replacement, the content and target
 * gates that precede it, the observation the change feed relays afterwards, and
 * the access it shares with `read` rather than with the mutating verbs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-write-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  try {
    await harness.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

const endpoint = (caps?: { maxFileBytes?: number }): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

describe('workspaceFiles.write — the happy path', () => {
  it('replaces the complete content and reports the written file', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before\n', 'utf8')
    const written = await endpoint().write(harness.scope, 'notes.txt', 'after', signal())
    expect(written.path).toBe('notes.txt')
    expect(written.absolutePath.replace(/\\/g, '/')).toBe(`${workspace.replace(/\\/g, '/')}/notes.txt`)
    expect(typeof written.version).toBe('string')
    expect(written.bytes).toBe(5)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('after')
  })

  it('reports the write through the change feed', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const controller = new AbortController()
    const stream = endpoint().changes(harness.scope, controller.signal)[Symbol.asyncIterator]()
    try {
      await expect(stream.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
      const written = await endpoint().write(harness.scope, 'notes.txt', 'after', signal())
      const change = await stream.next()
      expect(change.value).toEqual({
        kind: 'change',
        change: { absolutePath: written.absolutePath, version: written.version },
      })
    } finally {
      controller.abort()
      await stream.return?.()
    }
  })

  it('writes a path outside the workspace, which reads already allow', async () => {
    await writeFile(join(outside, 'notes.txt'), 'before', 'utf8')
    const written = await endpoint().write(harness.scope, '../outside/notes.txt', 'after', signal())
    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('after')
    expect(written.absolutePath.replace(/\\/g, '/')).toBe(join(outside, 'notes.txt').replace(/\\/g, '/'))
    // A file outside the workspace has no workspace-relative path to report.
    expect(written.path).toBe(written.absolutePath)
  })
})

describe('workspaceFiles.write — the content gates', () => {
  it('refuses NUL bytes and leaves the file as it was', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const failure = await failureOf(endpoint().write(harness.scope, 'notes.txt', 'a\u0000b', signal()))
    expect(failure.code).toBe('workspace-file/not-text')
    expect(failure.details).toMatchObject({ path: 'notes.txt' })
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('before')
  })

  it('refuses text above the full-file cap, counted in UTF-8 bytes', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const failure = await failureOf(endpoint({ maxFileBytes: 8 }).write(harness.scope, 'notes.txt', '\u00e9'.repeat(5), signal()))
    expect(failure.code).toBe('workspace-file/too-large')
    expect(failure.details).toMatchObject({ path: 'notes.txt', limit: 8 })
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('before')
  })

  it('admits text exactly at the cap, counted in UTF-8 bytes', async () => {
    await writeFile(join(workspace, 'notes.txt'), '', 'utf8')
    const written = await endpoint({ maxFileBytes: 8 }).write(harness.scope, 'notes.txt', '\u00e9'.repeat(4), signal())
    expect(written.bytes).toBe(8)
  })
})

describe('workspaceFiles.write — the target', () => {
  it('refuses a directory and leaves it intact', async () => {
    await mkdir(join(workspace, 'src'))
    const failure = await failureOf(endpoint().write(harness.scope, 'src', 'content', signal()))
    expect(failure.code).toBe('workspace-file/not-file')
    expect(failure.details).toMatchObject({ path: 'src' })
    expect((await stat(join(workspace, 'src'))).isDirectory()).toBe(true)
  })

  it('reports a missing file as not found', async () => {
    const failure = await failureOf(endpoint().write(harness.scope, 'nope.txt', 'content', signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })
})

describe('workspaceFiles.write — cancellation', () => {
  it('refuses an already-aborted signal and writes nothing', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const controller = new AbortController()
    controller.abort()
    await expect(endpoint().write(harness.scope, 'notes.txt', 'after', controller.signal)).rejects.toThrow()
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('before')
  })

  it('stops before publishing when the signal aborts during the write', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const controller = new AbortController()
    const original = harness.ctx.fs.writeText.bind(harness.ctx.fs)
    vi.spyOn(harness.ctx.fs, 'writeText').mockImplementation(async (target, content, expected, abort) => {
      controller.abort()
      abort?.throwIfAborted()
      return original(target, content, expected, abort)
    })
    await expect(endpoint().write(harness.scope, 'notes.txt', 'after', controller.signal)).rejects.toThrow()
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('before')
  })
})
