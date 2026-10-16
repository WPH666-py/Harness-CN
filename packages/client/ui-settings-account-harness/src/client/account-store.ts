/**
 * Account section state: the sign-in view, the two detail reads, the bonus
 * notice lifecycle, and the operations the row triggers.
 *
 * Every read is event-driven. The Host stream naming a sign-in state change and
 * the row mounting are the only triggers; nothing here polls. The row renders
 * the store and calls back into this controller, so the section owns no
 * subscription machinery of its own.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createBonusNoticeController, type BonusNoticeController } from './bonus-notices.ts'
import { accountClientMetadata } from './client-metadata.ts'
import type {
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountClientMetadata,
  AccountDetails,
  AccountRemote,
  AccountView,
  SignInAttemptId,
} from './types.ts'

/** Milliseconds to wait before retrying a rejected bonus acknowledgement. */
const ACK_RETRY_DELAY_MS = 1000

/** Upper bound for the bonus acknowledgement retry delay. */
const ACK_RETRY_MAX_DELAY_MS = 60_000

/** Everything the Account & balance row renders. */
export interface AccountSectionState {
  /** Latest sign-in state, absent until the Host reports one. */
  view: AccountView | undefined
  /** Latest profile read, absent until one completes. */
  profile: AccountDetails['profile'] | undefined
  /** Latest balance read, absent until one completes. */
  balance: AccountDetails['balance'] | undefined
  /** Whether the last operation or detail read failed. */
  failed: boolean
  /** Whether an operation is in flight. */
  busy: boolean
  /** Bonus notice to display, absent when there is none. */
  notice: AccountBonusNotification | undefined
}

/**
 * Owns the account facts the section renders and the operations it triggers.
 *
 * One controller serves one plugin instance: `start` opens the Host stream once,
 * and `end` closes it together with the notice lifecycle.
 */
export class AccountSectionController {
  /** Store the row renders. */
  readonly store: SnapshotStore<AccountSectionState> = createSnapshotStore({
    view: undefined,
    profile: undefined,
    balance: undefined,
    failed: false,
    busy: false,
    notice: undefined,
  })

  private readonly notices: BonusNoticeController
  private readonly stopped = new AbortController()
  private revision = 0
  private refreshing = false

  /**
   * @param ctx - client context carrying the Remote namespace and the locale service.
   */
  constructor(private readonly ctx: Context) {
    this.notices = createBonusNoticeController({
      retryDelayMs: ACK_RETRY_DELAY_MS,
      retryMaxDelayMs: ACK_RETRY_MAX_DELAY_MS,
      read: async () => {
        const result = await this.account().getUnnotifiedBonuses(this.client())
        if (!result.ok) throw new Error('account bonus read failed')
        return result.value
      },
      acknowledge: async (accountId, orderId) => {
        const result = await this.account().ackBonusNotified(accountId, orderId, this.client())
        if (!result.ok) throw new Error('account bonus acknowledgement failed')
        return result.value
      },
      publish: (notice) => {
        this.store.update((draft) => {
          draft.notice = notice ?? undefined
        })
      },
    })
  }

  /** Open the Host sign-in stream. Called once, from the plugin body. */
  start(): void {
    void this.consume(this.stopped.signal)
  }

  /** Stop the Host stream; called once, when the plugin is disposed. */
  end(): void {
    this.stopped.abort()
    this.notices.end()
  }

  /** The row mounted: read the details and let one bonus notice through. */
  mounted(): void {
    void this.refresh()
    this.notices.begin()
  }

  /** The row unmounted: stop acknowledging anything it displayed. */
  unmounted(): void {
    this.notices.end()
  }

  /**
   * Report that a notice card finished a displayed frame.
   * @param orderId - granted-bonus order the card shows.
   */
  noticeShown(orderId: AccountBonusOrderId): void {
    this.notices.shown(orderId)
  }

  /**
   * Report that the user dismissed a notice card.
   * @param orderId - granted-bonus order the card shows.
   */
  noticeDismissed(orderId: AccountBonusOrderId): void {
    this.notices.dismiss(orderId)
  }

  /**
   * Read the profile and the wallets once.
   * @returns when both reads have settled and the store carries them.
   */
  refresh(): Promise<void> {
    if (this.store.getSnapshot().view?.status !== 'credential-stored') return Promise.resolve()
    if (this.refreshing) return Promise.resolve()
    this.refreshing = true
    const revision = this.revision
    return this.readDetails(revision).finally(() => {
      this.refreshing = false
    })
  }

  /** Begin a sign-in attempt and open the Platform page for it. */
  async signIn(): Promise<void> {
    this.store.update((draft) => {
      draft.busy = true
      draft.failed = false
    })
    const result = await this.account()
      .startSignIn(this.client(), window.location.origin, 'desktop')
      .catch(() => null)
    this.store.update((draft) => {
      draft.busy = false
      draft.failed = result === null || !result.ok
      if (result !== null && result.ok) draft.view = result.value
    })
  }

  /**
   * Cancel an in-flight sign-in attempt.
   * @param attemptId - attempt to cancel.
   */
  async cancel(attemptId: SignInAttemptId): Promise<void> {
    this.store.update((draft) => {
      draft.busy = true
    })
    const result = await this.account().cancelSignIn(attemptId).catch(() => null)
    this.store.update((draft) => {
      draft.busy = false
      draft.failed = result === null || !result.ok
      if (result !== null && result.ok) draft.view = result.value
    })
  }

  /**
   * Ask whether the Host is running tasks on this credential.
   * @returns whether tasks are running, or undefined when the Host could not say.
   */
  async hasRunningAccountTasks(): Promise<boolean | undefined> {
    const result = await this.account().hasRunningAccountTasks().catch(() => null)
    return result !== null && result.ok ? result.value : undefined
  }

  /** Drop the stored credential and clear the details it produced. */
  async signOut(): Promise<void> {
    this.store.update((draft) => {
      draft.busy = true
    })
    const result = await this.account().signOut(this.client()).catch(() => null)
    this.store.update((draft) => {
      draft.busy = false
      draft.failed = result === null || !result.ok
      if (result !== null && result.ok) {
        draft.view = result.value
        draft.profile = undefined
        draft.balance = undefined
      }
    })
    this.notices.end()
  }

  private async consume(signal: AbortSignal): Promise<void> {
    const stream = this.ctx.remote.$stream<AccountView>({
      name: 'account state stream',
      open: opening => this.account().watch(opening),
      ended: () => new Error('account state stream ended'),
    })
    // The stream outlives one iteration: stop the Host side with the plugin.
    signal.addEventListener('abort', () => {
      void stream.dispose()
    }, { once: true })
    for await (const frame of stream) {
      if (signal.aborted) return
      this.revision += 1
      this.refreshing = false
      this.store.update((draft) => {
        draft.view = frame.value
        draft.profile = undefined
        draft.balance = undefined
        draft.failed = false
      })
      frame.accept()
      if (frame.value.status === 'credential-stored') this.notices.begin()
      else this.notices.end()
      void this.refresh()
    }
  }

  private async readDetails(revision: number): Promise<void> {
    const client = this.client()
    const [profile, balance] = await Promise.all([
      this.readField(() => this.account().getProfile(client)),
      this.readField(() => this.account().getBalance(client)),
    ])
    if (revision !== this.revision) return
    this.store.update((draft) => {
      draft.profile = profile
      draft.balance = balance
    })
  }

  /** Read one account detail field; every failure renders as the failed arm. */
  private async readField<Value extends object>(
    read: () => Promise<RemoteResult<Value | null>>,
  ): Promise<Value | { status: 'failed' }> {
    const result = await read().catch(() => null)
    if (result === null || !result.ok || result.value === null) return { status: 'failed' }
    return result.value
  }

  private account(): AccountRemote {
    return this.ctx.remote.account
  }

  private client(): AccountClientMetadata {
    return accountClientMetadata(this.ctx.locale.getLocale().active, process.env.DSH_CLIENT_VERSION)
  }
}
