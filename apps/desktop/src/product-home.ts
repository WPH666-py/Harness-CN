/**
 * Harness-CN's own Harness home.
 *
 * Harness-CN and the DSH desktop product both default to `~/.dsh`, so a machine that installs both
 * gives one home to two products: whichever writes `profiles/desktop` last wins, and the other
 * product's next launch pays a full runtime rebuild to replace a profile that the first product's
 * live process is still holding. Both Harness-CN shells therefore adopt `~/.harness-cn` before they
 * resolve any desktop path — this module owns that default, the adoption itself, and the one-time
 * copy of the Harness user data an earlier Harness-CN left in `~/.dsh`.
 *
 * An explicit `DSH_HOME` outranks the product default: a launch environment that names a home means
 * it. `@deepseek-ai/dsh-home-paths` stays the single owner of that precedence, so adoption writes
 * the default into the variable rather than resolving around the resolver.
 * @module
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory name of the Harness-CN home under the user's profile. */
export const HARNESS_CN_HOME_DIR_NAME = '.harness-cn'

/**
 * Environment variable that names a home for this product alone.
 *
 * `DSH_HOME` belongs to the DSH product and is commonly exported machine-wide, so a Harness-CN
 * launched from such a shell would adopt the shared home and then treat the other product's live
 * profile as its own. This variable is the one a user sets to move Harness-CN's home, and it
 * outranks everything else.
 */
export const HARNESS_CN_HOME_ENV = 'HARNESS_CN_HOME'

/**
 * Migration marker inside the Harness-CN home.
 *
 * Its presence is the record that the copy from the legacy home completed, so no later launch
 * repeats it. A migration whose copy failed deliberately leaves the marker unwritten.
 */
export const HARNESS_CN_MIGRATION_MARKER = 'home-migration.json'

/**
 * Top-level legacy entries the desktop project owns, which the migration must never copy.
 *
 * `desktop/` and `profiles/` are the runtime itself — a pnpm store, staging trees, and the linked
 * profile — `logs/` is per-run output, `recovery/` and `electron-user-data/` belong to the other
 * desktop product, and the compile cache is a cache. Copying those would move hundreds of megabytes
 * and hand the new home a profile that does not match the release it ships with.
 */
const RUNTIME_ENTRIES = new Set([
  'desktop',
  'profiles',
  'logs',
  'recovery',
  'electron-user-data',
  'node-compile-cache',
  'node_modules',
  'staging',
  'rollback',
])

/**
 * Top-level legacy files that carry Harness user data.
 *
 * Every other top-level file belongs to another product: `desktop-preferences.json` and
 * `desktop-locale.json`, for example, are written by the other desktop shell and read by nothing in
 * this repository.
 */
const USER_FILES = new Set(['.credentials.yaml', '.env', 'AGENTS.md', '.anonymous-user-id'])

/** Prefix of every artifact the other desktop product names inside a home the two products shared. */
const DESKTOP_NEXT_PREFIX = 'desktop-next'

/**
 * Default Harness-CN home, beside — never inside — the shared `~/.dsh`.
 * @returns the absolute `~/.harness-cn` path for the current user.
 */
export function defaultHarnessCnHome(): string {
  return join(homedir(), HARNESS_CN_HOME_DIR_NAME)
}

/**
 * Point this process, and every child that inherits its environment, at the Harness-CN home.
 *
 * The Host is spawned with this process's environment, so writing the variable is what keeps the
 * Host's sessions, storages, attachments, credentials, and profile under the same home as the
 * shell's runtime rather than under the shared one.
 * @param env - environment mapping to adopt the home into; defaults to `process.env`.
 * @param options - whether this launch is the packaged product.
 * @returns the resolved Harness-CN home.
 */
export function adoptHarnessCnHome(
  env: Record<string, string | undefined> = process.env,
  options: { readonly packaged?: boolean } = {},
): string {
  // A home this product names for itself is the whole answer, packaged or not.
  const own = env[HARNESS_CN_HOME_ENV]?.trim()
  if (own !== undefined && own.length > 0) {
    env[DSH_HOME_ENV] = own
    return resolveDshHome(undefined, env)
  }
  // A packaged launch does not inherit `DSH_HOME`: that variable is the other desktop product's,
  // machines commonly export it machine-wide, and obeying it made both products install into one
  // home — where Harness-CN's next launch tried to move a profile the other product was running.
  // Development and CLI launches keep honouring it, because there the variable is the developer's
  // own instruction rather than a neighbour's environment.
  const configured = env[DSH_HOME_ENV]?.trim()
  if (options.packaged !== true && configured !== undefined && configured.length > 0) {
    return resolveDshHome(undefined, env)
  }
  env[DSH_HOME_ENV] = defaultHarnessCnHome()
  return resolveDshHome(undefined, env)
}

/** What one migration attempt found and did. */
export interface HarnessCnHomeMigration {
  /**
   * `same-home` when the resolved home is the legacy default itself (an explicit `DSH_HOME`),
   * `already-migrated` when the marker is present, `no-legacy-home` when there is nothing to copy
   * from, `skipped-desktop-next` when the legacy home is not Harness-CN's alone, `copied` when every
   * eligible entry is now in the new home, and `partial` when at least one entry could not be copied.
   */
  readonly status: 'same-home' | 'already-migrated' | 'no-legacy-home' | 'skipped-desktop-next' | 'copied' | 'partial'
  /** The adopted Harness-CN home. */
  readonly home: string
  /** The legacy default home this migration looked at. */
  readonly legacyHome: string
  /** Legacy entry names copied during this attempt. */
  readonly entries: readonly string[]
  /** Legacy entry names that could not be copied during this attempt. */
  readonly failed: readonly string[]
  /** Other-product artifacts found in the legacy home; non-empty only for `skipped-desktop-next`. */
  readonly traces: readonly string[]
}

/**
 * Copy the Harness user data an earlier Harness-CN left in `~/.dsh` into the Harness-CN home, once.
 *
 * Only a launch whose new home has no marker does the copy, and only when the legacy home is
 * Harness-CN's alone: a legacy home carrying the other desktop product's artifacts still belongs to
 * that product, so Harness-CN starts with an empty home, says so in the run log, and leaves the
 * legacy data exactly as it is. The copy itself never overwrites an entry that already exists in the
 * new home and never writes, renames, or removes anything under the legacy home.
 * @param options - the adopted home and, for tests, the environment to resolve the legacy home in.
 * @param options.home - the adopted Harness-CN home.
 * @param options.env - environment used to resolve the legacy default home; defaults to `process.env`.
 * @returns what the attempt found, copied, and failed to copy.
 */
export function migrateLegacyHarnessHome(options: {
  readonly home: string
  readonly env?: Record<string, string | undefined>
}): HarnessCnHomeMigration {
  const env = options.env ?? process.env
  const home = resolve(options.home)
  // Resolving with the variable cleared answers what the home would have been before adoption, which
  // is the only way to tell an explicitly configured home from this product's own default.
  const legacyHome = resolveDshHome(undefined, { ...env, [DSH_HOME_ENV]: undefined })
  const outcome = (
    status: HarnessCnHomeMigration['status'],
    entries: readonly string[] = [],
    failed: readonly string[] = [],
    traces: readonly string[] = [],
  ): HarnessCnHomeMigration => ({ status, home, legacyHome, entries, failed, traces })

  if (home === legacyHome) return outcome('same-home')
  if (existsSync(join(home, HARNESS_CN_MIGRATION_MARKER))) return outcome('already-migrated')
  if (!existsSync(legacyHome)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    recordMigration(home, legacyHome, [], [])
    return outcome('no-legacy-home')
  }
  const traces = desktopNextTraces(legacyHome)
  if (traces.length > 0) return outcome('skipped-desktop-next', [], [], traces)

  mkdirSync(home, { recursive: true, mode: 0o700 })
  const { entries, failed } = copyLegacyUserData(legacyHome, home)
  // A failed entry keeps the marker away so the next launch retries what is still missing, and the
  // entries already copied are skipped then because their destination exists.
  if (failed.length === 0) recordMigration(home, legacyHome, entries, failed)
  return outcome(failed.length > 0 ? 'partial' : 'copied', entries, failed)
}

/**
 * Turn one migration result into the run-log lines that explain it.
 *
 * A user who wonders where their sessions and API key went reads which home this launch adopted and
 * why the legacy data stayed behind.
 * @param migration - the result of {@link migrateLegacyHarnessHome}.
 * @returns the lines to append to the run log, in reading order.
 */
export function describeHomeMigration(migration: HarnessCnHomeMigration): readonly string[] {
  const where = `home: ${migration.home}`
  switch (migration.status) {
    case 'same-home':
      return [`${where}; DSH_HOME is configured, so no legacy home is migrated`]
    case 'already-migrated':
      return [`${where}; legacy data from ${migration.legacyHome} was already migrated`]
    case 'no-legacy-home':
      return [`${where}; no legacy home at ${migration.legacyHome}`]
    case 'skipped-desktop-next':
      return [
        `${where}; ${migration.legacyHome} also carries the DSH desktop product`,
        `home: leaving ${migration.legacyHome} untouched (${migration.traces.join(', ')})`,
      ]
    case 'copied':
      return [`${where}; migrated ${String(migration.entries.length)} entr${migration.entries.length === 1 ? 'y' : 'ies'} from ${migration.legacyHome}: ${migration.entries.join(', ')}`]
    case 'partial':
      return [
        `${where}; migrated ${migration.entries.join(', ')} from ${migration.legacyHome}`,
        `home: could not copy ${migration.failed.join(', ')}; the next launch retries them`,
      ]
    default:
      return migration.status satisfies never
  }
}

/**
 * Copy the eligible top-level entries of one legacy home into the new home.
 *
 * The copy is additive: an entry whose destination already exists is this home's own state and stays
 * untouched, so an interrupted migration converges instead of overwriting newer data.
 * @param legacyHome - the shared home an earlier Harness-CN used.
 * @param home - the adopted Harness-CN home.
 * @returns the names copied now and the names that could not be copied.
 */
function copyLegacyUserData(legacyHome: string, home: string): { entries: string[]; failed: string[] } {
  const entries: string[] = []
  const failed: string[] = []
  for (const entry of readdirSync(legacyHome, { withFileTypes: true })) {
    const name = entry.name
    if (name.startsWith(DESKTOP_NEXT_PREFIX)) continue
    if (entry.isDirectory()) {
      if (RUNTIME_ENTRIES.has(name)) continue
    } else if (!USER_FILES.has(name)) continue
    const destination = join(home, name)
    if (existsSync(destination)) continue
    try {
      cpSync(join(legacyHome, name), destination, {
        recursive: entry.isDirectory(),
        errorOnExist: false,
        force: false,
      })
      entries.push(name)
    } catch {
      // Names what it swallows: a legacy entry that a live process still holds open cannot be copied
      // during this launch. The caller withholds the marker for this outcome, so the next launch
      // retries exactly the entries whose destination is still missing.
      failed.push(name)
    }
  }
  return { entries, failed }
}

/**
 * Find the other desktop product's artifacts in a legacy home.
 *
 * A home both products have used is the one case the migration refuses, and these names are what
 * proves it: its log files, its profile patch files, and the profile manifest it rewrites with its
 * own keys. The check reads only names and one small manifest, so it never walks the 30k-file
 * profile behind them.
 * @param legacyHome - the home to inspect.
 * @returns the absolute paths of the artifacts found, in inspection order.
 */
function desktopNextTraces(legacyHome: string): string[] {
  const traces: string[] = []
  const logs = join(legacyHome, 'logs')
  if (existsSync(logs)) {
    for (const name of readdirSync(logs)) {
      if (name.startsWith(DESKTOP_NEXT_PREFIX)) traces.push(join(logs, name))
    }
  }
  const profile = join(legacyHome, 'profiles', 'desktop')
  if (existsSync(profile)) {
    for (const name of readdirSync(profile)) {
      if (name.startsWith(DESKTOP_NEXT_PREFIX)) traces.push(join(profile, name))
    }
    const manifest = join(profile, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (readFileSync(manifest, 'utf8').includes('desktopNext')) traces.push(manifest)
      } catch {
        // Names what it swallows: a profile manifest that cannot be read cannot prove the other
        // product is absent, and the migration treats that as its artifact rather than copying into
        // a home it could not classify.
        traces.push(manifest)
      }
    }
  }
  return traces
}

/**
 * Record a completed migration in the new home.
 * @param home - the adopted Harness-CN home.
 * @param legacyHome - the home the data came from.
 * @param entries - entry names copied.
 * @param failed - entry names that could not be copied.
 */
function recordMigration(home: string, legacyHome: string, entries: readonly string[], failed: readonly string[]): void {
  const document = { schemaVersion: 1, migratedAt: new Date().toISOString(), legacyHome, entries, failed }
  writeFileSync(join(home, HARNESS_CN_MIGRATION_MARKER), `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
}
