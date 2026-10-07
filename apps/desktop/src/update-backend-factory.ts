/** Selects the release channel one Desktop process checks, downloads from, and installs through. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import type { DesktopUpdateBackend } from './update-backend.ts'
import { DesktopGithubUpdateBackend } from './update-github-backend.ts'
import { DesktopElectronUpdaterBackend } from './update-electron-backend.ts'

const { autoUpdater } = electronUpdater

/** Subdirectory of the platform temp directory that holds a downloaded installer. */
const DOWNLOAD_DIRECTORY_NAME = 'harness-cn-update'

/** Options for {@link createDesktopUpdateBackend}. */
export interface DesktopUpdateBackendOptions {
  /** Version of the running application, as Electron reports it. */
  readonly currentVersion: string
  /** Electron artifact updater; replaceable for tests. */
  readonly updater?: AppUpdater
  /** Directory holding `app-update.yml`; replaceable for tests. */
  readonly resourcesPath?: string
  /** JSON request implementation for the GitHub channel; replaceable for tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Create the release channel for this process.
 *
 * A build packaged with `app-update.yml` carries an `electron-updater` channel
 * and uses it. Any other build — the fork's unsigned Windows build among them,
 * which sets `publish: null` and therefore emits no such file — checks the
 * GitHub Releases channel instead.
 * @param options - application version and injectable updater resources.
 * @returns the release channel this process uses.
 */
export function createDesktopUpdateBackend(options: DesktopUpdateBackendOptions): DesktopUpdateBackend {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (existsSync(join(resourcesPath, 'app-update.yml'))) {
    return new DesktopElectronUpdaterBackend(options.updater ?? autoUpdater)
  }
  const request = options.fetch ?? globalThis.fetch
  return new DesktopGithubUpdateBackend({
    currentVersion: options.currentVersion,
    downloadDirectory: join(app.getPath('temp'), DOWNLOAD_DIRECTORY_NAME),
    fetch: (...parameters) => request(...parameters),
  })
}
