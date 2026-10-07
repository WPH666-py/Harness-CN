/**
 * The per-call policy fence on the path-changing operations: `read-only` denies
 * every one of them, `workspace-write` contains both ends of a copy or a move
 * and the entry a removal removes, and `danger-full-access` delegates unfenced.
 * The fence is exercised against a real filesystem, so a denied operation is
 * shown to leave no trace.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fssbx-mutate-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('read-only denies every path-changing operation', () => {
  beforeEach(() => boot('read-only'))

  it('denies createDirectory, creating nothing', async () => {
    const path = join(workspace, 'new-dir')
    await expect(fs.createDirectory(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies createFile, creating nothing', async () => {
    const path = join(workspace, 'new.txt')
    await expect(fs.createFile(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies remove, deleting nothing', async () => {
    const path = join(workspace, 'keep.txt')
    await writeFile(path, 'keep')
    await expect(fs.remove(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('keep')
  })

  it('denies copy, writing nothing', async () => {
    const from = join(workspace, 'a.txt')
    await writeFile(from, 'x')
    await expect(fs.copy(await target(from), await target(join(workspace, 'b.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false)
  })

  it('denies move, moving nothing', async () => {
    const from = join(workspace, 'a.txt')
    await writeFile(from, 'x')
    await expect(fs.move(await target(from), await target(join(workspace, 'b.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(from, 'utf8')).toBe('x')
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false)
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('creates a directory and a file inside the workspace', async () => {
    await fs.createDirectory(await target(join(workspace, 'src')))
    await fs.createFile(await target(join(workspace, 'src', 'a.txt')))
    expect(existsSync(join(workspace, 'src', 'a.txt'))).toBe(true)
  })

  it('removes inside the workspace', async () => {
    const path = join(workspace, 'a.txt')
    await writeFile(path, 'x')
    await fs.remove(await target(path))
    expect(existsSync(path)).toBe(false)
  })

  it('copies and moves inside the workspace', async () => {
    const from = join(workspace, 'a.txt')
    await writeFile(from, 'x')
    await fs.copy(await target(from), await target(join(workspace, 'b.txt')))
    await fs.move(await target(from), await target(join(workspace, 'c.txt')))
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('x')
    expect(await readFile(join(workspace, 'c.txt'), 'utf8')).toBe('x')
    expect(existsSync(from)).toBe(false)
  })

  it('denies a removal outside the workspace, deleting nothing', async () => {
    const path = join(outside, 'keep.txt')
    await writeFile(path, 'keep')
    await expect(fs.remove(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('keep')
  })

  it('denies a recursive removal that would reach outside the workspace', async () => {
    const path = join(outside, 'tree')
    await mkdir(join(path, 'nested'), { recursive: true })
    await writeFile(join(path, 'nested', 'a.txt'), 'x')
    await expect(fs.remove(await target(path), { recursive: true })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(path, 'nested', 'a.txt'), 'utf8')).toBe('x')
  })

  it('denies a creation outside the workspace, creating nothing', async () => {
    const path = join(outside, 'escape')
    await expect(fs.createDirectory(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies a copy whose DESTINATION is outside the workspace, writing nothing there', async () => {
    const from = join(workspace, 'a.txt')
    await writeFile(from, 'x')
    await expect(fs.copy(await target(from), await target(join(outside, 'stolen.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'stolen.txt'))).toBe(false)
    expect(await readFile(from, 'utf8')).toBe('x')
  })

  it('denies a move whose SOURCE is outside the workspace, importing nothing', async () => {
    const from = join(outside, 'a.txt')
    await writeFile(from, 'x')
    await expect(fs.move(await target(from), await target(join(workspace, 'imported.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(from, 'utf8')).toBe('x')
    expect(existsSync(join(workspace, 'imported.txt'))).toBe(false)
  })

  it('denies a move whose DESTINATION is outside the workspace, moving nothing', async () => {
    const from = join(workspace, 'a.txt')
    await writeFile(from, 'x')
    await expect(fs.move(await target(from), await target(join(outside, 'escape.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(from, 'utf8')).toBe('x')
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false)
  })

  it('denies a `..` traversal out of the workspace for a removal', async () => {
    const path = join(outside, 'traversed.txt')
    await writeFile(path, 'x')
    await expect(fs.remove(await target(join(workspace, '..', 'out', 'traversed.txt'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('x')
  })

  it('a batch of two ends is refused as a whole: a contained source does not license an outside destination', async () => {
    const from = join(workspace, 'src')
    await mkdir(from)
    await writeFile(join(from, 'a.txt'), 'x')
    await expect(fs.move(await target(from), await target(join(outside, 'src'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(from, 'a.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(outside, 'src'))).toBe(false)
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('creates, copies, moves, and removes outside the workspace', async () => {
    const created = join(outside, 'free')
    await fs.createDirectory(await target(created))
    await fs.createFile(await target(join(created, 'a.txt')))
    await fs.copy(await target(join(created, 'a.txt')), await target(join(outside, 'b.txt')))
    await fs.move(await target(join(outside, 'b.txt')), await target(join(outside, 'c.txt')))
    await fs.remove(await target(created), { recursive: true })
    expect(await readFile(join(outside, 'c.txt'), 'utf8')).toBe('')
    expect(existsSync(created)).toBe(false)
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained creation land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'granted')
    await fs.createDirectory(
      await target(path),
      {},
      undefined,
      { mode: 'workspace-write', workspaceRoot: workspace },
    )
    expect(existsSync(path)).toBe(true)
    await expect(fs.createDirectory(await target(join(workspace, 'plain'))))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp on a read-only default removes an outside entry for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted.txt')
    await writeFile(path, 'x')
    await fs.remove(
      await target(path),
      {},
      undefined,
      { mode: 'danger-full-access', workspaceRoot: workspace },
    )
    expect(existsSync(path)).toBe(false)
  })
})

describe('the fence checks the identity it mutates', () => {
  it('moves the freshly canonicalized source rather than the caller’s stale targetKey', async () => {
    await boot('workspace-write')
    const from = join(workspace, 'a.txt')
    const to = join(workspace, 'b.txt')
    await writeFile(from, 'x')
    // A stale key pointing outside would be the escaped path if the fence
    // delegated with the caller's target instead of its own fresh resolve.
    const stale: FsTarget = { displayPath: from, targetKey: (await target(join(outside, 'escaped.txt'))).targetKey }
    await fs.move(stale, await target(to))
    expect(await readFile(to, 'utf8')).toBe('x')
    expect(existsSync(from)).toBe(false)
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })
})
