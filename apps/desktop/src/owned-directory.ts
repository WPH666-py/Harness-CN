/** Moves and removals of directories this application owns, retried against Windows handle races. */

import { existsSync, lstatSync, renameSync, rmSync, unlinkSync } from 'node:fs'

/** Backoff schedule for a directory operation that lost a race with a handle holder. */
const RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800, 1600] as const

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * Move one owned directory, retrying the failures Windows reports while a handle is open.
 *
 * A Windows directory rename fails with EPERM, EACCES, or EBUSY while any file inside the
 * tree still has an open handle. Every caller moves a tree that was written moments earlier,
 * so a real-time scanner or a just-terminated child can hold exactly such a handle for a few
 * hundred milliseconds. An immediate failure would abort the first launch, so the rename is
 * retried over a bounded schedule instead; a holder that outlives the schedule still surfaces
 * its own error.
 * @param source - existing directory to move.
 * @param destination - path the directory takes, which must not exist.
 */
export function renameOwnedDirectory(source: string, destination: string): void {
  let lastError: unknown
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) sleepSync(delay)
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`desktop storage: could not move ${source}`)
}

/**
 * Remove one owned directory, retrying the same transient Windows refusals as a move.
 *
 * A tree the Host has run from keeps handles for a moment after that process exits, and
 * Windows refuses to unlink those files. The holders are transient, so removal retries over
 * the same bounded schedule.
 * @param path - owned directory to remove; a path that does not exist is left alone.
 */
export function removeOwnedDirectory(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stat.isDirectory()) throw new Error(`desktop storage: owned directory path is not a directory: ${path}`)
  let lastError: unknown
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) sleepSync(delay)
    try {
      rmSync(path, { recursive: true })
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`desktop storage: could not remove ${path}`)
}
