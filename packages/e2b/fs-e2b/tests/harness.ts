/**
 * The boot fixture shared by the E2B filesystem provider's suites: a context
 * whose `ctx.e2b` hands out the supplied in-memory sandbox, with the provider
 * registered as `ctx.fs`.
 */
import { expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type E2BRuntime from '@deepseek-ai/dsh-e2b'
import E2BFileSystem from '@deepseek-ai/dsh-fs-e2b'
import { FakeRemote } from './fake-remote.ts'

/**
 * Boot the provider over one in-memory sandbox.
 * @param remote - the sandbox fixture; a fresh one when omitted.
 * @returns the context, the provider, and the fixture.
 */
export async function setup(remote = new FakeRemote()): Promise<{ ctx: Context; fs: E2BFileSystem; remote: FakeRemote }> {
  const ctx = new Context()
  const runtime = {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    getSandbox: async () => remote.sandbox,
  } as unknown as E2BRuntime
  ctx.provide('e2b', runtime)
  await ctx.plugin(E2BFileSystem)
  return { ctx, fs: ctx.fs as E2BFileSystem, remote }
}

/**
 * Assert one operation's structured refusal.
 * @param promise - the operation under test.
 * @param code - the expected `FsError` code.
 */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}
