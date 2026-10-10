/** Release channel the Electron shell checks, downloads from, and hands to the OS installer. */

import type { DesktopUpdateState } from './ipc.ts'

/** Report one completed fraction of a download, from 0 through 1. */
export type DesktopUpdateProgress = (fraction: number) => void

/**
 * Report how much of one download is on disk.
 *
 * The fraction and the byte counts are the same fact at two resolutions: the bar moves on the
 * fraction, and the sentence under it names the megabytes, which is what distinguishes a slow
 * transfer from a stopped one.
 * @param downloaded - bytes written so far.
 * @param total - published size of the file, or zero when the host did not state one.
 */
export type DesktopUpdateBytes = (downloaded: number, total: number) => void

/** State sink the shell passes to a backend that reports its own progress. */
export type DesktopUpdatePublish = (state: DesktopUpdateState) => DesktopUpdateState

/**
 * The release a channel offers, as the prompt describes it.
 *
 * The prompt names the version, shows what the release says about itself, and reports how large
 * the download will be; all four come from the same host answer that produced the offer, so they
 * cannot describe different releases.
 */
export interface DesktopUpdateOffer {
  /** Release version to install. */
  readonly version: string
  /** Release notes the host published, empty when it published none worth showing. */
  readonly notes: string
  /** When the host published this release, empty when it did not say. */
  readonly publishedAt: string
  /** Human-readable release page, for a person who would rather download it by hand. */
  readonly page: string
  /** Published installer size in bytes, absent when the host did not state one. */
  readonly size: number | undefined
}

/** Which version a download should fetch and progress reports belong to. */
export interface DesktopUpdateDownload {
  /** Release version to fetch. */
  readonly version: string
  /** Progress sink for this download. */
  readonly progress: DesktopUpdateProgress
  /**
   * Byte-count sink for this download.
   *
   * Optional because a channel can own its own transfer and therefore have nothing to measure:
   * `electron-updater` reports no byte counts, and a state built from an invented fraction would
   * be a progress bar that lies. A channel that does measure reports through this.
   */
  readonly bytes?: DesktopUpdateBytes
  /** Aborted when the user cancels the download; absent when the caller offers no cancellation. */
  readonly signal?: AbortSignal
}

/** How a channel vouched for the installer it just downloaded. */
export type DesktopUpdateIntegrity = 'verified' | 'unverified'

/** One release channel the shell can check, download from, and hand to the OS installer. */
export interface DesktopUpdateBackend {
  /** The newer release this channel offers, or undefined when the build is current. */
  check(): Promise<DesktopUpdateOffer | undefined>
  /**
   * Download that version, verifying it before it is runnable.
   * @param request - version to fetch and the sinks this download reports through.
   * @returns how the channel vouched for the downloaded bytes.
   */
  download(request: DesktopUpdateDownload): Promise<DesktopUpdateIntegrity>
  /** Start the downloaded installer so it replaces this installation. */
  install(): Promise<void>
}
