// @vitest-environment jsdom
/**
 * Account & balance plugin, browser half: the copy dictionaries and account
 * stream it registers as effects, and the `settings.section` contribution whose
 * inject face drives the row's controller.
 *
 * The fake Context records every registration `apply` makes, so each case can
 * run an effect's disposer, run the slot injection, and call one injected
 * callback to observe the Remote call behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote'
import { AccountSection, type AccountSectionInjected } from '../src/client/AccountSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh, type AccountSettingsKey } from '../src/client/locales.ts'
import type {
  AccountBonusBatch,
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountDetails,
  AccountUserId,
  AccountView,
  SignInAttemptId,
} from '../src/client/types.ts'

/** Client build version the spec stubs onto the bundle-side env read. */
const CLIENT_VERSION = '0.1.5-rc.26'

/** Active UI language the fake locale service reports. */
const ACTIVE_LOCALE = 'zh-CN'

/** Account every fixture belongs to. */
const ACCOUNT_ID = 'account-1' as AccountUserId

/** Order the granted-bonus fixture carries. */
const ORDER_ID = 'order-1' as AccountBonusOrderId

/** Program links every view carries. */
const LINKS = {
  usageUrl: 'https://platform.example/usage',
  topUpUrl: 'https://platform.example/top-up',
}

/** Harnesses the current case created, disposed again in `afterEach`. */
const created: { readonly effectDisposers: readonly (() => void)[] }[] = []

/** One Remote answer, discriminated the way `RemoteResult` is. */
type Answer<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: unknown }

/** A successful Remote answer. */
function ok<Value>(value: Value): Answer<Value> {
  return { ok: true, value }
}

/** The view the Host reports with no stored credential. */
function signedOutView(): AccountView {
  return { status: 'signed-out', links: LINKS, attempt: null }
}

/** A settled profile read. */
function readyProfile(): AccountDetails['profile'] {
  return { status: 'ready', value: { id: null, name: 'Ada', contact: 'ada@example.com' } }
}

/** A settled balance read. */
function readyBalance(): AccountDetails['balance'] {
  return { status: 'ready', value: [{ currency: 'CNY', balance: '12.50' }], bonusWallets: [] }
}

/** One granted bonus, unexpired at the moment the case runs. */
function grantedNotice(): AccountBonusNotification {
  return {
    orderId: ORDER_ID,
    campaign: 'launch',
    amount: '3.00',
    currency: 'CNY',
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    message: 'Launch bonus granted',
  }
}

/** One unnotified-bonus batch for the spec's account. */
function bonusBatch(bonuses: readonly AccountBonusNotification[]): AccountBonusBatch {
  return { accountId: ACCOUNT_ID, bonuses }
}

/** Let every pending microtask and due timer run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** The `settings.section` registration `apply` performs. */
interface RegisteredRow {
  /** Slot the row belongs to. */
  readonly name: string
  /** Row identity inside that slot. */
  readonly id: string
  /** Sort order among the slot's rows. */
  readonly order: number
  /** Nav label thunk, bound to the plugin's dictionary namespace. */
  readonly label: () => string
  /** Locale namespace the row's copy comes from. */
  readonly locale: string
  /** Build the row's injected face. */
  readonly inject: () => AccountSectionInjected
}

/**
 * Build one fake client Context plus every registration the case inspects: the
 * namespace mount, the effect labels and disposers, the dictionary
 * registration, the slot injection, and the `settings.section` register call
 * that injection performs.
 */
function createHarness() {
  const account = {
    getUnnotifiedBonuses: vi.fn(async (): Promise<Answer<AccountBonusBatch | null>> => ok(null)),
    ackBonusNotified: vi.fn(async (): Promise<Answer<boolean>> => ok(true)),
    startSignIn: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    cancelSignIn: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    hasRunningAccountTasks: vi.fn(async (): Promise<Answer<boolean>> => ok(true)),
    signOut: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    getProfile: vi.fn(async (): Promise<Answer<AccountDetails['profile'] | null>> => ok(readyProfile())),
    getBalance: vi.fn(async (): Promise<Answer<AccountDetails['balance'] | null>> => ok(readyBalance())),
    watch: vi.fn(() => [] as AccountView[]),
  }
  const streamDispose = vi.fn(async () => {})
  const remoteStream = vi.fn((options: { readonly name: string }) => ({
    options,
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {},
    dispose: streamDispose,
  }))
  const dictionaryDispose = vi.fn()
  const localeRegistrations: { namespace: string; dictionaries: unknown }[] = []
  const boundNamespaces: string[] = []
  let boundDictionary: Record<AccountSettingsKey, string> = en
  const translate = vi.fn((key: AccountSettingsKey): string => boundDictionary[key])
  const effectLabels: string[] = []
  const effectDisposers: (() => void)[] = []
  const registered: { options: RegisteredRow; component: unknown; dispose: () => void }[] = []
  const register = vi.fn((options: RegisteredRow, component: unknown) => {
    const dispose = vi.fn()
    registered.push({ options, component, dispose })
    return dispose
  })
  const slotInjections: { name: string; callback: () => () => void }[] = []
  const slots = {
    register,
    inject: vi.fn((name: string, callback: () => () => void) => {
      slotInjections.push({ name, callback })
      return vi.fn()
    }),
  }
  const locale = {
    register: vi.fn((namespace: string, dictionaries: unknown) => {
      localeRegistrations.push({ namespace, dictionaries })
      return dictionaryDispose
    }),
    bind: vi.fn((namespace: string) => {
      boundNamespaces.push(namespace)
      return translate
    }),
    getLocale: () => ({ active: ACTIVE_LOCALE }),
  }
  const effect = vi.fn((callback: () => unknown, label: string) => {
    effectLabels.push(label)
    const result = callback()
    const dispose = (): void => {
      if (typeof result === 'function') (result as () => void)()
    }
    effectDisposers.push(dispose)
    return dispose
  })
  const unmount = vi.fn(async () => {})
  const mount = vi.fn(async () => unmount)
  const ctx = {
    effect,
    locale,
    slots,
    remote: { account, $mount: mount, $stream: remoteStream },
  } as unknown as Context
  created.push({ effectDisposers })
  return {
    ctx, account, mount, unmount, streamDispose, remoteStream, dictionaryDispose, localeRegistrations,
    boundNamespaces, translate, effectLabels, effectDisposers, registered, register,
    slotInjections,
    /** Swap the dictionary the fake locale service hands back to the label thunk. */
    setBoundDictionary: (next: Record<AccountSettingsKey, string>): void => { boundDictionary = next },
  }
}

/** Run the slot injection and read back the row registration it performs. */
function installRow(h: ReturnType<typeof createHarness>) {
  const injection = h.slotInjections[0]
  if (injection === undefined) throw new Error('apply registered no settings.section injection')
  const uninstall = injection.callback()
  const entry = h.registered[0]
  if (entry === undefined) throw new Error('the injection registered no section row')
  return { injection, uninstall, entry, face: entry.options.inject() }
}

beforeEach(() => {
  vi.stubEnv('DSH_CLIENT_VERSION', CLIENT_VERSION)
})

afterEach(() => {
  for (const harness of created) {
    for (const dispose of harness.effectDisposers) dispose()
  }
  created.length = 0
  vi.unstubAllEnvs()
})

describe('the account settings plugin', () => {
  it('declares the services the row waits on', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('mounts the account namespace, then registers the copy dictionaries and the account stream as effects', async () => {
    const h = createHarness()
    await apply(h.ctx)

    // The mount is what puts `remote.account` on this Client's Remote service:
    // no workspace Client assembly selects the namespace, so this half owns it.
    expect(h.mount).toHaveBeenCalledTimes(1)
    expect(h.mount).toHaveBeenCalledWith(accountRemote)

    expect(h.effectLabels).toEqual([
      'ui-settings-account-harness: account namespace',
      'ui-settings-account-harness: copy dictionaries',
      'ui-settings-account-harness: account state stream',
    ])
    expect(h.localeRegistrations).toEqual([
      { namespace: 'settings.account', dictionaries: { zh, en } },
    ])
    expect(h.remoteStream).toHaveBeenCalledTimes(1)
    expect(h.remoteStream.mock.calls[0]?.[0]).toMatchObject({ name: 'account state stream' })

    await settle()

    // Effects unwind in reverse registration order, so the namespace — registered
    // first — is the last thing to go.
    for (const dispose of h.effectDisposers) dispose()
    expect(h.dictionaryDispose).toHaveBeenCalledTimes(1)
    expect(h.streamDispose).toHaveBeenCalledTimes(1)
    expect(h.unmount).toHaveBeenCalledTimes(1)
  })

  it('registers the row only once the settings.section declaration arrives', async () => {
    const h = createHarness()
    await apply(h.ctx)

    expect(h.slotInjections.map(entry => entry.name)).toEqual(['settings.section'])
    expect(h.register).not.toHaveBeenCalled()

    const { uninstall, entry } = installRow(h)

    expect(h.register).toHaveBeenCalledTimes(1)
    expect(entry.component).toBe(AccountSection)
    expect(entry.options.name).toBe('settings.section')
    expect(entry.options.id).toBe('account')
    expect(entry.options.order).toBe(-10)
    expect(entry.options.locale).toBe('settings.account')
    expect(uninstall).toBe(entry.dispose)

    expect(h.boundNamespaces).toEqual(['settings.account'])
    expect(entry.options.label()).toBe(en.nav)
    expect(h.translate).toHaveBeenLastCalledWith('nav')

    h.setBoundDictionary(zh)
    expect(entry.options.label()).toBe(zh.nav)
  })

  it('wires every injected callback to the controller', async () => {
    const h = createHarness()
    await apply(h.ctx)
    const { face } = installRow(h)

    const metadata: unknown = expect.objectContaining({ version: CLIENT_VERSION, locale: ACTIVE_LOCALE })
    expect(face.hooks.accountSection.getSnapshot().failed).toBe(false)

    await face.signIn()
    expect(h.account.startSignIn).toHaveBeenCalledWith(metadata, window.location.origin, 'desktop')

    const attemptId = 'attempt-1' as SignInAttemptId
    await face.cancel(attemptId)
    expect(h.account.cancelSignIn).toHaveBeenCalledWith(attemptId)

    await face.signOut()
    expect(h.account.signOut).toHaveBeenCalledWith(metadata)

    await expect(face.hasRunningAccountTasks()).resolves.toBe(true)

    face.begin()
    await settle()
    expect(h.account.getUnnotifiedBonuses).toHaveBeenCalledWith(metadata)

    face.leave()
    face.noticeShown(ORDER_ID)
    face.noticeDismissed(ORDER_ID)
    expect(face.hooks.accountSection.getSnapshot().notice).toBeUndefined()
  })

  it('delivers a granted bonus through the injected notice callbacks', async () => {
    const h = createHarness()
    h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([grantedNotice()])))
    await apply(h.ctx)
    const { face } = installRow(h)

    face.begin()
    await settle()
    expect(face.hooks.accountSection.getSnapshot().notice?.orderId).toBe(ORDER_ID)

    face.noticeShown(ORDER_ID)
    await settle()
    expect(h.account.ackBonusNotified).toHaveBeenCalledWith(
      ACCOUNT_ID,
      ORDER_ID,
      expect.objectContaining({ version: CLIENT_VERSION }),
    )

    face.noticeDismissed(ORDER_ID)
    expect(face.hooks.accountSection.getSnapshot().notice).toBeUndefined()
  })
})
