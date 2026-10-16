// @vitest-environment jsdom
/**
 * Account & balance row: the signed-out and stored-credential arms, both wallet
 * rows, every sign-in phase, the granted-bonus card, and the sign-out
 * confirmation the running-task probe decides.
 *
 * The row renders a bound snapshot store and calls back through the injected
 * action share, so each case drives state through the store and asserts the
 * copy and the callback behind every gesture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountSection, type AccountSectionProps } from '../src/client/AccountSection.tsx'
import type { AccountSectionState } from '../src/client/account-store.ts'
import { en, type AccountSettingsKey } from '../src/client/locales.ts'
import type {
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountDetails,
  AccountView,
  SignInAttemptId,
  SignInAttemptView,
} from '../src/client/types.ts'

// jsdom answers window.open with its own stub and a console complaint; the row is
// asserted on the calls it makes, so the browser's answer is not the subject here.
beforeEach(() => { vi.spyOn(window, 'open').mockImplementation(() => null) })
afterEach(() => { vi.restoreAllMocks() })
afterEach(cleanup)

/** Program links every view carries. */
const LINKS = {
  usageUrl: 'https://platform.example/usage',
  topUpUrl: 'https://platform.example/top-up',
}

/** Attempt every sign-in case drives. */
const ATTEMPT_ID = 'attempt-1' as SignInAttemptId

/** Authorization page the attempt carries while it is active. */
const AUTHORIZE_URL = 'https://platform.example/authorize'

/** How the running-task probe answers a confirmation case. */
type RunningAnswer = boolean | undefined

/** The store state a row starts from, with nothing read yet. */
function emptyState(): AccountSectionState {
  return {
    view: undefined,
    profile: undefined,
    balance: undefined,
    failed: false,
    busy: false,
    notice: undefined,
  }
}

/** A signed-out view, optionally carrying one attempt. */
function signedOutView(attempt: AccountView['attempt'] = null): AccountView {
  return { status: 'signed-out', links: LINKS, attempt }
}

/** A view reporting a stored credential. */
function storedView(): AccountView {
  return { status: 'credential-stored', links: LINKS, attempt: null }
}

/** A settled profile read. */
function readyProfile(): AccountDetails['profile'] {
  return { status: 'ready', value: { id: null, name: 'Ada', contact: 'ada@example.com' } }
}

/** A settled balance read: one usable wallet and one empty one. */
function readyBalance(): AccountDetails['balance'] {
  return {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.50' }, { currency: 'USD', balance: '0.00' }],
    bonusWallets: [],
  }
}

/** One granted bonus, unexpired at the moment the case runs. */
function grantedNotice(orderId = 'order-1'): AccountBonusNotification {
  return {
    orderId: orderId as AccountBonusOrderId,
    campaign: 'launch',
    amount: '3.00',
    currency: 'CNY',
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    message: 'Launch bonus granted',
  }
}

/** One row harness: its props, its store, and every injected callback spy. */
function createRow(options: { readonly run?: RunningAnswer } = {}) {
  const store = createSnapshotStore<AccountSectionState>(emptyState())
  const begin = vi.fn()
  const leave = vi.fn()
  const signIn = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  const signOut = vi.fn(async () => {})
  const hasRunningAccountTasks = vi.fn(async () => options.run)
  const noticeShown = vi.fn()
  const noticeDismissed = vi.fn()
  const props = {
    hooks: { accountSection: store },
    useAccountSection: bindSnapshotSelector(store),
    t: (key: AccountSettingsKey): string => en[key],
    begin,
    leave,
    signIn,
    cancel,
    signOut,
    hasRunningAccountTasks,
    noticeShown,
    noticeDismissed,
  } as unknown as AccountSectionProps
  /** Publish one patch through the store the row renders. */
  const update = async (patch: Partial<AccountSectionState>): Promise<void> => {
    await act(async () => {
      store.update((draft) => { Object.assign(draft, patch) })
    })
  }
  return {
    props, store, update,
    begin, leave, signIn, cancel, signOut, hasRunningAccountTasks, noticeShown, noticeDismissed,
  }
}

/** Render one row harness. */
function renderRow(row: ReturnType<typeof createRow>): ReturnType<typeof render> {
  return render(<AccountSection {...row.props} />)
}

/** Every sign-in phase with the status line and cancel arm the source gives it. */
const PHASE_CASES: readonly {
  readonly phase: SignInAttemptView['phase']
  readonly status: string | undefined
  readonly active: boolean
}[] = [
  { phase: 'initializing', status: en.initializing, active: true },
  { phase: 'waiting-browser', status: en.waiting, active: true },
  { phase: 'exchanging', status: en.completing, active: true },
  { phase: 'committing', status: en.completing, active: true },
  { phase: 'succeeded', status: undefined, active: false },
  { phase: 'cancelled', status: undefined, active: false },
  { phase: 'expired', status: en.expired, active: false },
  { phase: 'failed', status: undefined, active: false },
]

describe('AccountSection', () => {
  it('renders the signed-out rows and holds the notice lifecycle until the row unmounts', () => {
    const row = createRow()
    const view = renderRow(row)

    expect(row.begin).toHaveBeenCalledTimes(1)
    expect(row.leave).not.toHaveBeenCalled()
    expect(row.noticeShown).not.toHaveBeenCalled()
    expect(row.hasRunningAccountTasks).not.toHaveBeenCalled()

    expect(screen.getByText(en.balance)).toBeTruthy()
    expect(screen.getByText(en.bonusBalance)).toBeTruthy()
    expect(screen.getAllByText(en.balanceSignedOut)).toHaveLength(2)
    expect(screen.getByRole('button', { name: en.signIn })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.cancel })).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    view.unmount()
    expect(row.leave).toHaveBeenCalledTimes(1)
  })

  it('reports the failed and busy arms of the signed-out row', async () => {
    const row = createRow()
    renderRow(row)

    await row.update({ failed: true, busy: true })

    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    const signIn = screen.getByRole('button', { name: en.signIn })
    expect((signIn as HTMLButtonElement).disabled).toBe(true)
    expect(row.begin).toHaveBeenCalledTimes(1)
  })

  it('renders every sign-in phase with its status line, cancel arm, and authorization link', async () => {
    const row = createRow()
    renderRow(row)

    for (const { phase, status, active } of PHASE_CASES) {
      await row.update({
        view: signedOutView({
          id: ATTEMPT_ID,
          phase,
          ...(active ? { authorizeUrl: AUTHORIZE_URL } : {}),
        }),
      })

      expect(screen.queryByRole('status')?.textContent).toBe(status)
      expect(screen.queryByRole('button', { name: en.cancel }) === null).toBe(!active)
      expect(screen.queryByRole('link', { name: en.open }) === null).toBe(!active)
    }
  })

  it('opens each attempt page once and leaves the anchor as the fallback', async () => {
    const row = createRow()
    renderRow(row)
    const open = vi.mocked(window.open)

    expect(open).not.toHaveBeenCalled()

    await row.update({
      view: signedOutView({ id: ATTEMPT_ID, phase: 'waiting-browser', authorizeUrl: AUTHORIZE_URL }),
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank', 'noopener,noreferrer')
    expect(screen.getByRole('link', { name: en.open }).getAttribute('href')).toBe(AUTHORIZE_URL)

    // The same attempt republished and then advanced must not open a second page,
    // and a waiting attempt that carries no URL yet opens nothing either.
    await row.update({
      view: signedOutView({ id: ATTEMPT_ID, phase: 'waiting-browser', authorizeUrl: AUTHORIZE_URL }),
    })
    await row.update({
      view: signedOutView({ id: ATTEMPT_ID, phase: 'exchanging', authorizeUrl: AUTHORIZE_URL }),
    })
    await row.update({ view: signedOutView({ id: ATTEMPT_ID, phase: 'waiting-browser' }) })
    expect(open).toHaveBeenCalledTimes(1)

    // A second attempt gets its own page, and an attempt that never reached the
    // browser opens none.
    await row.update({
      view: signedOutView({
        id: 'attempt-2' as SignInAttemptId,
        phase: 'waiting-browser',
        authorizeUrl: 'https://platform.example/authorize-2',
      }),
    })
    expect(open).toHaveBeenCalledTimes(2)
    await row.update({ view: signedOutView({ id: ATTEMPT_ID, phase: 'initializing' }) })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('calls the injected action for each signed-out gesture', async () => {
    const row = createRow()
    renderRow(row)
    await row.update({
      view: signedOutView({ id: ATTEMPT_ID, phase: 'waiting-browser', authorizeUrl: AUTHORIZE_URL }),
    })

    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    expect(row.signIn).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(row.cancel).toHaveBeenCalledWith(ATTEMPT_ID)

    const link = screen.getByRole('link', { name: en.open })
    expect(link.getAttribute('href')).toBe(AUTHORIZE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('renders the stored-credential profile arms and the Platform links', async () => {
    const row = createRow()
    renderRow(row)

    await row.update({ view: storedView(), balance: readyBalance() })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
    expect(screen.getByText('¥12.50 · $0.00')).toBeTruthy()
    expect(screen.getByText('¥12.50')).toBeTruthy()
    expect(screen.getByRole('link', { name: en.usage }).getAttribute('href')).toBe(LINKS.usageUrl)
    expect(screen.getByRole('link', { name: en.topUp }).getAttribute('href')).toBe(LINKS.topUpUrl)
    expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
    expect(screen.getByRole('button', { name: en.signOut })).toBeTruthy()

    await row.update({ profile: { status: 'failed' } })
    expect(screen.getByText(`${en.signedIn} · ${en.profileUnavailable}`)).toBeTruthy()

    await row.update({ profile: readyProfile() })
    expect(screen.getByText(`${en.signedIn} · Ada`)).toBeTruthy()

    await row.update({ failed: true })
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
  })

  it('renders the loading, unavailable, empty, and granted wallet arms', async () => {
    const row = createRow()
    renderRow(row)

    await row.update({ view: storedView() })
    expect(screen.getAllByText(en.loading)).toHaveLength(2)

    await row.update({ balance: { status: 'failed' } })
    expect(screen.getAllByText(en.balanceUnavailable)).toHaveLength(2)

    await row.update({ balance: { status: 'ready', value: [], bonusWallets: [] } })
    expect(screen.getByText(en.balanceUnavailable)).toBeTruthy()
    expect(screen.getByText(en.bonusEmpty)).toBeTruthy()

    await row.update({
      balance: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '-5.00' }, { currency: 'USD', balance: '0.00' }],
        bonusWallets: [],
      },
    })
    expect(screen.getByText('-¥5.00 · $0.00')).toBeTruthy()
    expect(screen.getByText(en.bonusEmpty)).toBeTruthy()

    await row.update({ balance: readyBalance() })
    expect(screen.getByText('¥12.50 · $0.00')).toBeTruthy()
    expect(screen.getByText('¥12.50')).toBeTruthy()
  })

  const signOutArms: readonly (readonly [RunningAnswer, string])[] = [
    [true, en.signOutRunningDescription],
    [false, en.signOutDescription],
    [undefined, en.signOutUnknownDescription],
  ]

  it.each(signOutArms)('confirms sign-out when the running-task probe answers %s', async (run, copy) => {
    const row = createRow({ run })
    renderRow(row)
    await row.update({ view: storedView(), profile: readyProfile(), balance: readyBalance() })

    expect(row.hasRunningAccountTasks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect(row.hasRunningAccountTasks).toHaveBeenCalledTimes(1)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(copy) })
    expect(row.signOut).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(row.signOut).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(copy) })
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))

    await waitFor(() => { expect(row.signOut).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the granted-bonus card, reports each order once, and dismisses it', async () => {
    const row = createRow()
    renderRow(row)

    const notice = grantedNotice()
    await row.update({ notice })
    expect(row.noticeShown).toHaveBeenCalledTimes(1)
    expect(row.noticeShown).toHaveBeenCalledWith(notice.orderId)
    const card = screen.getByRole('status')
    expect(card.textContent).toContain(en.bonusNoticeTitle)
    expect(card.textContent).toContain(notice.message)

    await row.update({ notice: { ...notice } })
    expect(row.noticeShown).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(row.noticeDismissed).toHaveBeenCalledWith(notice.orderId)

    const next = grantedNotice('order-2')
    await row.update({ notice: next })
    expect(row.noticeShown).toHaveBeenCalledTimes(2)
    expect(row.noticeShown).toHaveBeenLastCalledWith(next.orderId)

    await row.update({ notice: undefined })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
