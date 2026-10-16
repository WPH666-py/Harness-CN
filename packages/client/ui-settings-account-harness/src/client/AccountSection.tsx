/**
 * Account & balance settings section: the sign-in state, the two wallet reads,
 * and one granted-bonus card.
 *
 * The row renders the snapshot its controller publishes and calls back for
 * every action, so it owns no subscription and its only local state is the
 * sign-out confirmation the user opened. Every external link is a plain
 * anchor: the Desktop shell's window refuses off-origin navigation, so the
 * links serve a browser-hosted profile and stay inert in the shell.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionState } from './account-store.ts'
import { isPositiveBalance, walletText } from './format.ts'
import type { AccountSettingsKey } from './locales.ts'
import type {
  AccountBonusOrderId,
  AccountWallet,
  SignInAttemptId,
  SignInAttemptView,
} from './types.ts'
import css from './AccountSection.module.css'

/** Registration-side business face for the Account & balance row. */
export interface AccountSectionInjected {
  hooks: {
    /** Row snapshot bound by the UI renderer as useAccountSection. */
    accountSection: SnapshotStore<AccountSectionState>
  }
  /** The row mounted: read the details and open the bonus-notice lifecycle. */
  begin: () => void
  /** The row unmounted: stop acknowledging notices it displayed. */
  leave: () => void
  /** Start a sign-in attempt; the authorization page rides the resulting view. */
  signIn: () => Promise<void>
  /** Cancel an in-flight sign-in attempt. */
  cancel: (attemptId: SignInAttemptId) => Promise<void>
  /** Drop the stored credential. */
  signOut: () => Promise<void>
  /**
   * Whether the Host is running tasks on this credential.
   * @returns whether tasks run, or undefined when the Host could not say.
   */
  hasRunningAccountTasks: () => Promise<boolean | undefined>
  /** Report that a notice card finished a displayed frame. */
  noticeShown: (orderId: AccountBonusOrderId) => void
  /** Report that the user dismissed a notice card. */
  noticeDismissed: (orderId: AccountBonusOrderId) => void
}

/** Full component props. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.account'>
  & InjectFace<AccountSectionInjected>

/**
 * Copy for each sign-in phase. A phase with no status line is one whose state
 * the row already states, or whose failure the shared failure line reports.
 */
const PHASE_COPY: Record<SignInAttemptView['phase'], AccountSettingsKey | undefined> = {
  initializing: 'initializing',
  'waiting-browser': 'waiting',
  exchanging: 'completing',
  committing: 'completing',
  succeeded: undefined,
  cancelled: undefined,
  expired: 'expired',
  failed: undefined,
}

/** Phases an attempt can still be cancelled from. */
const ACTIVE_PHASES: readonly SignInAttemptView['phase'][] = [
  'initializing', 'waiting-browser', 'exchanging', 'committing',
]

/**
 * Text for one wallet row, in the order the states resolve.
 * @param balance - latest balance read, absent until one completes.
 * @param t - section copy.
 * @param ready - text for the wallets of a completed read.
 * @returns the row's text.
 */
function walletRowText(
  balance: AccountSectionState['balance'],
  t: (key: AccountSettingsKey) => string,
  ready: (wallets: readonly AccountWallet[]) => string,
): string {
  if (balance === undefined) return t('loading')
  if (balance.status === 'failed') return t('balanceUnavailable')
  return ready(balance.value)
}

/**
 * The Account & balance settings row.
 * @param props - runtime, locale, and injected action shares.
 * @returns the row.
 */
export function AccountSection(props: AccountSectionProps): ReactNode {
  const {
    useAccountSection, t, begin, leave, signIn, cancel, signOut,
    hasRunningAccountTasks, noticeShown, noticeDismissed,
  } = props
  const state = useAccountSection(snapshot => snapshot)
  /** Sign-out confirmation copy, or null while none is open. */
  const [confirming, setConfirming] = useState<AccountSettingsKey | null>(null)

  useEffect(() => {
    begin()
    return () => { leave() }
  }, [begin, leave])

  const notice = state.notice
  const noticeOrder = notice?.orderId
  useEffect(() => {
    if (noticeOrder === undefined) return
    noticeShown(noticeOrder)
  }, [noticeOrder, noticeShown])

  // How the Host answers decides what the confirmation warns about: it runs no
  // task, it does, or it could not say.
  const askSignOut = (): void => {
    void hasRunningAccountTasks().then((running) => {
      setConfirming(
        running === true ? 'signOutRunningDescription'
          : running === false ? 'signOutDescription'
            : 'signOutUnknownDescription',
      )
    })
  }

  const view = state.view
  const attempt = view !== undefined && view.status === 'signed-out' ? view.attempt : null
  const phaseCopy = attempt === null ? undefined : PHASE_COPY[attempt.phase]
  const statusText = phaseCopy === undefined ? undefined : t(phaseCopy)
  const profile = state.profile
  const profileText = profile === undefined
    ? t('signedIn')
    : profile.status === 'failed'
      ? `${t('signedIn')} · ${t('profileUnavailable')}`
      : `${t('signedIn')} · ${profile.value.name}`
  const topUpText = walletRowText(state.balance, t, wallets => (
    wallets.length === 0 ? t('balanceUnavailable') : walletText(wallets)
  ))
  const bonusText = walletRowText(state.balance, t, (wallets) => {
    // A granted wallet at zero is not a balance the user can spend.
    const positive = wallets.filter(wallet => isPositiveBalance(wallet.balance))
    return positive.length === 0 ? t('bonusEmpty') : walletText(positive)
  })

  return (
    <section className={css.section}>
      {notice === undefined ? null : (
        <div className={css.notice} role="status">
          <div className={css.noticeHeader}>
            <span className={css.noticeTitle}>{t('bonusNoticeTitle')}</span>
            <button
              type="button"
              className={css.noticeClose}
              aria-label={t('close')}
              onClick={() => { noticeDismissed(notice.orderId) }}
            >
              <IconCloseOutline16 />
            </button>
          </div>
          <p className={css.noticeMessage}>{notice.message}</p>
        </div>
      )}
      {view === undefined || view.status === 'signed-out'
        ? (
          <div className={css.account}>
            {statusText === undefined ? null : <p className={css.status} role="status">{statusText}</p>}
            <div className={css.rows}>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('balance')}</span>
                <span className={css.rowValue}>{t('balanceSignedOut')}</span>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('bonusBalance')}</span>
                <span className={css.rowValue}>{t('balanceSignedOut')}</span>
              </div>
            </div>
            {state.failed ? <p className={css.status} role="alert">{t('failed')}</p> : null}
            <div className={css.actions}>
              <Button
                size="sm"
                disabled={state.busy}
                onClick={() => { void signIn() }}
              >
                {t('signIn')}
              </Button>
              {attempt !== null && ACTIVE_PHASES.includes(attempt.phase)
                ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.busy}
                    onClick={() => { void cancel(attempt.id) }}
                  >
                    {t('cancel')}
                  </Button>
                )
                : null}
              {attempt?.authorizeUrl === undefined
                ? null
                : (
                  <a
                    className={css.link}
                    href={attempt.authorizeUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('open')}
                  </a>
                )}
            </div>
          </div>
        )
        : (
          <div className={css.account}>
            <p className={css.status}>{profileText}</p>
            {state.failed ? <p className={css.status} role="alert">{t('failed')}</p> : null}
            <div className={css.rows}>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('balance')}</span>
                <span className={`${css.rowValue} ${css.amount}`}>{topUpText}</span>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('bonusBalance')}</span>
                <span className={`${css.rowValue} ${css.amount}`}>{bonusText}</span>
              </div>
            </div>
            <div className={css.links}>
              <a className={css.link} href={view.links.usageUrl} target="_blank" rel="noreferrer">
                {t('usage')}
              </a>
              <a className={css.link} href={view.links.topUpUrl} target="_blank" rel="noreferrer">
                {t('topUp')}
              </a>
            </div>
            <div className={css.actions}>
              {confirming === null
                ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.busy}
                    onClick={askSignOut}
                  >
                    {t('signOut')}
                  </Button>
                )
                : (
                  <>
                    <p className={css.status} role="alert">{t(confirming)}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={state.busy}
                      onClick={() => { setConfirming(null) }}
                    >
                      {t('cancel')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={state.busy}
                      onClick={() => {
                        setConfirming(null)
                        void signOut()
                      }}
                    >
                      {t('signOut')}
                    </Button>
                  </>
                )}
            </div>
          </div>
        )}
    </section>
  )
}
