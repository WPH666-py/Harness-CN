/** Release channel the Electron shell checks, downloads from, and hands to the OS installer. */

import type { DesktopUpdateState } from './ipc.ts'

/**
 * Report one completed fraction of a download, from 0 through 1.
 *
 * Backends call it as bytes arrive, so an implementation must expect frequent
 * calls and stay cheap; the coordinator is the only caller that decides what
 * reaches the window.
 * @param fraction - downloaded fraction of the installer, from 0 through 1.
 */
export type DesktopUpdateProgress = (fraction: number) => void

/** State sink the shell passes to a backend that reports its own progress. */
export type DesktopUpdatePublish = (state: DesktopUpdateState) => DesktopUpdateState

/** Which version a download should fetch and progress reports belong to. */
export interface DesktopUpdateDownload {
  /** Release version to fetch. */
  readonly version: string
  /** Progress sink for this download. */
  readonly progress: DesktopUpdateProgress
}

/** How a channel vouched for the installer it just downloaded. */
export type DesktopUpdateIntegrity = 'verified' | 'unverified'

/** One release channel the shell can check, download from, and hand to the OS installer. */
export interface DesktopUpdateBackend {
  /** The newer version this channel offers, or undefined when the build is current. */
  check(): Promise<string | undefined>
  /**
   * Download that version, verifying it before it is runnable.
   * @param request - version to fetch and progress sink for this download.
   * @returns how the channel vouched for the downloaded bytes.
   */
  download(request: DesktopUpdateDownload): Promise<DesktopUpdateIntegrity>
  /** Start the downloaded installer so it replaces this installation. */
  install(): Promise<void>
}
