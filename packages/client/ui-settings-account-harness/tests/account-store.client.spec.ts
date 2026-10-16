// @vitest-environment jsdom
/**
 * Account section controller: the Host sign-in stream, the profile and balance
 * reads, the sign-in, cancel, and sign-out operations, the running-task probe,
 * and the granted-bonus notice the store publishes.
 *
 * The fake Context carries only what the controller reads: `remote.account`
 * (every method a spy with a benign default), `remote.$stream` (a hand-written
 * stand-in for the Gateway's `RemoteStream`), and the active locale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { AccountSectionController } from '../src/client/account-store.ts'
import type {
  AccountBonusBatch,
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountClientMetadata,
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

/** Program links every view carries. */
const LINKS = {
  usageUrl: 'https://platform.example/usage',
  topUpUrl: 'https://platform.example/top-up',
}

/** Controllers the current case created, ended again in `afterEach`. */
const created: AccountSectionController[] = []

/** One Remote answer, discriminated the way `RemoteResult` is. */
type Answer<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: RemoteError }

/** A successful Remote answer. */
function ok<Value>(value: Value): Answer<Value> {
  return { ok: true, value }
}

/** A failed Remote answer; the controller discriminates on `ok` alone. */
function fail(): Answer<never> {
  return { ok: false, error: new RemoteError('gateway/internal', 'account remote failed', {}) }
}

/** A promise whose settlement the case controls, for reads that must stay open. */
function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** The view the Host reports with no stored credential. */
function signedOutView(): AccountView {
  return { status: 'signed-out', links: LINKS, attempt: null }
}

/** The view the Host reports once a credential is stored. */
function storedView(): AccountView {
  return { status: 'credential-stored', links: LINKS, attempt: null }
}

/** A settled profile read. */
function readyProfile(): AccountDetails['profile'] {
  return {
    status: 'ready',
    value: { id: 'user-1' as AccountUserId, name: 'Ada', contact: 'ada@example.com' },
  }
}

/** A settled balance read. */
function readyBalance(): AccountDetails['balance'] {
  return {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.50' }],
    bonusWallets: [{ currency: 'CNY', balance: '3.00' }],
  }
}

/** One granted bonus, unexpired at the fake clock's now. */
function grantedBonus(orderId = 'order-1'): AccountBonusNotification {
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

/** An unnotified-bonus batch for the spec's account. */
function bonusBatch(bonuses: readonly AccountBonusNotification[]): AccountBonusBatch {
  return { accountId: ACCOUNT_ID, bonuses }
}

/** The request identity every account call must carry. */
function accountClient(): AccountClientMetadata {
  return {
    version: CLIENT_VERSION,
    locale: ACTIVE_LOCALE,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** Let every pending microtask and due timer run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Queue-backed async iterable: the case pushes Host items and the consumer
 * receives them in order, one at a time. Closing it completes a waiting pull.
 */
class ScriptedQueue<Item> implements AsyncIterable<Item> {
  private readonly queued: Item[] = []
  private waiter: ((result: IteratorResult<Item>) => void) | undefined
  private closed = false

  /** Hand one item to the consumer, or hold it until one is waiting. */
  push(value: Item): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter === undefined) {
      this.queued.push(value)
      return
    }
    this.waiter = undefined
    waiter({ done: false, value })
  }

  /** End the iterable: a waiting consumer observes completion. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<Item> {
    return {
      next: (): Promise<IteratorResult<Item>> => {
        if (this.queued.length > 0) return Promise.resolve({ done: false, value: this.queued.shift() as Item })
        if (this.closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
      return: (): Promise<IteratorResult<Item>> => {
        this.close()
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }
}

/** One stream frame, shaped like the Gateway's `RemoteStreamItem`. */
interface ScriptedFrame<Item> {
  /** Monotonic frame identity within the stream. */
  readonly generation: number
  /** Host value the frame carries. */
  readonly value: Item
  /** Signal that aborts when the stream is disposed. */
  readonly signal: AbortSignal
  /** Spy standing in for `RemoteStreamItem.accept`. */
  readonly accept: ReturnType<typeof vi.fn>
}

/** The `$stream` options object the controller passes. */
interface ScriptedStreamOptions<Item> {
  /** Diagnostic name the controller gives the stream. */
  readonly name: string
  /** Open the Host-side iterable for one generation. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** Classify a normal end of the Host iterable. */
  readonly ended: (accepted: boolean) => Error
}

/**
 * Hand-written stand-in for the Gateway's `RemoteStream`: it opens the Host
 * iterable through the controller's own `open` option, hands out one
 * `{ generation, value, signal, accept }` frame per Host item, and calls
 * `ended(accepted)` when that iterable completes. `dispose()` aborts the
 * generation signal, which is what ends the Host iterable here.
 *
 * Unlike the real stream it records the `ended` error instead of throwing it:
 * the controller consumes the stream through `void this.consume(...)`, so a
 * thrown terminal error would surface as an unhandled rejection rather than as
 * a state transition the spec can observe.
 */
class ScriptedRemoteStream<Item> implements AsyncIterable<ScriptedFrame<Item>> {
  /** Frames handed to the controller, in delivery order. */
  readonly frames: ScriptedFrame<Item>[] = []

  /** Error `ended(accepted)` produced once the Host iterable completed. */
  endedWith: Error | undefined

  /** Signal handed to the controller's `open` option. */
  private readonly generation = new AbortController()

  /** Host-side iteration opened through the controller's own `open`. */
  private readonly source: AsyncIterator<Item>

  /** Highest generation handed out so far. */
  private generationId = 0

  /** Whether any handed-out frame was accepted. */
  private accepted = false

  /** Spy standing in for `RemoteStream.dispose`. */
  readonly dispose = vi.fn(async (): Promise<void> => {
    this.generation.abort(new Error('account state stream disposed'))
  })

  /** @param options - the options object the controller passed to `$stream`. */
  constructor(private readonly options: ScriptedStreamOptions<Item>) {
    this.source = options.open(this.generation.signal)[Symbol.asyncIterator]()
  }

  [Symbol.asyncIterator](): AsyncIterator<ScriptedFrame<Item>> {
    return {
      next: (): Promise<IteratorResult<ScriptedFrame<Item>>> => this.pull(),
      return: async (): Promise<IteratorResult<ScriptedFrame<Item>>> => {
        await this.source.return?.()
        return { done: true, value: undefined }
      },
    }
  }

  /** Pull one Host item and wrap it in the frame the controller expects. */
  private async pull(): Promise<IteratorResult<ScriptedFrame<Item>>> {
    const result = await this.source.next()
    if (result.done === true) {
      this.endedWith = this.options.ended(this.accepted)
      return { done: true, value: undefined }
    }
    const frame: ScriptedFrame<Item> = {
      generation: (this.generationId += 1),
      value: result.value,
      signal: this.generation.signal,
      accept: vi.fn(() => {
        this.accepted = true
      }),
    }
    this.frames.push(frame)
    return { done: false, value: frame }
  }
}

/** The `ctx.remote.account` surface, every method a spy with a benign default. */
function createAccountRemote(queue: ScriptedQueue<AccountView>) {
  return {
    getUnnotifiedBonuses: vi.fn(async (): Promise<Answer<AccountBonusBatch | null>> => ok(null)),
    ackBonusNotified: vi.fn(async (): Promise<Answer<boolean>> => ok(true)),
    startSignIn: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    cancelSignIn: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    hasRunningAccountTasks: vi.fn(async (): Promise<Answer<boolean>> => ok(true)),
    signOut: vi.fn(async (): Promise<Answer<AccountView>> => ok(signedOutView())),
    getProfile: vi.fn(async (): Promise<Answer<AccountDetails['profile'] | null>> => ok(readyProfile())),
    getBalance: vi.fn(async (): Promise<Answer<AccountDetails['balance'] | null>> => ok(readyBalance())),
    watch: vi.fn((signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => {
        queue.close()
      }, { once: true })
      return queue
    }),
  }
}

/**
 * Build one controller over a fake Context and register it for teardown.
 * @returns the controller plus every handle the case needs to drive it.
 */
function createHarness() {
  const watch = new ScriptedQueue<AccountView>()
  const account = createAccountRemote(watch)
  const streams: ScriptedRemoteStream<AccountView>[] = []
  const streamOptions: ScriptedStreamOptions<AccountView>[] = []
  const remote = {
    account,
    $stream: (options: ScriptedStreamOptions<AccountView>): ScriptedRemoteStream<AccountView> => {
      streamOptions.push(options)
      const stream = new ScriptedRemoteStream(options)
      streams.push(stream)
      return stream
    },
  }
  const ctx = {
    remote,
    locale: { getLocale: () => ({ active: ACTIVE_LOCALE }) },
  } as unknown as Context
  const controller = new AccountSectionController(ctx)
  created.push(controller)
  return { controller, account, watch, streams, streamOptions }
}

/** The frame a scripted stream delivered at one index. */
function frameAt(index: number, stream: ScriptedRemoteStream<AccountView> | undefined): ScriptedFrame<AccountView> {
  const frame = stream?.frames[index]
  if (frame === undefined) throw new Error(`scripted stream delivered no frame at index ${index}`)
  return frame
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('DSH_CLIENT_VERSION', CLIENT_VERSION)
  created.length = 0
})

afterEach(async () => {
  for (const controller of created) controller.end()
  await vi.advanceTimersByTimeAsync(0)
  created.length = 0
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('AccountSectionController', () => {
  it('starts empty and idle', () => {
    const h = createHarness()

    const state = h.controller.store.getSnapshot()
    expect(state.view).toBeUndefined()
    expect(state.profile).toBeUndefined()
    expect(state.balance).toBeUndefined()
    expect(state.failed).toBe(false)
    expect(state.busy).toBe(false)
    expect(state.notice).toBeUndefined()
  })

  describe('the Host sign-in stream', () => {
    it('applies every frame, accepts it, and reads no details for a signed-out view', async () => {
      const h = createHarness()
      h.controller.store.update((draft) => {
        draft.profile = readyProfile()
        draft.balance = readyBalance()
        draft.failed = true
      })

      h.controller.start()
      expect(h.streamOptions[0]?.name).toBe('account state stream')

      h.watch.push(signedOutView())
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.view).toMatchObject({ status: 'signed-out' })
      expect(state.profile).toBeUndefined()
      expect(state.balance).toBeUndefined()
      expect(state.failed).toBe(false)
      expect(state.busy).toBe(false)
      expect(frameAt(0, h.streams[0]).accept).toHaveBeenCalledTimes(1)
      expect(h.account.getProfile).not.toHaveBeenCalled()
      expect(h.account.getBalance).not.toHaveBeenCalled()
    })

    it('begins the notice lifecycle and refreshes the details on a credential-stored frame', async () => {
      const h = createHarness()
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([grantedBonus()])))

      h.controller.start()
      h.watch.push(storedView())
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.view).toMatchObject({ status: 'credential-stored' })
      expect(state.profile).toEqual(readyProfile())
      expect(state.balance).toEqual(readyBalance())
      expect(state.notice).toEqual(grantedBonus())
      expect(h.account.getProfile).toHaveBeenCalledWith(accountClient())
      expect(h.account.getBalance).toHaveBeenCalledWith(accountClient())
      expect(h.account.getUnnotifiedBonuses).toHaveBeenCalledWith(accountClient())
    })

    it('end() aborts the Host stream, stops the notice lifecycle, and drops later frames', async () => {
      const h = createHarness()
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([grantedBonus()])))
      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.controller.store.getSnapshot().notice).toEqual(grantedBonus())

      h.controller.end()

      expect(h.streams[0]?.dispose).toHaveBeenCalledTimes(1)
      expect(h.account.watch.mock.calls[0]?.[0]?.aborted).toBe(true)
      expect(h.controller.store.getSnapshot().notice).toBeUndefined()

      h.watch.push(signedOutView())
      await settle()

      expect(h.controller.store.getSnapshot().view).toMatchObject({ status: 'credential-stored' })
      expect(h.streams[0]?.endedWith).toBeInstanceOf(Error)
    })

    it('drops a frame that lands after end() aborted the stream', async () => {
      const h = createHarness()
      h.controller.start()

      h.watch.push(storedView())
      h.controller.end()
      await settle()

      expect(h.controller.store.getSnapshot().view).toBeUndefined()
      expect(frameAt(0, h.streams[0]).accept).not.toHaveBeenCalled()
      expect(h.account.getProfile).not.toHaveBeenCalled()
    })

    it('mounted() refreshes and begins the notice lifecycle; unmounted() ends it', async () => {
      const h = createHarness()
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([grantedBonus()])))

      h.controller.mounted()
      await settle()

      expect(h.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1)
      expect(h.controller.store.getSnapshot().notice).toEqual(grantedBonus())

      h.controller.unmounted()
      expect(h.controller.store.getSnapshot().notice).toBeUndefined()
    })
  })

  describe('refresh()', () => {
    it('does nothing until the Host stream reports a stored credential', async () => {
      const h = createHarness()
      h.controller.start()

      await h.controller.refresh()
      expect(h.account.getProfile).not.toHaveBeenCalled()

      h.watch.push(signedOutView())
      await settle()

      await h.controller.refresh()
      expect(h.account.getProfile).not.toHaveBeenCalled()
    })

    it('reads both fields once, refuses a concurrent read, and reads again once settled', async () => {
      const h = createHarness()
      const profile = deferred<Answer<AccountDetails['profile'] | null>>()
      const balance = deferred<Answer<AccountDetails['balance'] | null>>()
      h.account.getProfile.mockReturnValue(profile.promise)
      h.account.getBalance.mockReturnValue(balance.promise)

      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.account.getProfile).toHaveBeenCalledTimes(1)
      expect(h.account.getBalance).toHaveBeenCalledTimes(1)

      await h.controller.refresh()
      expect(h.account.getProfile).toHaveBeenCalledTimes(1)

      profile.resolve(ok(readyProfile()))
      balance.resolve(ok(readyBalance()))
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.profile).toEqual(readyProfile())
      expect(state.balance).toEqual(readyBalance())

      h.account.getProfile.mockResolvedValue(ok(readyProfile()))
      h.account.getBalance.mockResolvedValue(ok(readyBalance()))
      await h.controller.refresh()
      expect(h.account.getProfile).toHaveBeenCalledTimes(2)
    })

    it('folds a rejected read and a failed answer into the failed arm', async () => {
      const h = createHarness()
      h.account.getProfile.mockRejectedValue(new Error('profile read failed'))
      h.account.getBalance.mockResolvedValue(fail())

      h.controller.start()
      h.watch.push(storedView())
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.profile).toEqual({ status: 'failed' })
      expect(state.balance).toEqual({ status: 'failed' })
    })

    it('folds a null detail value into the failed arm', async () => {
      const h = createHarness()
      h.account.getProfile.mockResolvedValue(ok(null))
      h.account.getBalance.mockResolvedValue(ok(null))

      h.controller.start()
      h.watch.push(storedView())
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.profile).toEqual({ status: 'failed' })
      expect(state.balance).toEqual({ status: 'failed' })
    })

    it('drops a read that settles after a newer frame moved the revision on', async () => {
      const h = createHarness()
      const profile = deferred<Answer<AccountDetails['profile'] | null>>()
      const balance = deferred<Answer<AccountDetails['balance'] | null>>()
      h.account.getProfile.mockReturnValue(profile.promise)
      h.account.getBalance.mockReturnValue(balance.promise)

      h.controller.start()
      h.watch.push(storedView())
      await settle()

      h.watch.push(signedOutView())
      await settle()

      profile.resolve(ok(readyProfile()))
      balance.resolve(ok(readyBalance()))
      await settle()

      const state = h.controller.store.getSnapshot()
      expect(state.view).toMatchObject({ status: 'signed-out' })
      expect(state.profile).toBeUndefined()
      expect(state.balance).toBeUndefined()
    })
  })

  describe('signIn()', () => {
    it('marks the store busy, opens a desktop attempt at the window origin, and adopts the view', async () => {
      const h = createHarness()
      const answer = deferred<Answer<AccountView>>()
      h.account.startSignIn.mockReturnValue(answer.promise)

      const starting = h.controller.signIn()
      expect(h.controller.store.getSnapshot().busy).toBe(true)
      expect(h.account.startSignIn).toHaveBeenCalledWith(accountClient(), window.location.origin, 'desktop')

      answer.resolve(ok(storedView()))
      await starting

      const state = h.controller.store.getSnapshot()
      expect(state.busy).toBe(false)
      expect(state.failed).toBe(false)
      expect(state.view).toMatchObject({ status: 'credential-stored' })
    })

    it('clears an earlier failure when a later attempt succeeds', async () => {
      const h = createHarness()
      h.account.startSignIn.mockResolvedValueOnce(fail())

      await h.controller.signIn()
      expect(h.controller.store.getSnapshot().failed).toBe(true)
      expect(h.controller.store.getSnapshot().view).toBeUndefined()

      h.account.startSignIn.mockResolvedValueOnce(ok(storedView()))
      await h.controller.signIn()

      const state = h.controller.store.getSnapshot()
      expect(state.failed).toBe(false)
      expect(state.busy).toBe(false)
      expect(state.view).toMatchObject({ status: 'credential-stored' })
    })

    it('sets failed and keeps the view when the call rejects', async () => {
      const h = createHarness()
      h.controller.start()
      h.watch.push(storedView())
      await settle()
      h.account.startSignIn.mockRejectedValue(new Error('platform unreachable'))

      await h.controller.signIn()

      const state = h.controller.store.getSnapshot()
      expect(state.failed).toBe(true)
      expect(state.busy).toBe(false)
      expect(state.view).toMatchObject({ status: 'credential-stored' })
    })
  })

  describe('cancel()', () => {
    it('marks the store busy, cancels the attempt, and adopts the returned view', async () => {
      const h = createHarness()
      const answer = deferred<Answer<AccountView>>()
      h.account.cancelSignIn.mockReturnValue(answer.promise)
      const attemptId = 'attempt-1' as SignInAttemptId

      const cancelling = h.controller.cancel(attemptId)
      expect(h.controller.store.getSnapshot().busy).toBe(true)
      expect(h.account.cancelSignIn).toHaveBeenCalledWith(attemptId)

      answer.resolve(ok(signedOutView()))
      await cancelling

      const state = h.controller.store.getSnapshot()
      expect(state.busy).toBe(false)
      expect(state.failed).toBe(false)
      expect(state.view).toMatchObject({ status: 'signed-out' })
    })

    it('sets failed on a failed answer and on a rejection, leaving the view alone', async () => {
      const h = createHarness()
      h.controller.start()
      h.watch.push(storedView())
      await settle()

      h.account.cancelSignIn.mockResolvedValueOnce(fail())
      await h.controller.cancel('attempt-2' as SignInAttemptId)
      expect(h.controller.store.getSnapshot().failed).toBe(true)
      expect(h.controller.store.getSnapshot().view).toMatchObject({ status: 'credential-stored' })

      h.account.cancelSignIn.mockRejectedValueOnce(new Error('host gone'))
      await h.controller.cancel('attempt-3' as SignInAttemptId)

      const state = h.controller.store.getSnapshot()
      expect(state.failed).toBe(true)
      expect(state.busy).toBe(false)
      expect(state.view).toMatchObject({ status: 'credential-stored' })
    })
  })

  describe('hasRunningAccountTasks()', () => {
    it('reports the Host answer and folds every failure to undefined', async () => {
      const h = createHarness()
      h.account.hasRunningAccountTasks.mockResolvedValueOnce(ok(true))
      await expect(h.controller.hasRunningAccountTasks()).resolves.toBe(true)

      h.account.hasRunningAccountTasks.mockResolvedValueOnce(ok(false))
      await expect(h.controller.hasRunningAccountTasks()).resolves.toBe(false)

      h.account.hasRunningAccountTasks.mockResolvedValueOnce(fail())
      await expect(h.controller.hasRunningAccountTasks()).resolves.toBeUndefined()

      h.account.hasRunningAccountTasks.mockRejectedValueOnce(new Error('host gone'))
      await expect(h.controller.hasRunningAccountTasks()).resolves.toBeUndefined()
    })
  })

  describe('signOut()', () => {
    it('marks the store busy, drops the credential view, and clears every detail read', async () => {
      const h = createHarness()
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([grantedBonus()])))
      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.controller.store.getSnapshot().profile).toEqual(readyProfile())
      expect(h.controller.store.getSnapshot().notice).toEqual(grantedBonus())

      const answer = deferred<Answer<AccountView>>()
      h.account.signOut.mockReturnValue(answer.promise)

      const signingOut = h.controller.signOut()
      expect(h.controller.store.getSnapshot().busy).toBe(true)
      expect(h.account.signOut).toHaveBeenCalledWith(accountClient())

      answer.resolve(ok(signedOutView()))
      await signingOut

      const state = h.controller.store.getSnapshot()
      expect(state.busy).toBe(false)
      expect(state.failed).toBe(false)
      expect(state.view).toMatchObject({ status: 'signed-out' })
      expect(state.profile).toBeUndefined()
      expect(state.balance).toBeUndefined()
      expect(state.notice).toBeUndefined()
    })

    it('sets failed on a failed answer and on a rejection without clearing the view', async () => {
      const h = createHarness()
      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.controller.store.getSnapshot().view).toMatchObject({ status: 'credential-stored' })

      h.account.signOut.mockResolvedValueOnce(fail())
      await h.controller.signOut()
      expect(h.controller.store.getSnapshot().failed).toBe(true)
      expect(h.controller.store.getSnapshot().view).toMatchObject({ status: 'credential-stored' })

      h.account.signOut.mockRejectedValueOnce(new Error('host gone'))
      await h.controller.signOut()

      const state = h.controller.store.getSnapshot()
      expect(state.failed).toBe(true)
      expect(state.busy).toBe(false)
      expect(state.view).toMatchObject({ status: 'credential-stored' })
      expect(state.notice).toBeUndefined()
    })
  })

  describe('the granted-bonus notice', () => {
    it('keeps the notice empty when the bonus read fails', async () => {
      const h = createHarness()
      h.account.getUnnotifiedBonuses.mockResolvedValue(fail())

      h.controller.start()
      h.watch.push(storedView())
      await settle()

      expect(h.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1)
      expect(h.controller.store.getSnapshot().notice).toBeUndefined()
    })

    it('acknowledges a shown notice and retries a rejected acknowledgement with backoff', async () => {
      const h = createHarness()
      const bonus = grantedBonus('order-shown')
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([bonus])))
      h.account.ackBonusNotified.mockResolvedValueOnce(fail())

      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.controller.store.getSnapshot().notice).toEqual(bonus)

      h.controller.noticeShown(bonus.orderId)
      await vi.advanceTimersByTimeAsync(0)

      expect(h.account.ackBonusNotified).toHaveBeenCalledTimes(1)
      expect(h.account.ackBonusNotified).toHaveBeenCalledWith(ACCOUNT_ID, bonus.orderId, accountClient())

      await vi.advanceTimersByTimeAsync(1000)

      expect(h.account.ackBonusNotified).toHaveBeenCalledTimes(2)
      expect(h.controller.store.getSnapshot().notice).toEqual(bonus)
    })

    it('dismisses a notice: acknowledge its order and clear the card', async () => {
      const h = createHarness()
      const bonus = grantedBonus('order-dismissed')
      h.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch([bonus])))

      h.controller.start()
      h.watch.push(storedView())
      await settle()
      expect(h.controller.store.getSnapshot().notice).toEqual(bonus)

      h.controller.noticeDismissed(bonus.orderId)
      expect(h.controller.store.getSnapshot().notice).toBeUndefined()

      await vi.advanceTimersByTimeAsync(0)
      expect(h.account.ackBonusNotified).toHaveBeenCalledTimes(1)
      expect(h.account.ackBonusNotified).toHaveBeenCalledWith(ACCOUNT_ID, bonus.orderId, accountClient())
    })
  })
})
