/** Build the release seed through the same embedded pnpm used on first launch. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSeedMetadata } from '../src/project-manager.ts'
import { BUNDLED_PLUGIN_ARCHIVE_DIR, bundledPluginArchives } from '../src/bundled-plugins.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import {
  archiveLinkedProfile,
  archivePnpmStore,
  extractPnpmStoreArchives,
  materializeLinkedProfile,
  removePnpmProjectRegistrations,
  removePnpmStagingDirectories,
} from '../src/seed-store.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSSeedStore,
  verifyMacOSSeedStore,
} from './macos-seed-store.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const SEED_OUTPUT_ROOT = BUILD_PATHS.seed
const SEED_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-'))
const STORE_ROOT = join(SEED_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.seedPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(RUNTIME_ROOT, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop seed: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop seed: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop seed: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      PNPM,
      '--config.registry=https://registry.npmmirror.com/',
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: SEED_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com/',
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

function patchInstalledRuleEngine(root: string): Promise<void> {
  // `compress` is an official DSH tool the installed engine does not classify, and the engine
  // denies every tool it cannot classify, so a fresh profile loses that tool until a human
  // grants it. Patching the installed table here is what makes the fix permanent: the patched
  // bytes go into the archived store, and every profile later materialized from this seed
  // carries them. See scripts/patch-rule-engine.mjs for why this cannot be configuration.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-rule-engine.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: rule-engine patch exited with ${String(code ?? signal)}`))
    })
  })
}

function patchInstalledWeChatSessions(root: string): Promise<void> {
  // dsh-wechat builds every WeChat-bound session with a setup callback that reads the agent off the
  // setup context, which Cordis rejects, so each message ends in 「无法创建/恢复 DSH 会话」. Patching
  // the installed bytes here is what makes the fix permanent: the corrected module goes into the
  // archived store, and every profile later materialized from this seed carries it. See
  // scripts/patch-wechat-sessions.mjs for why this cannot be configuration.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-wechat-sessions.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: wechat session patch exited with ${String(code ?? signal)}`))
    })
  })
}

/** Read the agent setup back out of the installed dsh-wechat in a tree the seed produced. */
async function verifyWeChatSessionsPatch(root: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-wechat-sessions.mjs')
  const module = await import(pathToFileURL(script).href) as { verifyWeChatSessions?: (tree: string) => string }
  if (typeof module.verifyWeChatSessions !== 'function') {
    throw new Error(`desktop seed: ${script} does not export verifyWeChatSessions`)
  }
  module.verifyWeChatSessions(root)
}

function patchInstalledWorkBuddyModelNull(root: string): Promise<void> {
  // The WorkBuddy control reads the model selection, which is null before one is chosen, and the
  // shipped bundle tests only for undefined: the conversation input row crashed on first render.
  // Patching the installed bytes here puts the guard in the archived store, so every profile later
  // materialized from this seed carries it. See scripts/patch-workbuddy-model-null.mjs.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-workbuddy-model-null.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: workbuddy model-guard patch exited with ${String(code ?? signal)}`))
    })
  })
}

function patchInstalledRemoteSshEmptyState(root: string): Promise<void> {
  // The remote-SSH picker renders an empty host list with the text `正在加载服务器…`, so a machine with
  // no server looks like one that is still connecting. Patching the installed bytes here puts the
  // replacement in the archived store, and every profile materialized from this seed carries it.
  // See scripts/patch-remote-ssh-empty-state.mjs.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-remote-ssh-empty-state.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: remote-ssh empty-state patch exited with ${String(code ?? signal)}`))
    })
  })
}
function patchInstalledQqbotConsole(root: string): Promise<void> {
  // The shell's QQ console window hides everything but the plugin's dock panel and then calls
  // `window.__qqbotOpenConsole()`; the shipped bundle has no such entry point, so an unpatched seed
  // produces a blank window. See scripts/patch-qqbot-console.mjs.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-qqbot-console.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: qqbot console patch exited with ${String(code ?? signal)}`))
    })
  })
}
function patchInstalledVoiceModeFocus(root: string): Promise<void> {
  // The voice plugin's focus route rejects any Session the Host has not opened yet, so the page's
  // first claim after a freshly materialized profile always missed and every start logged a
  // `/voice-mode/focus … 403 (Forbidden)` in the browser console. Patching the installed bytes here
  // puts the fix in the archived store, so every profile later materialized from this seed carries
  // it. See scripts/patch-voice-mode-focus.mjs for why this cannot be configuration.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-voice-mode-focus.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: voice-mode focus patch exited with ${String(code ?? signal)}`))
    })
  })
}

function patchInstalledWeChatIdentity(root: string): Promise<void> {
  // WeChat's contact name for the bot belongs to Tencent's iLink platform, so the only name this
  // product controls is the one the bridge chats under: the built-in surface prompt the plugin
  // injects for every WeChat-bound session. Naming the installed bytes here puts that name in the
  // archived store, and every profile later materialized from this seed carries it. See
  // scripts/patch-wechat-identity.mjs for why this cannot be configuration.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, [join(APP_ROOT, 'scripts', 'patch-wechat-identity.mjs'), root], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: wechat identity patch exited with ${String(code ?? signal)}`))
    })
  })
}

/** Read the bridge's name back out of the installed dsh-wechat in a tree the seed produced. */
async function verifyWeChatIdentityPatch(root: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-wechat-identity.mjs')
  const module = await import(pathToFileURL(script).href) as { verifyWeChatIdentity?: (tree: string) => string }
  if (typeof module.verifyWeChatIdentity !== 'function') {
    throw new Error(`desktop seed: ${script} does not export verifyWeChatIdentity`)
  }
  module.verifyWeChatIdentity(root)
}

/** Require the empty-state replacement in a tree the seed produced. */
async function verifyRemoteSshEmptyState(root: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-remote-ssh-empty-state.mjs')
  const module = await import(pathToFileURL(script).href) as { verifyRemoteSshEmptyState?: (tree: string) => string[] }
  if (typeof module.verifyRemoteSshEmptyState !== 'function') {
    throw new Error(`desktop seed: ${script} does not export verifyRemoteSshEmptyState`)
  }
  module.verifyRemoteSshEmptyState(root)
}
/** Read the engine's classification table back out of a tree the seed produced. */
/** Require the WorkBuddy model-selection guard in a tree the seed produced. */
async function verifyWorkBuddyModelNull(root: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-workbuddy-model-null.mjs')
  const module = await import(pathToFileURL(script).href) as { verifyWorkBuddyModelNull?: (tree: string) => void }
  if (typeof module.verifyWorkBuddyModelNull !== 'function') {
    throw new Error(`desktop seed: ${script} does not export verifyWorkBuddyModelNull`)
  }
  module.verifyWorkBuddyModelNull(root)
}

/** Require the voice-mode focus patch in a tree the seed produced. */
async function verifyVoiceModeFocus(root: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-voice-mode-focus.mjs')
  const module = await import(pathToFileURL(script).href) as { verifyVoiceModeFocus?: (tree: string) => void }
  if (typeof module.verifyVoiceModeFocus !== 'function') {
    throw new Error(`desktop seed: ${script} does not export verifyVoiceModeFocus`)
  }
  module.verifyVoiceModeFocus(root)
}

async function verifyRuleEnginePatch(root: string): Promise<void> {
  const catalog = join(root, 'node_modules', 'dsh-rule-engine', 'lib', 'core', 'tool-catalog.js')
  if (!existsSync(catalog)) {
    throw new Error('desktop seed: the profile the seed produced has no dsh-rule-engine tool catalog')
  }
  const module = await import(pathToFileURL(catalog).href) as { toolClass?: (name: string, args: unknown) => string }
  if (typeof module.toolClass !== 'function') {
    throw new Error(`desktop seed: ${catalog} does not export toolClass`)
  }
  if (module.toolClass('compress', {}) !== 'artifact') {
    throw new Error(`desktop seed: the seed classifies compress as ${module.toolClass('compress', {})}`)
  }
}

function inventory(root: string): readonly { path: string; bytes: number; sha256: string }[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`desktop seed: unsupported filesystem entry ${relative(root, path)}`)
    }
  }
  visit(root)
  return files.sort().map((path) => {
    const body = readFileSync(path)
    return {
      path: relative(root, path).split(sep).join('/'),
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  })
}

async function verifyOfflineInstallation(release: DesktopRelease): Promise<void> {
  // The first launch rebuilds the profile from the seed's link manifest instead of running
  // pnpm, so that is what this proves: the recorded links resolve against the archived store
  // and produce a tree that can boot the packaged Host.
  const materialized = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-profile-'))
  try {
    await materializeLinkedProfile(SEED_ROOT, materialized, STORE_ROOT, materialized)
    const hostRoot = join(materialized, 'node_modules', ...DESKTOP_HOST_PACKAGE.split('/'))
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(hostRoot, file))) {
        throw new Error(`desktop seed: local ${DESKTOP_HOST_PACKAGE}@${release.version} does not contain ${file}`)
      }
    }
    // Same tree, different question: the archived store has to produce the patched table too, or
    // only the machine that built the release would have it.
    await verifyRuleEnginePatch(materialized)
    // And the WeChat bridge has to come out of the archived store able to create a session.
    await verifyWeChatSessionsPatch(materialized)
    // And it has to come out of it answering to this product's name.
    await verifyWeChatIdentityPatch(materialized)
    // A store archive that missed the guard would crash the conversation input on first render.
    await verifyWorkBuddyModelNull(materialized)
await verifyRemoteSshEmptyState(materialized)
    // A store archive that missed it would log a rejected focus claim on every start.
    await verifyVoiceModeFocus(materialized)
  } finally {
    rmSync(materialized, { recursive: true, force: true })
  }
}

/**
 * Copy the archives a bundled plugin's `file:` spec names into the seed profile.
 *
 * The release ships those archives beside the application instead of on a registry, so the
 * seed's own install has to see them at the relative path the manifest records. A missing
 * archive fails here rather than on a user's first launch.
 * @param seedRoot - the profile directory the seed is assembled in.
 */
function copyPluginArchives(seedRoot: string): void {
  const archives = bundledPluginArchives()
  if (archives.length === 0) return
  const source = resolve(APP_ROOT, '..', 'desktop-shell', 'src-tauri', 'resources', BUNDLED_PLUGIN_ARCHIVE_DIR)
  const target = join(seedRoot, BUNDLED_PLUGIN_ARCHIVE_DIR)
  mkdirSync(target, { recursive: true })
  for (const name of archives) {
    const from = join(source, name)
    if (!existsSync(from)) throw new Error(`desktop seed: bundled plugin archive ${name} is missing from ${source}`)
    copyFileSync(from, join(target, name))
  }
}
async function main(): Promise<void> {
  rmSync(SEED_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(SEED_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(SEED_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createSeedMetadata(SEED_ROOT, release)
    copyPluginArchives(SEED_ROOT)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(SEED_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(SEED_ROOT, release.version),
    )
    const installedModules = join(SEED_ROOT, 'node_modules')
    // The seed now ships the installed tree itself, so it has to be the tree the runtime
    // expects: package lifecycle scripts provision node-pty's conpty pair and the spawn
    // helper, and an install that skipped them would ship a profile those packages cannot
    // load from.
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile', '--config.strict-dep-builds=false'])
    /**
 * Apply this release's plugin add/remove decisions to the seed before it is archived.
 *
 * The profile a user runs is materialized from the seed, so a plugin installed or removed only in a
 * live profile is undone by the next runtime install. See scripts/patch-seed-plugins.mjs for why the
 * change is made with the package manager and not by editing manifests.
 */
async function applySeedPluginPatches(seedRoot: string): Promise<void> {
  const script = join(APP_ROOT, 'scripts', 'patch-seed-plugins.mjs')
  const module = await import(pathToFileURL(script).href) as { patchSeedPlugins?: (root: string) => { removed: string[]; added: string[] } }
  if (typeof module.patchSeedPlugins !== 'function') {
    throw new Error(`desktop seed: ${script} does not export patchSeedPlugins`)
  }
  const result = module.patchSeedPlugins(seedRoot)
  console.log(`desktop seed: plugins removed [${result.removed.join(', ')}], added [${result.added.join(', ')}]`)
}
await patchInstalledRuleEngine(join(SEED_ROOT, 'node_modules'))
    await patchInstalledWeChatSessions(join(SEED_ROOT, 'node_modules'))
    await patchInstalledWeChatIdentity(join(SEED_ROOT, 'node_modules'))
  await patchInstalledWorkBuddyModelNull(join(SEED_ROOT, 'node_modules'))
await patchInstalledRemoteSshEmptyState(join(SEED_ROOT, 'node_modules'))
await patchInstalledQqbotConsole(join(SEED_ROOT, 'node_modules'))
await patchInstalledVoiceModeFocus(installedModules)
await applySeedPluginPatches(SEED_ROOT)
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
    const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
    let signedMachOFiles: number | undefined
    let macOSSigning: ReturnType<typeof resolveMacOSSigningEnvironment> | undefined
    if (targetPlatform === 'darwin') {
      macOSSigning = resolveMacOSSigningEnvironment(process.env)
      const signing = await signMacOSSeedStore(
        STORE_ROOT,
        resolveDesktopAppId(process.env),
        macOSSigning,
      )
      signedMachOFiles = signing.signedFiles
      process.stdout.write(
        `desktop seed: signed ${signing.signedFiles} Mach-O files, updated ${signing.updatedIndexRows} pnpm index records, and pruned ${signing.prunedOrphans} native orphans\n`,
      )
    }
    // Signing and registration cleanup both rewrite the store, so the profile is described
    // against the store only once it is final; a link recorded earlier could dangle.
    removePnpmProjectRegistrations(STORE_ROOT)
    // A git dependency's packed tree stays under the store's `tmp`, hard-linked to store content,
    // and tar would record it as an entry the first launch refuses; a profile never links to it.
    removePnpmStagingDirectories(STORE_ROOT)
    const archived = archiveLinkedProfile(SEED_ROOT, STORE_ROOT, SEED_ROOT)
    process.stdout.write(
      `desktop seed: recorded ${archived.linkedFiles} profile files as store links,`
      + ` archived ${archived.archivedFiles} files and ${archived.archivedDirectories} directories\n`,
    )
    rmSync(installedModules, { recursive: true, force: true })
    await verifyOfflineInstallation(release)
    archivePnpmStore(SEED_ROOT, STORE_ROOT)
    if (macOSSigning !== undefined && signedMachOFiles !== undefined) {
      const extractedStore = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-verification-'))
      try {
        await extractPnpmStoreArchives(SEED_ROOT, extractedStore)
        const verified = verifyMacOSSeedStore(extractedStore, macOSSigning)
        if (verified !== signedMachOFiles) {
          throw new Error(`desktop seed: archived store contains ${verified} signed Mach-O files; expected ${signedMachOFiles}`)
        }
      } finally {
        rmSync(extractedStore, { recursive: true, force: true })
      }
    }
    const records = inventory(SEED_ROOT).filter(entry => entry.path !== 'integrity.json')
    writeFileSync(join(SEED_ROOT, 'integrity.json'), `${JSON.stringify({ schemaVersion: 2, files: records }, undefined, 2)}\n`)
    cpSync(SEED_ROOT, SEED_OUTPUT_ROOT, { recursive: true })
  } finally {
    rmSync(SEED_ROOT, { recursive: true, force: true })
  }
}

await main()
