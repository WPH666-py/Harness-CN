/**
 * The write fence: a mutation must be confined to the workspace its scope
 * names, not to the deployment fallback the sandbox policy resolves when a
 * caller passes no policy at all.
 *
 * Both roots live beside this file, never under the platform temp area: the
 * sandbox counts `tmpdir()` as writable, so a temp workspace would pass even
 * when the service forgot the per-call policy and the test would prove nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceFiles, type Config, type WorkspaceFileScope } from '../src/index.ts'

let root: string
let workspace: string
let deployment: string
let ctx: Context
let dispose: () => Promise<void>
let scope: WorkspaceFileScope

const caps = (): Config => ({
  maxBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxLines: 5000,
  maxEntries: 2000,
})

const signal = (): AbortSignal => new AbortController().signal

beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dirname, '.fence-'))
  workspace = join(root, 'workspace')
  deployment = join(root, 'deployment')
  await mkdir(workspace)
  await mkdir(deployment)
  ctx = new Context()
  // The fallback root a caller with no policy would get: NOT the session workspace.
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    workspaceRoot: deployment,
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: deployment }),
  } as never)
  const fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  dispose = async () => {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  scope = { sessionId: SessionId('s-fence'), workspaceRoot: workspace }
})

afterEach(async () => {
  await dispose()
})

describe('workspaceFiles.write — the per-call fence', () => {
  it('writes inside the session workspace even though the fallback root differs', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'before', 'utf8')
    const written = await new WorkspaceFiles(ctx, caps()).write(scope, 'notes.txt', 'after', signal())
    expect(written.path).toBe('notes.txt')
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('after')
  })

  it('refuses a target the session workspace does not cover', async () => {
    await writeFile(join(deployment, 'notes.txt'), 'before', 'utf8')
    await expect(
      new WorkspaceFiles(ctx, caps()).write(scope, join(deployment, 'notes.txt'), 'after', signal()),
    ).rejects.toThrow(/file access denied/u)
    expect(await readFile(join(deployment, 'notes.txt'), 'utf8')).toBe('before')
  })
})