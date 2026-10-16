// @vitest-environment jsdom
/**
 * Granted-bonus notice lifecycle: one card at a time, one read in force, and one
 * acknowledgement per card, retried with backoff until the Host accepts it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBonusNoticeController,
  type BonusNoticeController,
  type BonusNoticeControllerOptions,
} from '../src/client/bonus-notices.ts'
import type {
  AccountBonusBatch,
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountUserId,
} from '../src/client/types.ts'

const ACCOUNT_ONE = 'account-1' as AccountUserId
const ACCOUNT_TWO = 'account-2' as AccountUserId
const RETRY_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 3_000
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const NOT_EXPIRED = '2026-06-01T01:00:00.000Z'
const EXPIRED = '2026-05-31T23:00:00.000Z'

type Acknowledge = BonusNoticeControllerOptions['acknowledge']

/** One order id as the Host brands it. */
function order(id: string): AccountBonusOrderId {
  return id as AccountBonusOrderId
}

/** One bonus notification with every field a test does not override filled in. */
function bonus(id: string, overrides: Partial<AccountBonusNotification> = {}): AccountBonusNotification {
  return {
    orderId: order(id),
    campaign: 'launch',
    amount: '10.00',
    currency: 'CNY',
    grantedAt: '2026-05-31T00:00:00.000Z',
    expiresAt: NOT_EXPIRED,
    message: 'Bonus credited',
    ...overrides,
  }
}

/** One unnotified-bonus batch for an account. */
function batch(accountId: AccountUserId, ...bonuses: AccountBonusNotification[]): AccountBonusBatch {
  return { accountId, bonuses }
}

/** A promise the test settles by hand, so a read or acknowledgement can be held open. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** A read stub answering each call with the next queued promise, in order. */
function queuedReads(...queued: Promise<AccountBonusBatch | null>[]): () => Promise<AccountBonusBatch | null> {
  let issued = 0
  return () => {
    const next = queued[issued]
    issued += 1
    if (next === undefined) throw new Error('the controller issued an unexpected read')
    return next
  }
}

/** An acknowledge stub, defaulting to the Host accepting every order. */
function ackStub(implementation: Acknowledge = () => Promise.resolve(true)) {
  return vi.fn(implementation)
}

/** Drain pending microtasks without moving the fake clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

/** Only the cards published, without the nulls the lifecycle publishes to clear. */
function cards(published: readonly (AccountBonusNotification | null)[]): AccountBonusNotification[] {
  return published.filter((value): value is AccountBonusNotification => value !== null)
}

interface Sandbox {
  /** The lifecycle under test. */
  readonly controller: BonusNoticeController
  /** Everything the lifecycle published, in order. */
  readonly published: (AccountBonusNotification | null)[]
}

/** One controller over a read stub, plus everything it published. */
function sandbox(options: Partial<BonusNoticeControllerOptions> = {}): Sandbox {
  const published: (AccountBonusNotification | null)[] = []
  const controller = createBonusNoticeController({
    read: () => Promise.resolve(null),
    acknowledge: () => Promise.resolve(true),
    publish: (value) => { published.push(value) },
    retryDelayMs: RETRY_DELAY_MS,
    retryMaxDelayMs: RETRY_MAX_DELAY_MS,
    ...options,
  })
  return { controller, published }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createBonusNoticeController reads', () => {
  it('publishes the notice a read returns and clears it when the lifecycle ends', async () => {
    const read = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({ read: () => read.promise })

    controller.begin()
    // The surface starts empty; the read fills it.
    expect(published).toEqual([null])

    read.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    expect(cards(published)).toEqual([bonus('a')])

    controller.end()
    expect(published).toEqual([null, bonus('a'), null])
  })

  it('keeps only the newest read in force', async () => {
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({ read: queuedReads(first.promise, second.promise) })

    controller.begin()
    controller.begin()
    second.resolve(batch(ACCOUNT_ONE, bonus('b')))
    await settle()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()

    expect(cards(published)).toEqual([bonus('b')])
    controller.end()
  })

  it('ignores a read that answers after the lifecycle ended', async () => {
    const read = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({ read: () => read.promise })

    controller.begin()
    controller.end()
    read.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()

    expect(published).toEqual([null, null])
  })

  it('ignores a read left over from an earlier lifecycle', async () => {
    const stale = deferred<AccountBonusBatch | null>()
    const fresh = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({ read: queuedReads(stale.promise, fresh.promise) })

    controller.begin()
    controller.end()
    controller.begin()
    // The restart bumps the lifetime, so the first read no longer owns the surface.
    fresh.resolve(batch(ACCOUNT_ONE, bonus('fresh')))
    await settle()
    stale.resolve(batch(ACCOUNT_ONE, bonus('stale')))
    await settle()

    expect(cards(published)).toEqual([bonus('fresh')])
    controller.end()
  })

  it('treats a rejected read as no bonus available', async () => {
    const { controller, published } = sandbox({ read: queuedReads(Promise.reject(new Error('offline'))) })

    controller.begin()
    await settle()

    expect(published).toEqual([null])
    controller.end()
  })

  it('treats a null read as no bonus available', async () => {
    const { controller, published } = sandbox({ read: queuedReads(Promise.resolve(null)) })

    controller.begin()
    await settle()

    expect(published).toEqual([null])
    controller.end()
  })

  it('drops the card and its pending acknowledgement when the read names another account', async () => {
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const acknowledged = ackStub()
    const { controller, published } = sandbox({
      read: queuedReads(first.promise, second.promise),
      acknowledge: acknowledged,
    })

    controller.begin()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    controller.shown(order('a'))

    controller.begin()
    second.resolve(batch(ACCOUNT_TWO, bonus('b')))
    await settle()

    expect(cards(published)).toEqual([bonus('a'), bonus('b')])
    // Switching accounts clears the retry timer, so the first order is never acknowledged.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS * 2)
    expect(acknowledged).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    controller.end()
  })

  it('keeps an acknowledged card when the Host stops listing its order', async () => {
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const third = deferred<AccountBonusBatch | null>()
    const acknowledged = ackStub()
    const { controller, published } = sandbox({
      read: queuedReads(first.promise, second.promise, third.promise),
      acknowledge: acknowledged,
    })

    controller.begin()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)

    // Re-reading the same order republishes the card without forgetting that the
    // order is already acknowledged.
    controller.begin()
    second.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    expect(cards(published)).toEqual([bonus('a'), bonus('a')])

    // The Host drops a notified order from the batch only after it stored it.
    controller.begin()
    third.resolve(batch(ACCOUNT_ONE))
    await settle()
    expect(cards(published)).toEqual([bonus('a'), bonus('a')])

    controller.end()
  })

  it('drops an unacknowledged card when the Host stops listing its order', async () => {
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({ read: queuedReads(first.promise, second.promise) })

    controller.begin()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    controller.begin()
    second.resolve(batch(ACCOUNT_ONE))
    await settle()

    expect(published).toEqual([null, bonus('a'), null])
    controller.end()
  })

  it('does nothing for an empty batch with no card displayed', async () => {
    const { controller, published } = sandbox({ read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE))) })

    controller.begin()
    await settle()

    expect(published).toEqual([null])
    controller.end()
  })

  it('skips an unnotified bonus that already expired', async () => {
    const { controller, published } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a', { expiresAt: EXPIRED })))),
    })

    controller.begin()
    await settle()

    expect(published).toEqual([null])
    controller.end()
  })

  it('keeps a notice whose expiry timestamp does not parse', async () => {
    // The Host owns the timestamp; an unreadable one must not hide a granted bonus.
    const { controller, published } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a', { expiresAt: 'not-a-timestamp' })))),
    })

    controller.begin()
    await settle()

    expect(cards(published)).toEqual([bonus('a', { expiresAt: 'not-a-timestamp' })])
    controller.end()
  })
})

describe('createBonusNoticeController acknowledgements', () => {
  it('acknowledges a reported order exactly once', async () => {
    const acknowledged = ackStub()
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.shown(order('a'))
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(0)

    expect(acknowledged).toHaveBeenCalledTimes(1)
    expect(acknowledged).toHaveBeenCalledWith(ACCOUNT_ONE, order('a'))
    expect(vi.getTimerCount()).toBe(0)
    controller.end()
  })

  it('ignores a shown report for an order that is not displayed', async () => {
    const acknowledged = ackStub()
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.shown(order('b'))
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS)

    expect(acknowledged).not.toHaveBeenCalled()
    controller.end()
  })

  it('ignores a shown report while no card is displayed', async () => {
    const read = deferred<AccountBonusBatch | null>()
    const acknowledged = ackStub()
    const { controller } = sandbox({ read: queuedReads(read.promise), acknowledge: acknowledged })

    controller.begin()
    controller.shown(order('a'))
    read.resolve(null)
    await settle()
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS)

    expect(acknowledged).not.toHaveBeenCalled()
    controller.end()
  })

  it('ignores a shown report after the lifecycle ended', async () => {
    const acknowledged = ackStub()
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.end()
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS)

    expect(acknowledged).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never acknowledges a card that expired while it was displayed', async () => {
    const acknowledged = ackStub()
    const expiresAt = new Date(NOW + 60_000).toISOString()
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a', { expiresAt })))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    vi.setSystemTime(NOW + 120_000)
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS)

    expect(acknowledged).not.toHaveBeenCalled()
    controller.end()
  })

  it('acknowledges a dismissed card, clears it, and ignores a second dismissal', async () => {
    const acknowledged = ackStub()
    const { controller, published } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.dismiss(order('a'))
    expect(published).toEqual([null, bonus('a'), null])

    // No card is displayed any more, so the repeat dismissal changes nothing.
    controller.dismiss(order('a'))
    expect(published).toEqual([null, bonus('a'), null])
    await vi.advanceTimersByTimeAsync(0)

    expect(acknowledged).toHaveBeenCalledTimes(1)
    expect(acknowledged).toHaveBeenCalledWith(ACCOUNT_ONE, order('a'))
    expect(vi.getTimerCount()).toBe(0)
    controller.end()
  })

  it('retries a rejected acknowledgement with exponential backoff up to the cap', async () => {
    const acknowledged = ackStub()
    acknowledged.mockRejectedValueOnce(new Error('offline'))
    acknowledged.mockResolvedValueOnce(false)
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.shown(order('a'))

    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1)
    expect(acknowledged).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(acknowledged).toHaveBeenCalledTimes(2)
    // The retry delay doubles past its 3000ms cap, so the third attempt waits the cap.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS)
    expect(acknowledged).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS * 4)
    expect(acknowledged).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    controller.end()
  })

  it('does not start a second acknowledgement while one is in flight', async () => {
    const held = deferred<boolean>()
    const acknowledged = ackStub(() => held.promise)
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const { controller } = sandbox({
      read: queuedReads(first.promise, second.promise),
      acknowledge: acknowledged,
    })

    controller.begin()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)

    // A second card is reported while the first acknowledgement is unanswered;
    // its timer must not start a concurrent acknowledgement.
    controller.begin()
    second.resolve(batch(ACCOUNT_ONE, bonus('b')))
    await settle()
    controller.shown(order('b'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)

    held.resolve(true)
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(2)
    expect(acknowledged).toHaveBeenLastCalledWith(ACCOUNT_ONE, order('b'))
    expect(vi.getTimerCount()).toBe(0)
    controller.end()
  })

  it('schedules one timer for the acknowledgements queued while it is pending', async () => {
    const acknowledged = ackStub()
    const first = deferred<AccountBonusBatch | null>()
    const second = deferred<AccountBonusBatch | null>()
    const { controller, published } = sandbox({
      read: queuedReads(first.promise, second.promise),
      acknowledge: acknowledged,
    })

    controller.begin()
    first.resolve(batch(ACCOUNT_ONE, bonus('a')))
    await settle()
    controller.shown(order('a'))

    // A second order is reported before that timer fires, so it joins the queue
    // instead of scheduling a second timer.
    controller.begin()
    second.resolve(batch(ACCOUNT_ONE, bonus('b')))
    await settle()
    expect(cards(published)).toEqual([bonus('a'), bonus('b')])
    controller.shown(order('b'))
    // Both orders wait on the one timer the first report scheduled.
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged.mock.calls.map(call => call[1])).toEqual([order('a')])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(acknowledged.mock.calls.map(call => call[1])).toEqual([order('a'), order('b')])
    expect(vi.getTimerCount()).toBe(0)
    controller.end()
  })

  it('drops an acknowledgement that lands after the lifecycle ended', async () => {
    const held = deferred<boolean>()
    const acknowledged = ackStub(() => held.promise)
    const { controller } = sandbox({
      read: queuedReads(Promise.resolve(batch(ACCOUNT_ONE, bonus('a')))),
      acknowledge: acknowledged,
    })

    controller.begin()
    await settle()
    controller.shown(order('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)

    controller.end()
    held.resolve(true)
    await settle()
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS * 4)

    expect(acknowledged).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
