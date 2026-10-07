/** `electron-updater` release stream, used by a build that ships `app-update.yml`. */

import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateBackend, DesktopUpdateIntegrity } from './update-backend.ts'

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

  /** Ask the packaged update channel which version it offers. */
  async check(): Promise<string | undefined> {
    const result = await this.updater.checkForUpdates()
    return result?.isUpdateAvailable === true ? result.updateInfo.version : undefined
  }

  /**
   * Download the release the channel offered.
   * @returns `verified`, because electron-updater validates the artifact against the signature
   * metadata in `app-update.yml` before it reports a completed download.
   */
  async download(): Promise<DesktopUpdateIntegrity> {
    await this.updater.downloadUpdate()
    return 'verified'
  }

  /** Install the downloaded release and restart the application into it. */
  async install(): Promise<void> {
    this.updater.quitAndInstall(false, true)
  }
}
