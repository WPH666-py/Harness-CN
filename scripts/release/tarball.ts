/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { capture } from './process.ts'

/**
 * Archive tool these readers run.
 *
 * On Windows the `tar` a shell often puts on PATH first is GNU tar from Git for Windows, which
 * reads a drive-letter path as a remote host (`rsh`) and fails on `D:...`. The archive tool
 * Windows ships in System32 is bsdtar and takes those paths, so resolve it explicitly: the release
 * steps then behave the same whichever tar the caller's PATH names first.
 */
const WINDOWS_TAR = process.platform === 'win32'
  ? resolve(process.env.SystemRoot ?? '', 'System32', 'tar.exe')
  : undefined
/** Resolved archive tool: the Windows bsdtar when it exists, otherwise `tar` from PATH. */
export const TAR = WINDOWS_TAR !== undefined && existsSync(WINDOWS_TAR) ? WINDOWS_TAR : 'tar'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
export function tarballFiles(tarball: string): string[] {
  return capture(TAR, ['-tzf', tarball]).split(/\r?\n/u).filter(line => line !== '')
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const manifest: unknown = JSON.parse(capture(TAR, ['-xOzf', tarball, 'package/package.json']))
  if (manifest === null || typeof manifest !== 'object') throw new Error(`${tarball} has no manifest`)
  const { name, version } = manifest as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
