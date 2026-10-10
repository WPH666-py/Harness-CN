/** `electron-updater` release stream, used by a build that ships `app-update.yml`. */

import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateBackend, DesktopUpdateOffer } from './update-backend.ts'

/**
 * Update channel backed by the `electron-updater` stream this build was
 * packaged against.
 *
 * The configuration in `app-update.yml` names the channel, artifact names, and
 * signature metadata, so this backend adds no version comparison of its own.
 * `quitAndInstall` runs the downloaded artifact and restarts the application,
 * which is why the coordinator stops application-owned processes first.
 */
export class DesktopElectronUpdaterBackend implements DesktopUpdateBackend {
  /**
   * @param updater - Electron artifact updater configured by `app-update.yml`.
   */
  constructor(private readonly updater: AppUpdater) {
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  /**
   * Ask the packaged update channel which version it offers.
   *
   * The channel's metadata already names the artifact, so the offer carries the version and
   * nothing a person would read: `app-update.yml` publishes no release notes, and inventing an
   * empty notes box for a build that reads its metadata from a file is worse than omitting it.
   */
  async check(): Promise<DesktopUpdateOffer | undefined> {
    const result = await this.updater.checkForUpdates()
    if (result?.isUpdateAvailable !== true) return undefined
    return {
      version: result.updateInfo.version,
      notes: typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : '',
      publishedAt: result.updateInfo.releaseDate ?? '',
      page: '',
      size: undefined,
    }
  }

  /**
   * Download the release the channel offered.
   *
   * `electron-updater` owns the transfer and reports no byte counts of its own, so the state the
   * window renders while this runs is the one the coordinator published at its start; the progress
   * sinks are deliberately unused rather than approximated from no measurement.
   * @returns `verified`, because electron-updater validates the artifact against the signature
   * metadata in `app-update.yml` before it reports a completed download.
   */
  async download(): Promise<'verified'> {
    await this.updater.downloadUpdate()
    return 'verified'
  }

  /** Install the downloaded release and restart the application into it. */
  async install(): Promise<void> {
    this.updater.quitAndInstall(false, true)
  }
}
