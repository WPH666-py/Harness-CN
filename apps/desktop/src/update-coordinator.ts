/** One release stream for the version-bound shell and its dsh seed. */

import type { DesktopUpdateState } from './ipc.ts'
import type {
  DesktopUpdateBackend,
  DesktopUpdateBytes,
  DesktopUpdateOffer,
  DesktopUpdateProgress,
  DesktopUpdatePublish,
} from './update-backend.ts'

/** Reports sent to the window while an installer download runs, at most this many milliseconds apart. */
const PROGRESS_INTERVAL_MS = 500

/** Which version the user asked not to be offered again. */
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

/** Checks, downloads, and installs one complete release. */
export class DesktopUpdateCoordinator {
  private offer: DesktopUpdateOffer | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined
  private downloading: AbortController | undefined

  /**
   * @param publish - state sink for every desktop window.
   * @param beforeRestart - stop application-owned processes before replacement.
   * @param backend - release channel to check, download from, and install through.
   * @param requestExit - end this process so the installer can replace its files.
   * @param skipped - versions the user deferred, which only an automatic check honors.
   * @param note - run-log sink for facts the user-facing state does not carry.
   * @param currentVersion - version this installation runs, named in every offered state.
   */
  constructor(
    private readonly publish: DesktopUpdatePublish,
    private readonly beforeRestart: () => Promise<void> = async () => {},
    private readonly backend: DesktopUpdateBackend,
    private readonly requestExit: () => void = () => {},
    private readonly skipped: DesktopUpdateSkipState = REMEMBER_NOTHING,
    private readonly note: (text: string) => void = () => {},
    private readonly currentVersion = '',
  ) {}

  /**
   * Check the release channel and retain the release it offers.
   *
   * An automatic check reports `idle` when the user already skipped exactly that release, so the
   * caller keeps the state sink up to date while prompting for nothing.
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
   * The order is download, then `beforeRestart`, then the installer, then this process: the
   * installer cannot replace files the shell still has open, so the exit belongs to the same
   * operation that started it. A failure anywhere before the installer starts leaves the shell
   * running and publishes `error`.
   */
  async install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      return this.doInstall()
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /**
   * Stop an in-flight download.
   *
   * The transfer rejects with its own cancellation, which is what the window renders as "cancelled"
   * rather than as a failure to retry. Nothing is installed, and the partial file is removed by the
   * download itself before it rejects.
   * @returns whether a download was running.
   */
  cancel(): boolean {
    const active = this.downloading
    if (active === undefined) return false
    active.abort(new Error('the user cancelled the download'))
    return true
  }

  private async doCheck(manual: boolean): Promise<DesktopUpdateState> {
    this.publish({ phase: 'checking', current: this.currentVersion })
    try {
      const offer = await this.backend.check()
      const suppressed = offer !== undefined && !manual && this.skipped.suppresses(offer.version)
      this.offer = suppressed ? undefined : offer
      if (offer === undefined || suppressed) return this.publish({ phase: 'idle', current: this.currentVersion })
      // Named only once it is actually being offered: a release the user already skipped is not an
      // offer, and a run log that announced it anyway would disagree with the window.
      this.note(`release channel offers ${offer.version}${offer.publishedAt === '' ? '' : ` (${offer.publishedAt})`}`)
      return this.publish({ ...this.offered(offer), phase: 'available' })
    } catch (error) {
      this.offer = undefined
      return this.publish({
        phase: 'error',
        current: this.currentVersion,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async doInstall(): Promise<DesktopUpdateState> {
    const offer = this.offer
    if (offer === undefined) {
      throw new Error('desktop update: no verified update is available')
    }
    const abort = new AbortController()
    this.downloading = abort
    this.publish({ ...this.offered(offer), phase: 'installing', progress: 0, downloaded: 0 })
    try {
      const integrity = await this.backend.download({
        version: offer.version,
        progress: this.progressReporter(offer),
        bytes: this.byteReporter(offer),
        signal: abort.signal,
      })
      this.offer = undefined
      this.note(`desktop update ${offer.version} downloaded (${integrity})`)
      const ready = this.publish({ ...this.offered(offer), phase: 'ready', progress: 1 })
      // The installer replaces files this process has open, so every application-owned process is
      // stopped first — which is also what ends every agent and task still running.
      await this.beforeRestart()
      await this.backend.install()
      this.requestExit()
      return ready
    } catch (error) {
      return this.publish({
        ...this.offered(offer),
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.downloading = undefined
    }
  }

  /**
   * The state every phase of one offer carries.
   * @param offer - release being offered.
   * @returns the shared fields, without a phase.
   */
  private offered(offer: DesktopUpdateOffer): Omit<DesktopUpdateState, 'phase'> {
    return {
      current: this.currentVersion,
      version: offer.version,
      notes: offer.notes,
      publishedAt: offer.publishedAt,
      ...(offer.size === undefined ? {} : { total: offer.size }),
    }
  }
  /**
   * Keep republishing the installing state while the download advances.
   * @param offer - release being downloaded.
   * @returns progress sink for one download, throttled to one report per interval.
   */
  private progressReporter(offer: DesktopUpdateOffer): DesktopUpdateProgress {
    let lastReport = 0
    return (fraction: number) => {
      const now = Date.now()
      if (fraction < 1 && now - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = now
      this.publish({ ...this.offered(offer), phase: 'installing', progress: fraction })
    }
  }

  /**
   * Report how much of the installer is on disk.
   *
   * The byte counts ride on the same throttle as the fraction: the bar and the sentence under it
   * must advance together, and a host that answers in small chunks would otherwise publish
   * thousands of states a second for a window that can draw one.
   * @param offer - release being downloaded.
   * @returns byte-count sink for one download.
   */
  private byteReporter(offer: DesktopUpdateOffer): DesktopUpdateBytes {
    let lastReport = 0
    return (downloaded: number, total: number) => {
      const now = Date.now()
      if (now - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = now
      this.publish({
        ...this.offered(offer),
        phase: 'installing',
        downloaded,
        ...(total <= 0 ? {} : { total, progress: Math.min(1, downloaded / total) }),
      })
    }
  }
}
