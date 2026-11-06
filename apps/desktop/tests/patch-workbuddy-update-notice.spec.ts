import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasUpdateNoticePatch,
  patchClientSource,
  patchWorkBuddyUpdateNotice,
  verifyWorkBuddyUpdateNotice,
} from '../scripts/patch-workbuddy-update-notice.mjs'

/**
 * The published client, reduced to the lines the patch anchors on: the card's account heading, the
 * mount-time release check, the plugin-card slot injection, and both locale dictionaries.
 */
const PUBLISHED = [
  'function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT }) {',
  '\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {',
  '\t\tstyle: cardBodyStyle,',
  '\t\tchildren: [',
  '\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {',
  '\t\t\t\tstyle: quotaTitleStyle,',
  '\t\t\t\tchildren: t("accountHeading")',
  '\t\t\t}),',
  '\t\t\t"body"',
  '\t\t]',
  '\t});',
  '}',
  '',
  'function apply(ctx) {',
  '\tctx.effect(() => {',
  '\t\tupdater.refresh();',
  '\t\treturn () => {',
  '\t\t\tupdater.dispose();',
  '\t\t};',
  '\t}, "dsh-workbuddy-connect: update checker");',
  '\tctx.slots.register({',
  '\t\tname: "settings.plugin.item",',
  '\t\tkey: variant.id,',
  '\t\tpriority: 30 - index,',
  '\t\tinject: () => ({',
  '\t\t\tt,',
  '\t\t\tvariant',
  '\t\t})',
  '\t}, WorkBuddyPluginCard);',
  '}',
  '',
  'const zh = {',
  '\trefresh: "刷新",',
  '\trefreshing: "正在刷新…",',
  '};',
  'const en = {',
  '\trefresh: "Refresh",',
  '\trefreshing: "Refreshing…",',
  '};',
  '',
].join('\n')

const PACKAGE = 'dsh-workbuddy-connect'

describe('dsh-workbuddy-connect update notice patch', () => {
  const roots: string[] = []

  function tree(source: string): { profile: string, modules: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-workbuddy-notice-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const modules = join(profile, 'node_modules')
    mkdirSync(join(modules, PACKAGE, 'lib'), { recursive: true })
    writeFileSync(join(modules, PACKAGE, 'lib', 'client.js'), source, 'utf8')
    return { profile, modules }
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('removes the launch-time check but keeps the store teardown', () => {
    const patched = patchClientSource(PUBLISHED)
    expect(patched).not.toMatch(/^\t*updater\.refresh\(\);$/m)
    expect(patched).toContain('updater.dispose();')
    expect(patched).toContain('"dsh-workbuddy-connect: update checker"')
  })

  it('moves the check behind a button in the plugin card', () => {
    const patched = patchClientSource(PUBLISHED)
    expect(patched).toContain('function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT, updater })')
    expect(patched).toContain('t("updateCheckHeading")')
    expect(patched).toContain('t("checkUpdates")')
    expect(patched).toContain('void updater?.refresh(true);')
    // The card still renders its account heading and the plugin-item slot still knows the variant.
    expect(patched).toContain('children: t("accountHeading")')
    expect(patched).toContain('key: variant.id,')
  })

  it('hands the store to the card through the slot injection', () => {
    const patched = patchClientSource(PUBLISHED)
    expect(patched).toMatch(/inject: \(\) => \(\{\n\t+t,\n\t+variant,\n\t+updater\n\t+\}\)/)
  })

  it('names the new controls in both locales', () => {
    const patched = patchClientSource(PUBLISHED)
    expect(patched).toContain('checkUpdates: "Check for updates",')
    expect(patched).toContain('updateCheckHeading: "Plugin updates",')
    expect(patched).toContain('checkUpdates: "检查更新",')
    expect(patched).toContain('updateCheckHeading: "插件更新",')
    expect(patched).toContain('refreshing: "Refreshing…",')
  })

  it('refuses a client whose anchors moved', () => {
    expect(() => patchClientSource(PUBLISHED.replace('children: t("accountHeading")', 'children: t("accountTitle")')))
      .toThrow(/the plugin changed/)
  })

  it('patches an installed package once and verifies the materialized profile', () => {
    const { profile, modules } = tree(PUBLISHED)
    expect(patchWorkBuddyUpdateNotice(modules)).toContain('patched')
    const once = readFileSync(join(modules, PACKAGE, 'lib', 'client.js'), 'utf8')
    expect(hasUpdateNoticePatch(once)).toBe(true)
    expect(patchWorkBuddyUpdateNotice(modules)).toContain('already patched')
    expect(readFileSync(join(modules, PACKAGE, 'lib', 'client.js'), 'utf8')).toBe(once)
    expect(() => verifyWorkBuddyUpdateNotice(profile)).not.toThrow()
  })

  it('verification rejects a tree that would still check at launch', () => {
    const { profile } = tree(PUBLISHED)
    expect(() => verifyWorkBuddyUpdateNotice(profile)).toThrow(/still checks for its own update at launch/)
  })
})
