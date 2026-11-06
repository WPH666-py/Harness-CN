import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIRST_LAUNCH_MARKER, recordFirstLaunch } from '../src/first-launch.ts'

describe('first-launch marker', () => {
  const roots: string[] = []

  function root(): string {
    const created = mkdtempSync(join(tmpdir(), 'dsh-first-launch-'))
    roots.push(created)
    return created
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('suppresses the automatic check once and only once', () => {
    const directory = root()
    const notes: string[] = []
    expect(recordFirstLaunch(directory, '0.2.1-rc.24', (text) => notes.push(text))).toBe(true)
    expect(notes).toEqual(['first launch: skipping the automatic update check until the next launch'])
    const marker = JSON.parse(readFileSync(join(directory, FIRST_LAUNCH_MARKER), 'utf8')) as {
      version: string
      firstLaunchedAt: string
    }
    expect(marker.version).toBe('0.2.1-rc.24')
    expect(Number.isNaN(Date.parse(marker.firstLaunchedAt))).toBe(false)
    expect(recordFirstLaunch(directory, '0.2.1-rc.24', (text) => notes.push(text))).toBe(false)
    expect(notes).toHaveLength(1)
  })

  it('keeps the automatic check when the marker cannot be written', () => {
    const directory = root()
    const blocked = join(directory, 'not-a-directory')
    writeFileSync(blocked, 'occupied', 'utf8')
    const notes: string[] = []
    expect(recordFirstLaunch(join(blocked, 'profile'), '0.2.1-rc.24', (text) => notes.push(text))).toBe(false)
    expect(notes.some((text) => text.startsWith('first-launch marker not written:'))).toBe(true)
  })
})
