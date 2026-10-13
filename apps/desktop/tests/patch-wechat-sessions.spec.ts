import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchWeChatSessions, verifyWeChatSessions } from '../scripts/patch-wechat-sessions.mjs'

/** The published dsh-wechat 0.8.0 agent setup, reduced to the lines the patch touches. */
const PUBLISHED = [
  'async function agentSetup(agentCtx) {',
  '    const ctx = agentCtx;',
  '    const presets = ctx.get?.("agentPresets");',
  '    if (presets) {',
  '        try {',
  '            await presets.mount(agentCtx, ctx.agent?.session?.header?.agentPreset);',
  '        }',
  '        catch (err) {',
  '            console.error(`[dsh-wechat] preset mount failed: ${String(err)}`);',
  '        }',
  '    }',
  '    const logged = ctx.agent?.session?.requestHeader?.()?.config;',
  '}',
  '',
].join('\n')

const SCRIPT = resolve(import.meta.dirname, '../scripts/patch-wechat-sessions.mjs')

/** The shipped dsh-wechat 0.10.0 setup, which takes the agent as the callback's second argument. */
const CORRECTED_UPSTREAM = [
  ' * DSH 0.1.5 removed `ctx.agent`; `setup` now receives `(agentCtx, agent)`.',
  ' */',
  'export async function agentSetup(agentCtx, agent) {',
  '    const ctx = agentCtx;',
  '    const live = agent;',
  '    const presets = ctx.get?.("agentPresets");',
  '    await presets.mount(agentCtx, live?.session?.header?.agentPreset);',
  '    const logged = live?.session?.requestHeader?.()?.config;',
  '}',
  '',
].join('\n')

/** A profile that holds the installed plugin the way the seed archives it. */
interface InstalledProfile {
  /** The profile directory, holding `node_modules`. */
  readonly profile: string
  /** The `node_modules` root inside that profile. */
  readonly modules: string
  /** The installed `dsh-wechat` module the patch corrects. */
  readonly file: string
}

function installedProfile(contents: string): InstalledProfile {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wechat-patch-'))
  const profile = join(root, 'profile')
  const modules = join(profile, 'node_modules')
  const file = join(modules, 'dsh-wechat', 'dist', 'dsh', 'sessions.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
  return { profile, modules, file }
}

describe('dsh-wechat agent setup patch', () => {
  it('reads the agent from the setup callback instead of the context', () => {
    const patched = patchWeChatSessions(PUBLISHED)
    expect(patched).toContain('async function agentSetup(agentCtx, agent) {')
    expect(patched).toContain('await presets.mount(agentCtx, agent?.session?.header?.agentPreset);')
    expect(patched).toContain('const logged = agent?.session?.requestHeader?.()?.config;')
    expect(patched).not.toContain('ctx.agent')
    // The rest of the published module survives untouched.
    expect(patched).toContain('const presets = ctx.get?.("agentPresets");')
    expect(patched).toContain('console.error(`[dsh-wechat] preset mount failed: ${String(err)}`);')
  })

  it('leaves a module that already reads the agent legally alone', () => {
    const patched = patchWeChatSessions(PUBLISHED)
    expect(patched).toBeTypeOf('string')
    expect(patchWeChatSessions(patched as string)).toBeUndefined()
  })

  it('leaves the shipped 0.10.0 setup alone, whose doc comment names the removed property', () => {
    expect(patchWeChatSessions(CORRECTED_UPSTREAM)).toBeUndefined()
    const installed = installedProfile(CORRECTED_UPSTREAM)
    try {
      expect(verifyWeChatSessions(installed.modules)).toBe(installed.file)
      const output = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(output).toContain('already reads the agent from the setup callback')
      expect(readFileSync(installed.file, 'utf8')).toBe(CORRECTED_UPSTREAM)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('refuses a module it cannot anchor on instead of patching it silently', () => {
    expect(() => patchWeChatSessions('const first = ctx.agent.session;\n'))
      .toThrow(/does not contain the line the patch anchors on/u)
  })

  it('patches the installed module through the command line, then reports it as patched already', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      const first = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(first).toContain(`patched ${installed.modules}`)
      expect(readFileSync(installed.file, 'utf8')).not.toContain('ctx.agent')

      const second = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(second).toContain('already reads the agent from the setup callback')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('verifies a patched tree through its profile directory as well as its modules root', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      expect(() => verifyWeChatSessions(installed.profile)).toThrow(/still reads the agent through the setup context/u)
      expect(() => verifyWeChatSessions(installed.modules)).toThrow(/still reads the agent through the setup context/u)

      execFileSync(process.execPath, [SCRIPT, installed.profile], { encoding: 'utf8' })
      expect(verifyWeChatSessions(installed.profile)).toBe(installed.file)
      expect(verifyWeChatSessions(installed.modules)).toBe(installed.file)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('reports a tree with no dsh-wechat and still succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-wechat-absent-'))
    try {
      const output = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
      expect(output).toContain(`no dsh-wechat under ${root}`)
      expect(() => verifyWeChatSessions(root)).toThrow(/has no dsh-wechat module/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
