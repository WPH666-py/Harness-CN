import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledPluginDependencies,
  bundledPluginNames,
  bundledPluginPackageNames,
} from '../src/bundled-plugins.ts'
import { DESKTOP_HOST_PACKAGE, DESKTOP_PACKAGES_DIR, DESKTOP_PACKAGE_SET_FILE } from '../src/core-package-set.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { createSeedMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'

const VISION_PLUGIN = '@lp181818/dsh-vision-plugin'
const VISION_PLUGIN_VERSION = '1.2.3'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundled-'))
  roots.push(root)
  return root
}

function release(version = '1.0.0'): DesktopRelease {
  return {
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.17.0',
    pnpmVersion: '11.7.0',
  }
}

function writeCorePackageSet(seed: string, version: string): void {
  const packages = [
    { name: '@deepseek-ai/dsh', file: `deepseek-ai-dsh-${version}.tgz`, body: Buffer.from(`dsh-${version}`) },
    {
      name: DESKTOP_HOST_PACKAGE,
      file: `deepseek-ai-dsh-desktop-host-${version}.tgz`,
      body: Buffer.from(`desktop-host-${version}`),
    },
  ]
  mkdirSync(join(seed, DESKTOP_PACKAGES_DIR), { recursive: true })
  for (const entry of packages) writeFileSync(join(seed, DESKTOP_PACKAGES_DIR, entry.file), entry.body)
  writeFileSync(join(seed, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify({
    schemaVersion: 1,
    packages: packages.map(({ name, file, body }) => ({
      name,
      version,
      file,
      bytes: body.byteLength,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    })),
  })}\n`)
}

function readSeedManifest(seed: string): {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  return JSON.parse(readFileSync(join(seed, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('bundled plugin set', () => {
  /**
   * The vision plugin's browser half declares `inject = ['slots', 'locale', 'configForms']` and
   * reads `ctx.configForms.get('vision-plugin')` before it registers anything. `configForms` is
   * a service only the 0.1.7-line Client provides, and Cordis leaves an unsatisfied service wait
   * pending with no timeout, so mounting its row fails the whole web boot with `web boot: N
   * entries did not activate` on the `Failed to load plugins` screen. It therefore stays
   * installed and pinned but unlisted; the entry in `src/bundled-plugins.ts` records why
   * providing the service or patching the bundle were rejected.
   */
  it('installs the vision plugin without listing it', () => {
    expect(bundledPluginNames()).not.toContain(VISION_PLUGIN)
    expect(bundledPluginPackageNames()).toContain(VISION_PLUGIN)
    expect(bundledPluginDependencies()[VISION_PLUGIN]).toBe(VISION_PLUGIN_VERSION)
  })

  /**
   * The seed manifest is what `applyRelease` copies into every profile, and its
   * `dsh.profile.bundles` list is the only thing that composes a bundled plugin's rows. Keeping
   * the package in `dependencies` while leaving it out of that list is what un-mounts it for a
   * fresh profile and for a rebuilt one, without uninstalling it.
   */
  it('leaves the vision plugin out of the seed bundle list but in its dependencies', () => {
    const seed = temporaryRoot()
    writeCorePackageSet(seed, '1.0.0')
    createSeedMetadata(seed, release())
    const manifest = readSeedManifest(seed)
    expect(manifest.dsh.profile.bundles).not.toContain(VISION_PLUGIN)
    expect(manifest.dependencies[VISION_PLUGIN]).toBe(VISION_PLUGIN_VERSION)
  })
})
