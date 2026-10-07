/** Durable record of the one Desktop version the user asked not to be offered again. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Key holding the deferred version inside the state file. */
const SKIPPED_VERSION_KEY = 'skippedVersion'

/**
 * Read one skipped version from parsed state.
 *
 * A file written by another build, or truncated by a power loss, must not take
 * the update check down with it, so anything that is not one non-empty string
 * reads as "nothing skipped".
 * @param parsed - value decoded from the state file.
 * @returns the skipped version, or undefined when the state holds none.
 */
function skippedVersionOf(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>)[SKIPPED_VERSION_KEY]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Remembers which Desktop version the user deferred, in one JSON file under
 * the application's userData directory.
 *
 * The file is written after the user answers the update dialog, so a failed
 * write only costs the user the question again on the next launch. Reads,
 * writes, and directory creation therefore report nothing: an unreadable or
 * corrupt record leaves the update check working with no skipped version
 * instead of failing startup.
 */
export class DesktopUpdateSkipStore {
  private cached: string | undefined
  private loaded = false

  /**
   * @param file - state file path, normally `<userData>/update-skip.json`.
   */
  constructor(private readonly file: string) {}

  /**
   * Version an automatic update check must not prompt for.
   * @returns the skipped version, or undefined when the user skipped none.
   */
  async read(): Promise<string | undefined> {
    if (this.loaded) return this.cached
    this.loaded = true
    try {
      this.cached = skippedVersionOf(JSON.parse(await readFile(this.file, 'utf8')) as unknown)
    } catch {
      // A missing, unreadable, or non-JSON state file means no version was skipped; nothing
      // else reaches this catch because readFile and JSON.parse are its only statements.
      this.cached = undefined
    }
    return this.cached
  }

  /**
   * Record one deferred version and retain it for the rest of this process.
   * @param version - release version the update dialog offered.
   */
  async remember(version: string): Promise<void> {
    this.cached = version
    this.loaded = true
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, `${JSON.stringify({ [SKIPPED_VERSION_KEY]: version }, undefined, 2)}\n`, 'utf8')
    } catch {
      // The choice applies to this launch even when the record cannot be written; only
      // mkdir, writeFile, and JSON.stringify reach this catch.
    }
  }
}
