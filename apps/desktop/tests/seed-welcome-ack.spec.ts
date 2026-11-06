import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  seedWelcomeAcknowledgement,
  verifyWelcomeAcknowledgement,
} from '../scripts/seed-welcome-ack.mjs'

/** Version the client compares the acknowledgement against. */
const NOTICE_VERSION = '2026-09-28.1'

interface ProfilePatchRow {
  readonly id: string
  readonly name: string
  readonly config: Record<string, unknown>
}

const SCRIPT = resolve(import.meta.dirname, '../scripts/seed-welcome-ack.mjs')

describe('preview-notice acknowledgement seed', () => {
  const roots: string[] = []

  function seedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-welcome-ack-'))
    roots.push(root)
    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('writes the acknowledgement into the profile patch layer', () => {
    const root = seedRoot()
    seedWelcomeAcknowledgement(root)
    const rows = load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')) as ProfilePatchRow[]
    expect(rows).toEqual([{
      id: 'ui-settings-general',
      name: '@deepseek-ai/dsh-client-ui-settings-general',
      config: { welcomeNoticeVersion: NOTICE_VERSION },
    }])
  })

  it('reads the version the shipped client compares against', () => {
    // The seeder parses the client's own source, so this asserts the two stay one value.
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../packages/client/ui-settings-models/src/onboarding-copy.ts'),
      'utf8',
    )
    expect(source).toContain(`WELCOME_NOTICE_VERSION = '${NOTICE_VERSION}'`)
  })

  it('is idempotent and reports the second run as unchanged', () => {
    const root = seedRoot()
    seedWelcomeAcknowledgement(root)
    const before = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(seedWelcomeAcknowledgement(root)).toContain('already acknowledged')
    expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe(before)
  })

  it('refuses to overwrite a profile patch it does not recognize', () => {
    const root = seedRoot()
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: ui-chat\n')
    expect(() => seedWelcomeAcknowledgement(root)).toThrow(/exists without the welcomeNoticeVersion row/)
  })

  it('verification rejects a seed without the acknowledgement', () => {
    const root = seedRoot()
    expect(() => verifyWelcomeAcknowledgement(root)).toThrow(/missing the preview-notice acknowledgement/)
    seedWelcomeAcknowledgement(root)
    expect(() => verifyWelcomeAcknowledgement(root)).not.toThrow()
  })

  it('runs as a CLI that fails the check on an unseeded tree', () => {
    const seeded = seedRoot()
    const empty = seedRoot()
    seedWelcomeAcknowledgement(seeded)
    expect(execFileSync(process.execPath, [SCRIPT, seeded, '--check'], { encoding: 'utf8' })).toContain('"state":"patched"')
    expect(() => execFileSync(process.execPath, [SCRIPT, empty, '--check'], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/Command failed/)
  })
})
