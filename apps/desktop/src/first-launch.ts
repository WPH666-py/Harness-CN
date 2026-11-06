/** The marker that tells an installation's very first launch apart from every later one. */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * File the shell writes into the profile root on the first launch it serves.
 *
 * A profile root holds the state that belongs to the installation rather than to a window, so the
 * marker sits beside `update-skip.json` and survives release upgrades that replace the runtime.
 */
export const FIRST_LAUNCH_MARKER = 'first-launch.json'

/**
 * Record that a profile root has launched, reporting whether this is the first time.
 *
 * The shell skips its automatic release check when this returns true: on a first launch the check
 * can only cover the workspace the person just opened, and the installation has no update to
 * install yet. Every later launch and the menu's own check keep the release channel.
 * @param root - profile root that owns the marker.
 * @param version - release this launch runs, recorded for support.
 * @param note - shell log sink.
 * @returns whether the marker had not existed yet.
 */
export function recordFirstLaunch(root: string, version: string, note: (text: string) => void): boolean {
  const marker = join(root, FIRST_LAUNCH_MARKER)
  if (existsSync(marker)) return false
  try {
    writeFileSync(marker, `${JSON.stringify({ version, firstLaunchedAt: new Date().toISOString() }, undefined, 2)}\n`)
    note('first launch: skipping the automatic update check until the next launch')
    return true
  } catch (error) {
    // A root this process cannot write already fails the install elsewhere; keeping the check is
    // the safe side of that failure, because it never suppresses a notice on a later launch.
    note(`first-launch marker not written: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
