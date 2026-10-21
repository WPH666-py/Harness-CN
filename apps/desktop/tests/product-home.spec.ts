import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adoptHarnessCnHome,
  defaultHarnessCnHome,
  describeHomeMigration,
  HARNESS_CN_MIGRATION_MARKER,
  migrateLegacyHarnessHome,
} from '../src/product-home.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-product-home-'))
  roots.push(root)
  return root
}

/**
 * Run one operation with the operating system's home pointing at a temporary directory.
 *
 * The legacy home is the platform default, which `os.homedir()` reads from the environment on every
 * call, so redirecting the environment is what keeps a test away from the developer's real `~/.dsh`.
 * @param root - directory to treat as the user's home.
 * @param operation - operation to run under that home.
 * @returns whatever the operation returned.
 */
function withUserHome<T>(root: string, operation: () => T): T {
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = root
  process.env.HOME = root
  try {
    return operation()
  } finally {
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.USERPROFILE
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
  }
}

/** Create one legacy home below `root` and return its path. */
function legacyHome(root: string): string {
  const home = join(root, '.dsh')
  mkdirSync(home, { recursive: true })
  return home
}

/** Write one file, creating its parent directories. */
function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('adoptHarnessCnHome', () => {
  it('fills in the product home and leaves an explicitly configured one alone', () => {
    const root = temporaryRoot()
    withUserHome(root, () => {
      const empty: Record<string, string | undefined> = {}
      expect(adoptHarnessCnHome(empty)).toBe(resolve(defaultHarnessCnHome()))
      expect(empty.DSH_HOME).toBe(defaultHarnessCnHome())

      const blank: Record<string, string | undefined> = { DSH_HOME: '   ' }
      expect(adoptHarnessCnHome(blank)).toBe(resolve(defaultHarnessCnHome()))
      expect(blank.DSH_HOME).toBe(defaultHarnessCnHome())

      const chosen = join(root, 'chosen-home')
      const explicit: Record<string, string | undefined> = { DSH_HOME: chosen }
      expect(adoptHarnessCnHome(explicit)).toBe(resolve(chosen))
      expect(explicit.DSH_HOME).toBe(chosen)
    })
  })

  it('names a home beside, not inside, the shared one', () => {
    const root = temporaryRoot()
    withUserHome(root, () => {
      expect(defaultHarnessCnHome()).toBe(join(root, '.harness-cn'))
    })
  })

  it('ignores an inherited DSH_HOME in a packaged launch', () => {
    const root = temporaryRoot()
    withUserHome(root, () => {
      // The other desktop product exports DSH_HOME machine-wide; a packaged Harness-CN must not
      // adopt that home and start moving a profile it does not own.
      const shared: Record<string, string | undefined> = { DSH_HOME: join(root, '.dsh') }
      expect(adoptHarnessCnHome(shared, { packaged: true })).toBe(resolve(defaultHarnessCnHome()))
      expect(shared.DSH_HOME).toBe(defaultHarnessCnHome())
    })
  })

  it('lets HARNESS_CN_HOME move the packaged home and outranks DSH_HOME', () => {
    const root = temporaryRoot()
    withUserHome(root, () => {
      const chosen = join(root, 'own-home')
      const env: Record<string, string | undefined> = { DSH_HOME: join(root, '.dsh'), HARNESS_CN_HOME: chosen }
      expect(adoptHarnessCnHome(env, { packaged: true })).toBe(resolve(chosen))
      expect(env.DSH_HOME).toBe(chosen)
      const blank: Record<string, string | undefined> = { HARNESS_CN_HOME: '  ' }
      expect(adoptHarnessCnHome(blank, { packaged: true })).toBe(resolve(defaultHarnessCnHome()))
    })
  })
})

describe('migrateLegacyHarnessHome', () => {
  it('records an absent legacy home without writing a marker into the shared one', () => {
    const root = temporaryRoot()
    const home = join(root, '.harness-cn')
    withUserHome(root, () => {
      const first = migrateLegacyHarnessHome({ home, env: {} })
      expect(first.status).toBe('no-legacy-home')
      expect(first.legacyHome).toBe(join(root, '.dsh'))
      expect(existsSync(join(home, HARNESS_CN_MIGRATION_MARKER))).toBe(true)

      expect(migrateLegacyHarnessHome({ home, env: {} }).status).toBe('already-migrated')
    })
  })

  it('does nothing when the configured home is the legacy home itself', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    write(join(shared, 'sessions', 'one', 'log.json'), '{}')
    withUserHome(root, () => {
      const migration = migrateLegacyHarnessHome({ home: shared, env: { DSH_HOME: shared } })
      expect(migration.status).toBe('same-home')
      expect(existsSync(join(shared, HARNESS_CN_MIGRATION_MARKER))).toBe(false)
      expect(existsSync(join(shared, 'desktop', 'seed'))).toBe(false)
    })
  })

  it('copies Harness user data and leaves every runtime tree behind', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    write(join(shared, 'sessions', '--workspace--', 'log.json'), '{"session":true}')
    write(join(shared, 'storages', 'workspace.json'), '{"workspace":true}')
    write(join(shared, 'attachments', 'v1', 'blob.bin'), 'attachment')
    write(join(shared, '.credentials.yaml'), 'key: secret\n')
    write(join(shared, '.env'), 'DSH_SOMETHING=1\n')
    write(join(shared, 'desktop', 'pnpm', 'store', 'marker'), 'store')
    write(join(shared, 'profiles', 'desktop', 'package.json'), '{"name":"dsh-profile-desktop"}\n')
    write(join(shared, 'desktop-preferences.json'), '{"closeToTray":true}\n')
    write(join(shared, 'desktop-locale.json'), '{"desktop":"zh"}\n')
    const home = join(root, '.harness-cn')
    withUserHome(root, () => {
      const migration = migrateLegacyHarnessHome({ home, env: {} })
      expect(migration.status).toBe('copied')
      expect([...migration.entries].sort()).toEqual(['.credentials.yaml', '.env', 'attachments', 'sessions', 'storages'])
      expect(migration.failed).toEqual([])

      expect(readFileSync(join(home, 'sessions', '--workspace--', 'log.json'), 'utf8')).toBe('{"session":true}')
      expect(readFileSync(join(home, 'attachments', 'v1', 'blob.bin'), 'utf8')).toBe('attachment')
      expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toBe('key: secret\n')
      expect(existsSync(join(home, 'desktop'))).toBe(false)
      expect(existsSync(join(home, 'profiles'))).toBe(false)
      expect(existsSync(join(home, 'desktop-preferences.json'))).toBe(false)
      expect(existsSync(join(home, 'desktop-locale.json'))).toBe(false)

      // The legacy home stays exactly as it was: the copy is what migration may do, never a move.
      expect(readFileSync(join(shared, '.credentials.yaml'), 'utf8')).toBe('key: secret\n')
      expect(existsSync(join(shared, 'desktop', 'pnpm', 'store', 'marker'))).toBe(true)
      expect(readFileSync(join(shared, 'profiles', 'desktop', 'package.json'), 'utf8')).toContain('dsh-profile-desktop')

      const marker = JSON.parse(readFileSync(join(home, HARNESS_CN_MIGRATION_MARKER), 'utf8')) as {
        schemaVersion: number
        legacyHome: string
        entries: string[]
      }
      expect(marker.schemaVersion).toBe(1)
      expect(marker.legacyHome).toBe(shared)
      expect([...marker.entries].sort()).toEqual(['.credentials.yaml', '.env', 'attachments', 'sessions', 'storages'])
    })
  })

  it('keeps the new home authoritative over the copied one', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    write(join(shared, '.credentials.yaml'), 'legacy\n')
    write(join(shared, 'storages', 'workspace.json'), 'legacy\n')
    const home = join(root, '.harness-cn')
    write(join(home, '.credentials.yaml'), 'current\n')
    withUserHome(root, () => {
      const migration = migrateLegacyHarnessHome({ home, env: {} })
      expect(migration.status).toBe('copied')
      expect(migration.entries).toEqual(['storages'])
      expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toBe('current\n')
      expect(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).toBe('legacy\n')
    })
  })

  it('leaves a home the other desktop product also uses entirely alone', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    write(join(shared, 'sessions', 'one', 'log.json'), '{}')
    write(join(shared, '.credentials.yaml'), 'key: secret\n')
    write(join(shared, 'logs', 'desktop-next.log'), 'other product\n')
    const home = join(root, '.harness-cn')
    withUserHome(root, () => {
      const migration = migrateLegacyHarnessHome({ home, env: {} })
      expect(migration.status).toBe('skipped-desktop-next')
      expect(migration.traces).toEqual([join(shared, 'logs', 'desktop-next.log')])
      expect(migration.entries).toEqual([])
      // Nothing is copied, no marker claims the home is Harness-CN's, and the next launch re-reads it.
      expect(existsSync(home)).toBe(false)
      expect(readFileSync(join(shared, '.credentials.yaml'), 'utf8')).toBe('key: secret\n')
      expect(migrateLegacyHarnessHome({ home, env: {} }).status).toBe('skipped-desktop-next')
    })
  })

  it('recognizes the other product in the profile manifest it rewrites', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    const manifest = join(shared, 'profiles', 'desktop', 'package.json')
    write(manifest, '{"name":"dsh-profile-desktop","dsh":{"desktopNextPlugins":1}}\n')
    write(join(shared, '.credentials.yaml'), 'key: secret\n')
    const home = join(root, '.harness-cn')
    withUserHome(root, () => {
      const migration = migrateLegacyHarnessHome({ home, env: {} })
      expect(migration.status).toBe('skipped-desktop-next')
      expect(migration.traces).toContain(manifest)
      expect(existsSync(home)).toBe(false)
    })
  })

  it('explains what it did and what it refused to touch', () => {
    const root = temporaryRoot()
    const shared = legacyHome(root)
    write(join(shared, 'sessions', 'one', 'log.json'), '{}')
    write(join(shared, 'logs', 'desktop-next.log'), 'other product\n')
    const home = join(root, '.harness-cn')
    withUserHome(root, () => {
      const skipped = migrateLegacyHarnessHome({ home, env: {} })
      const skippedLines = describeHomeMigration(skipped)
      expect(skippedLines[0]).toContain(home)
      expect(skippedLines[1]).toContain('leaving')
      expect(skippedLines[1]).toContain('desktop-next.log')

      rmSync(join(shared, 'logs', 'desktop-next.log'))
      const copied = migrateLegacyHarnessHome({ home, env: {} })
      expect(copied.status).toBe('copied')
      expect(describeHomeMigration(copied)[0]).toContain('sessions')
      expect(describeHomeMigration(copied)[0]).toContain('1 entry')
    })
  })
})
