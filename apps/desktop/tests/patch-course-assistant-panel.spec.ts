import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasCourseAssistantPanelPatch,
  patchCourseAssistantPanel,
  verifyCourseAssistantPanel,
} from '../scripts/patch-course-assistant-panel.mjs'

const SCRIPT = resolve(import.meta.dirname, '../scripts/patch-course-assistant-panel.mjs')

/** The installed bundle, reduced to the panel header and the entries the patch anchors on. */
const PUBLISHED = [
  '  const CSS = `',
  '    .ca-head{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
  '    .ca-btn.small{padding:2px 8px;font-size:11.5px}',
  '    `',
  '',
  '    function Panel() {',
  '      return h(',
  "        'div',",
  "        { className: 'ca-root' },",
  "        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),",
  "        h('div', { className: 'ca-head' },",
  "          h('h2', { className: 'ca-title' }, '课程助手'),",
  "          h('span', { className: 'ca-sub' }, '课程文件 → 目录 · 知识点 · B 站网课 · 学习报告'),",
  "          h('span', { className: 'ca-sp' }),",
  "          h('button', { className: 'ca-btn small', onClick: () => setHistoryOpen((open) => !open) }, '历史'),",
  "          h('button', { className: 'ca-btn small', onClick: reset, disabled: busy }, '清空'),",
  '        ),',
  '      )',
  '    }',
  '',
  '    return {',
  "      inject: ['slots'],",
  '      apply(ctx) {',
  '        const layout = (() => {',
  '          try {',
  "            return ctx.get?.('layout') || ctx.layout",
  '          } catch {',
  '            return null',
  '          }',
  '        })()',
  '        const open = () => {',
  '          try {',
  "            layout?.selectPanel?.('course-assistant')",
  '          } catch {}',
  '        }',
  '        try {',
  "          off.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'course-assistant' }, Panel)))",
  '        } catch {}',
  '      },',
  '    }',
  '',
].join('\n')

/**
 * The same bundle after the dock patch, which is the state production reaches this patch in.
 *
 * The dock correction lives in a component and a CSS block this patch never touches, so a bundle
 * carrying both is the only shape the seed ever sees.
 */
const DOCKED = PUBLISHED.replace(
  '    function Panel() {',
  [
    '    function Dock({ open }) {',
    "      return h('button', { className: 'ca-dock-button', style: { border: 0 }, onClick: open }, '课程助手面板')",
    '    }',
    '',
    '    function Panel() {',
  ].join('\n'),
)

/** A profile that holds the installed plugin the way the seed archives it. */
interface InstalledProfile {
  /** The profile directory, holding `node_modules`. */
  readonly profile: string
  /** The `node_modules` root inside that profile. */
  readonly modules: string
  /** The installed client bundle the patch corrects. */
  readonly file: string
}

function installedProfile(contents: string): InstalledProfile {
  const root = mkdtempSync(join(tmpdir(), 'dsh-course-assistant-panel-'))
  const profile = join(root, 'profile')
  const modules = join(profile, 'node_modules')
  const file = join(modules, 'dsh-course-assistant', 'client.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
  return { profile, modules, file }
}

describe('dsh-course-assistant panel patch', () => {
  it('adds the close button to the header and leaves through the layout store', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      patchCourseAssistantPanel(installed.modules)
      const patched = readFileSync(installed.file, 'utf8')
      expect(hasCourseAssistantPanelPatch(patched)).toBe(true)
      // The header keeps both of its buttons and gains a labelled one after them.
      expect(patched).toContain("h('button', { className: 'ca-btn small', onClick: reset, disabled: busy }, '清空'),")
      expect(patched).toContain("'aria-label': '关闭课程助手面板', title: '关闭'")
      expect(patched).toContain("onClick: onClose }, '×'),")
      const header = patched.slice(patched.indexOf("className: 'ca-head'"))
      expect(header.indexOf('清空')).toBeLessThan(header.indexOf('关闭课程助手面板'))
      // The panel takes the callback and the registration supplies it.
      expect(patched).toContain('function Panel({ onClose }) {')
      expect(patched).toContain('layout?.selectPanel?.(null)')
      expect(patched).toContain('(props) => h(Panel, { ...props, onClose: close })')
      // The open path is untouched: the dock still selects the panel by name.
      expect(patched).toContain("layout?.selectPanel?.('course-assistant')")
      expect(patched).toContain('.ca-head{display:flex;')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('is a no-op on a bundle it already patched', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      patchCourseAssistantPanel(installed.modules)
      const once = readFileSync(installed.file, 'utf8')
      expect(patchCourseAssistantPanel(installed.modules)).toContain('already patched')
      expect(readFileSync(installed.file, 'utf8')).toBe(once)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('patches the installed bundle through the command line and reports the file it wrote', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      const output = execFileSync(process.execPath, [SCRIPT, installed.modules], { encoding: 'utf8' })
      expect(output).toMatch(/patched .* \(\d+ bytes, sha256 [0-9a-f]{64}\)/u)
      expect(hasCourseAssistantPanelPatch(readFileSync(installed.file, 'utf8'))).toBe(true)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('reports pristine before the patch and patched after it', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      const pristine = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(pristine.status).toBe(0)
      expect(pristine.stdout).toContain('"state":"pristine"')

      patchCourseAssistantPanel(installed.modules)

      const patched = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(patched.status).toBe(0)
      expect(patched.stdout).toContain('"state":"patched"')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('refuses a bundle whose header was rewritten instead of shipping a dead button', () => {
    const installed = installedProfile(PUBLISHED.replace("disabled: busy }, '清空')", "disabled: busy }, '重置')"))
    try {
      expect(() => patchCourseAssistantPanel(installed.modules)).toThrow(/does not contain .*the plugin changed/u)
      const check = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(check.status).toBe(1)
      expect(check.stdout).toContain('"state":"drifted"')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('refuses a bundle whose main registration no longer passes a component', () => {
    const installed = installedProfile(PUBLISHED.replace("key: 'course-assistant' }, Panel)", "key: 'course-assistant' }, () => null)"))
    try {
      expect(() => patchCourseAssistantPanel(installed.modules)).toThrow(/does not contain .*the plugin changed/u)
      const check = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(check.status).toBe(1)
      expect(check.stdout).toContain('"state":"drifted"')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('patches a bundle the dock patch already corrected', () => {
    const installed = installedProfile(DOCKED)
    try {
      expect(DOCKED).toContain("className: 'ca-dock-button', style: {")
      patchCourseAssistantPanel(installed.modules)
      const patched = readFileSync(installed.file, 'utf8')
      expect(hasCourseAssistantPanelPatch(patched)).toBe(true)
      // The earlier correction is still there; this patch only adds its own.
      expect(patched).toContain("className: 'ca-dock-button', style: {")
      expect(patched.match(/function Panel\(/gu)).toHaveLength(1)
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('reports a tree with no dsh-course-assistant and still succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-course-assistant-panel-absent-'))
    try {
      const output = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
      expect(output).toContain('not installed; nothing to patch')
      const check = spawnSync(process.execPath, [SCRIPT, '--check', root], { encoding: 'utf8' })
      expect(check.status).toBe(0)
      expect(check.stdout).toContain('"state":"absent"')
      expect(() => {
        verifyCourseAssistantPanel(root)
      }).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies a patched profile and rejects an unpatched one', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      expect(() => {
        verifyCourseAssistantPanel(installed.profile)
      }).toThrow(/still renders its panel without a close button/u)
      patchCourseAssistantPanel(installed.modules)
      expect(() => {
        verifyCourseAssistantPanel(installed.profile)
      }).not.toThrow()
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })
})
