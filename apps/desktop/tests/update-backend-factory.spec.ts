import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateState } from '../src/ipc.ts'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => join(tmpdir(), `fake-${name}`),
    getVersion: () => '0.1.5-rc.1',
  },
}))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: '9.9.9' },
      }),
      downloadUpdate: async () => [],
      quitAndInstall: () => {},
    },
  },
}))

const { createDesktopUpdateBackend } = await import('../src/update-backend-factory.ts')
const { DesktopGithubUpdateBackend } = await import('../src/update-github-backend.ts')
const { DesktopElectronUpdaterBackend } = await import('../src/update-electron-backend.ts')
const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop update backend selection', () => {
  /** Scratch directory standing in for a packaged application's resources. */
  let resourcesPath: string

  beforeEach(async () => {
    resourcesPath = await mkdtemp(join(tmpdir(), 'harness-cn-resources-'))
  })

  afterEach(async () => {
    await rm(resourcesPath, { recursive: true, force: true })
  })

  it('uses the GitHub Releases channel when the build ships no app-update.yml', () => {
    const backend = createDesktopUpdateBackend({ currentVersion: '0.1.5-rc.1', resourcesPath })

    expect(backend).toBeInstanceOf(DesktopGithubUpdateBackend)
  })

  it('uses the packaged electron-updater channel when app-update.yml is present', async () => {
    await writeFile(join(resourcesPath, 'app-update.yml'), 'provider: generic\n', 'utf8')

    const backend = createDesktopUpdateBackend({ currentVersion: '0.1.5-rc.1', resourcesPath })

    expect(backend).toBeInstanceOf(DesktopElectronUpdaterBackend)
  })

  it('keeps the previous download, restart, and exit order on the packaged channel', async () => {
    await writeFile(join(resourcesPath, 'app-update.yml'), 'provider: generic\n', 'utf8')
    const downloadUpdate = vi.fn(async () => [])
    const quitAndInstall = vi.fn()
    const updater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: '1.1.0' },
      })),
      downloadUpdate,
      quitAndInstall,
    } as unknown as AppUpdater
    const states: DesktopUpdateState[] = []
    const beforeRestart = vi.fn(async () => {})
    let exits = 0
    const coordinator = new DesktopUpdateCoordinator(
      (state) => {
        states.push(state)
        return state
      },
      beforeRestart,
      createDesktopUpdateBackend({ currentVersion: '0.1.5-rc.1', resourcesPath, updater }),
      () => { exits += 1 },
    )

    await expect(coordinator.check()).resolves.toEqual(availableState('1.1.0'))
    await expect(coordinator.install()).resolves.toEqual(readyState('1.1.0'))

    expect(downloadUpdate).toHaveBeenCalledOnce()
    expect(beforeRestart).toHaveBeenCalledOnce()
    expect(quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(exits).toBe(1)
    expect(states.map(state => state.phase)).toEqual(['checking', 'available', 'installing', 'ready'])
    // The coordinator drives download and install, so the updater must not act on its own.
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })
})


/**
 * The state a coordinator publishes for one available release.
 * @param version - version the release channel offered.
 * @returns that state, spelled out so a changed field fails this expectation.
 */
function availableState(version: string): DesktopUpdateState {
  return { phase: 'available', current: '', version, notes: '', publishedAt: '' }
}

/**
 * The state a coordinator publishes once one release is downloaded and ready to install.
 * @param version - version that was installed from.
 * @returns that state, spelled out so a changed field fails this expectation.
 */
function readyState(version: string): DesktopUpdateState {
  return { phase: 'ready', current: '', version, notes: '', publishedAt: '', progress: 1 }
}
