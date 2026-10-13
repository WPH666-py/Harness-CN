import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WECHAT_BOT_NAME, patchWeChatIdentity, verifyWeChatIdentity } from '../scripts/patch-wechat-identity.mjs'

/** The published dsh-wechat 0.10.0 config module, reduced to the export the patch touches. */
const PUBLISHED = [
  'export const DEFAULT_SURFACE_PROMPT = "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（支持简单的 Markdown、适度使用 emoji、避免过长的表格）。";',
  'export const LEGACY_SURFACE_PROMPTS = [',
  '    "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（纯文本、适度使用 emoji、避免过长的表格）。",',
  '];',
  '',
].join('\n')

const SCRIPT = resolve(import.meta.dirname, '../scripts/patch-wechat-identity.mjs')

/** A profile that holds the installed plugin the way the seed archives it. */
interface InstalledProfile {
  /** The profile directory, holding `node_modules`. */
  readonly profile: string
  /** The `node_modules` root inside that profile. */
  readonly modules: string
  /** The installed `dsh-wechat` config module the patch corrects. */
  readonly file: string
}

function installedProfile(contents: string): InstalledProfile {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wechat-identity-'))
  const profile = join(root, 'profile')
  const modules = join(profile, 'node_modules')
  const file = join(modules, 'dsh-wechat', 'dist', 'config.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
  return { profile, modules, file }
}

describe('dsh-wechat identity patch', () => {
  it('appends the product name to the built-in surface prompt', () => {
    const patched = patchWeChatIdentity(PUBLISHED)
    expect(patched).toBeTypeOf('string')
    expect(patched).toContain(`你在微信里的名字是 ${WECHAT_BOT_NAME}`)
    // The rest of the published module survives untouched, superseded prompts included.
    expect(patched).toContain('请使用适合微信阅读的格式（支持简单的 Markdown、适度使用 emoji、避免过长的表格）。')
    expect(patched).toContain('export const LEGACY_SURFACE_PROMPTS = [')
  })

  it('leaves a module that already names the bridge alone', () => {
    const patched = patchWeChatIdentity(PUBLISHED)
    expect(patchWeChatIdentity(patched as string)).toBeUndefined()
  })

  it('refuses a module it cannot anchor on instead of leaving the bridge unnamed', () => {
    expect(() => patchWeChatIdentity('export const DEFAULT_SURFACE_PROMPT = `模板字面量`;\n'))
      .toThrow(/does not export DEFAULT_SURFACE_PROMPT in a form the patch anchors on/u)
  })

  it('patches the installed module through the command line, then reports it as named already', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      const first = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(first).toContain(`patched ${installed.modules}`)
      expect(readFileSync(installed.file, 'utf8')).toContain(WECHAT_BOT_NAME)

      const second = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(second).toContain(`already names the bridge ${WECHAT_BOT_NAME}`)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('verifies a patched tree through its profile directory as well as its modules root', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      expect(() => verifyWeChatIdentity(installed.profile)).toThrow(/does not name the bridge/u)
      expect(() => verifyWeChatIdentity(installed.modules)).toThrow(/does not name the bridge/u)

      execFileSync(process.execPath, [SCRIPT, installed.profile], { encoding: 'utf8' })
      expect(verifyWeChatIdentity(installed.profile)).toBe(installed.file)
      expect(verifyWeChatIdentity(installed.modules)).toBe(installed.file)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('reports a tree with no dsh-wechat and still succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-wechat-identity-absent-'))
    try {
      const output = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
      expect(output).toContain(`no dsh-wechat under ${root}`)
      expect(() => verifyWeChatIdentity(root)).toThrow(/has no dsh-wechat module/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
