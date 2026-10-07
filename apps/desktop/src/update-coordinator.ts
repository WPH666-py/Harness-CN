/** One Electron release stream for the version-bound shell and dsh seed. */

import type { DesktopUpdateState } from './ipc.ts'
import type { DesktopUpdateBackend, DesktopUpdateProgress, DesktopUpdatePublish } from './update-backend.ts'

/** Reports sent to the window while an installer download runs, at most this many milliseconds apart. */
const PROGRESS_INTERVAL_MS = 500

/** Which Desktop version the user asked not to be offered again. */
export interface DesktopUpdateSkipState {
  /**
   * Version the user skipped.
   * @param version - release version an automatic check must not prompt for.
   */
  remember(version: string): void
  /**
   * Whether an automatic check for this version must stay quiet.
   * @param version - version the checked release offers.
   * @returns true when the user already skipped exactly this version.
   */
  suppresses(version: string): boolean
}

/** Remembers no skipped version; the default for a process without persistent state. */
const REMEMBER_NOTHING: DesktopUpdateSkipState = { remember: () => {}, suppresses: () => false }

/** Checks, downloads, and installs one complete Desktop release. */
export class DesktopUpdateCoordinator {
  private availableVersion: string | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  /**
   * @param publish - state sink for every desktop window.
   * @param beforeRestart - stop application-owned processes before replacement.
   * @param backend - release channel to check, download from, and install through.
   * @param requestExit - end this process so the installer can replace its files.
   * @param skipped - versions the user deferred, which only an automatic check honors.
   * @param note - run-log sink for facts the user-facing state does not carry.
   */
  constructor(
    private readonly publish: DesktopUpdatePublish,
    private readonly beforeRestart: () => Promise<void> = async () => {},
    private readonly backend: DesktopUpdateBackend,
    private readonly requestExit: () => void = () => {},
    private readonly skipped: DesktopUpdateSkipState = REMEMBER_NOTHING,
    private readonly note: (text: string) => void = () => {},
  ) {}

  /**
   * Check the release channel and retain an available version.
   *
   * An automatic check reports `available` without a version when the user
   * already skipped exactly that release, so the caller keeps the state sink
   * up to date while prompting for nothing.
   * @param manual - whether the user asked for this check from the menu.
   * @returns the published check state.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    if (this.checkOperation !== undefined) return this.checkOperation
    this.checkOperation = this.doCheck(manual).finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  /**
   * Wait for an in-flight check, then download and install its retained release.
   *
   * The order is download, then `beforeRestart`, then the installer, then this
   * process: the installer cannot replace files the shell still has open, so
   * the exit belongs to the same operation that started it. A failure anywhere
   * before the installer starts leaves the shell running and publishes `error`.
   */
  async install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      return this.doInstall()
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  private async doCheck(manual: boolean): Promise<DesktopUpdateState> {
    this.publish({ phase: 'checking' })
    try {
      const version = await this.backend.check()
      const suppressed = version !== undefined && !manual && this.skipped.suppresses(version)
      this.availableVersion = suppressed ? undefined : version
      return version === undefined || suppressed
        ? this.publish({ phase: 'idle' })
        : this.publish({ phase: 'available', version })
    } catch (error) {
      this.availableVersion = undefined
      return this.publish({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async doInstall(): Promise<DesktopUpdateState> {
    const version = this.availableVersion
    if (version === undefined) {
      throw new Error('desktop update: no verified update is available')
    }
    this.publish({ phase: 'installing', version })
    try {
      const integrity = await this.backend.download({ version, progress: this.progressReporter(version) })
      this.availableVersion = undefined
      this.note(`desktop update ${version} downloaded (${integrity})`)
      const ready = this.publish({ phase: 'ready', version })
      await this.beforeRestart()
      await this.backend.install()
      this.requestExit()
      return ready
    } catch (error) {
      return this.publish({
        phase: 'error',
        version,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Keep republishing the installing state while the download advances.
   * @param version - release version being installed.
   * @returns progress sink for one download, throttled to one report per interval.
   */
  private progressReporter(version: string): DesktopUpdateProgress {
    let lastReport = 0
    return (fraction: number) => {
      const now = Date.now()
      if (fraction < 1 && now - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = now
      this.publish({ phase: 'installing', version, progress: fraction })
    }
  }
}
