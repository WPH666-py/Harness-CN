import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasCourseAssistantDockPatch,
  patchCourseAssistantDock,
  verifyCourseAssistantDock,
} from '../scripts/patch-course-assistant-dock.mjs'

const SCRIPT = resolve(import.meta.dirname, '../scripts/patch-course-assistant-dock.mjs')

/** The installed bundle, reduced to the dock CSS and component the patch anchors on. */
const PUBLISHED = [
  '  const CSS = `',
  '    .ca-dock{display:flex;align-items:center;gap:8px;font-size:11.5px;opacity:.9;padding:2px 0}',
  '    .ca-dock button{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11.5px;padding:0 4px}',
  '    .ca-panel-icon{display:block}',
  '    `',
  '',
  '    function Dock({ open }) {',
  '      return h(',
  "        'div',",
  "        { className: 'ca-dock' },",
  "        h('span', null, '🎓 课程助手'),",
  "        h('button', { onClick: open }, '打开面板 →'),",
  '      )',
  '    }',
  '',
].join('\n')

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-course-assistant-dock-'))
  const profile = join(root, 'profile')
  const modules = join(profile, 'node_modules')
  const file = join(modules, 'dsh-course-assistant', 'client.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
  return { profile, modules, file }
}

describe('dsh-course-assistant dock patch', () => {
  it('replaces the caption and the link button with one labelled button', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      patchCourseAssistantDock(installed.modules)
      const patched = readFileSync(installed.file, 'utf8')
      expect(hasCourseAssistantDockPatch(patched)).toBe(true)
      expect(patched).toContain("h('button', { className: 'ca-dock-button', onClick: open }, '课程助手面板'),")
      // The caption and the old label are gone, and the wrapper the slot's layout applies survives.
      expect(patched).not.toContain('🎓 课程助手')
      expect(patched).not.toContain('打开面板 →')
      expect(patched).toContain("{ className: 'ca-dock' },")
      // The dock's own rules no longer reserve a gapped row or style the button as bare text.
      expect(patched).toContain('.ca-dock{display:inline-flex;align-items:center;gap:0;padding:0;background:none;border:0}')
      expect(patched).toContain('.ca-dock-button{border:1px solid var(--dsw-alias-border-l1)')
      expect(patched).not.toContain('.ca-dock button{')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('is a no-op on a bundle it already patched', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      patchCourseAssistantDock(installed.modules)
      const once = readFileSync(installed.file, 'utf8')
      expect(patchCourseAssistantDock(installed.modules)).toContain('already patched')
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
      expect(hasCourseAssistantDockPatch(readFileSync(installed.file, 'utf8'))).toBe(true)
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

      patchCourseAssistantDock(installed.modules)

      const patched = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(patched.status).toBe(0)
      expect(patched.stdout).toContain('"state":"patched"')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('refuses a rewritten bundle instead of shipping a half-patched dock', () => {
    const installed = installedProfile(PUBLISHED.replace(/^ {4}function Dock[\s\S]*^ {4}\}$/mu, '    function Dock() { return null }'))
    try {
      expect(() => patchCourseAssistantDock(installed.modules)).toThrow(/has dock CSS but no dock component; the plugin changed/u)
      const check = spawnSync(process.execPath, [SCRIPT, '--check', installed.modules], { encoding: 'utf8' })
      expect(check.status).toBe(1)
      expect(check.stdout).toContain('"state":"drifted"')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('patches a bundle whose dock CSS is not in the file and leaves that CSS alone', () => {
    const withoutCss = PUBLISHED.replace(/^ {4}\.ca-dock\{[^\n]*\}\n/mu, '').replace(/^ {4}\.ca-dock button\{[^\n]*\}\n/mu, '')
    const installed = installedProfile(withoutCss)
    try {
      expect(() => patchCourseAssistantDock(installed.modules)).not.toThrow()
      const patched = readFileSync(installed.file, 'utf8')
      expect(patched).toContain("h('button', { className: 'ca-dock-button', onClick: open }, '课程助手面板'),")
      expect(patched).not.toContain('.ca-dock-button{')
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })

  it('reports a tree with no dsh-course-assistant and still succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-course-assistant-dock-absent-'))
    try {
      const output = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
      expect(output).toContain('not installed; nothing to patch')
      expect(() => {
        verifyCourseAssistantDock(root)
      }).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies a patched profile and rejects an unpatched one', () => {
    const installed = installedProfile(PUBLISHED)
    try {
      expect(() => {
        verifyCourseAssistantDock(installed.profile)
      }).toThrow(/still renders its dock as a caption beside a link/u)
      patchCourseAssistantDock(installed.modules)
      expect(() => {
        verifyCourseAssistantDock(installed.profile)
      }).not.toThrow()
    } finally {
      rmSync(installed.profile, { recursive: true, force: true })
    }
  })
})
