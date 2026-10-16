/**
 * Lifecycle of granted-bonus notices: one displayed notice at a time, one read
 * in force at a time, and one acknowledgement per displayed card.
 *
 * Reads happen when the section asks for them — the Host stream naming a
 * stored credential, or the row mounting — never on a timer. The Host owns
 * which bonus is unnotified and what its copy says. A card acknowledges its
 * order once: the first acknowledgement is immediate, and a rejected one is
 * retried with exponential backoff until the Host accepts it. Ending the
 * lifecycle clears the displayed notice and every pending acknowledgement, and
 * a read that names a different account does the same before adopting it.
 */

import type {
  AccountBonusBatch,
  AccountBonusNotification,
  AccountBonusOrderId,
  AccountUserId,
} from './types.ts'

/** One displayed notice together with the account that offered it. */
interface DisplayedNotice {
  /** Account the notice was read for. */
  readonly accountId: AccountUserId
  /** Notice the card shows. */
  readonly notice: AccountBonusNotification
}

/** One acknowledgement waiting for the Host to accept it. */
interface PendingAck {
  /** Account to acknowledge against. */
  readonly accountId: AccountUserId
  /** Order whose card finished a displayed frame. */
  readonly orderId: AccountBonusOrderId
}

/** Notice lifecycle the Account & balance section drives. */
export interface BonusNoticeController {
  /** Start the lifecycle, or re-read while one is already running. */
  begin(): void
  /** End the lifecycle and drop every pending acknowledgement. */
  end(): void
  /** Report that the card for one order finished a displayed frame. */
  shown(orderId: AccountBonusOrderId): void
  /** Dismiss one order: acknowledge it and clear the card. */
  dismiss(orderId: AccountBonusOrderId): void
}

/** What one notice lifecycle needs from the section. */
export interface BonusNoticeControllerOptions {
  /** Read the bonuses the account has not been shown yet; a rejection counts as a failed read. */
  readonly read: () => Promise<AccountBonusBatch | null>
  /** Acknowledge one order; a resolved false or a rejection counts as a failed acknowledgement. */
  readonly acknowledge: (accountId: AccountUserId, orderId: AccountBonusOrderId) => Promise<boolean>
  /** Publish the notice to display, or null when there is none. */
  readonly publish: (notice: AccountBonusNotification | null) => void
  /** Milliseconds to wait before retrying a rejected acknowledgement. */
  readonly retryDelayMs: number
  /** Upper bound for the acknowledgement retry delay. */
  readonly retryMaxDelayMs: number
}

/**
 * Whether a notice's expiry timestamp has passed.
 * @param expiresAt - ISO timestamp the Host reports for the notice.
 * @param at - epoch milliseconds to compare against.
 * @returns true when the timestamp parses and is not in the future.
 */
function expired(expiresAt: string, at: number): boolean {
  const expires = Date.parse(expiresAt)
  return !Number.isNaN(expires) && expires <= at
}

/**
 * Create the notice lifecycle for one credential session.
 * @param options - the section's read, acknowledge, publish, and retry timings.
 * @returns the lifecycle handle.
 */
export function createBonusNoticeController(options: BonusNoticeControllerOptions): BonusNoticeController {
  let active = false
  let lifetime = 0
  let readGeneration = 0
  let displayed: DisplayedNotice | undefined
  let pending: PendingAck[] = []
  let reported = new Set<AccountBonusOrderId>()
  let ackTimer: ReturnType<typeof setTimeout> | undefined
  let ackInFlight = false
  let ackDelay = options.retryDelayMs

  const clearTimer = (): void => {
    if (ackTimer === undefined) return
    clearTimeout(ackTimer)
    ackTimer = undefined
  }

  const scheduleAck = (delay: number): void => {
    if (ackTimer !== undefined) return
    ackTimer = setTimeout(() => {
      ackTimer = undefined
      void runAcks()
    }, delay)
  }

  const owns = (value: number): boolean => active && value === lifetime

  function setDisplayed(next: DisplayedNotice | undefined): void {
    if (displayed === next) return
    if (displayed?.notice.orderId !== next?.notice.orderId) reported = new Set()
    displayed = next
    options.publish(next?.notice ?? null)
  }

  function apply(batch: AccountBonusBatch): void {
    if (displayed !== undefined && displayed.accountId !== batch.accountId) {
      pending = []
      ackDelay = options.retryDelayMs
      clearTimer()
      setDisplayed(undefined)
    }
    const candidate = batch.bonuses[0]
    if (candidate === undefined) {
      // An empty batch leaves an already-acknowledged card alone: the server
      // drops a notified order from the batch only after the Host stores it.
      if (displayed !== undefined && !reported.has(displayed.notice.orderId)) setDisplayed(undefined)
      return
    }
    if (candidate.orderId === displayed?.notice.orderId) {
      setDisplayed({ accountId: batch.accountId, notice: candidate })
      return
    }
    if (expired(candidate.expiresAt, Date.now())) return
    setDisplayed({ accountId: batch.accountId, notice: candidate })
  }

  async function runRead(value: number): Promise<void> {
    const generation = ++readGeneration
    const batch = await options.read().catch(() => null)
    if (!owns(value) || generation !== readGeneration || batch === null) return
    apply(batch)
  }

  async function runAcks(): Promise<void> {
    if (!active || ackInFlight) return
    const next = pending[0]
    /* v8 ignore next -- an acknowledgement is only ever scheduled while one is pending */
    if (next === undefined) return
    const value = lifetime
    ackInFlight = true
    let acknowledged = false
    try {
      acknowledged = await options.acknowledge(next.accountId, next.orderId)
    } catch {
      acknowledged = false
    }
    if (!owns(value)) return
    ackInFlight = false
    if (!acknowledged) {
      scheduleAck(ackDelay)
      ackDelay = Math.min(ackDelay * 2, options.retryMaxDelayMs)
      return
    }
    pending = pending.filter(entry => entry.orderId !== next.orderId)
    ackDelay = options.retryDelayMs
    if (pending.length > 0) scheduleAck(0)
  }

  function report(orderId: AccountBonusOrderId): void {
    const shown = displayed
    if (!active || shown === undefined || shown.notice.orderId !== orderId) return
    if (expired(shown.notice.expiresAt, Date.now())) return
    if (reported.has(orderId)) return
    reported.add(orderId)
    pending.push({ accountId: shown.accountId, orderId })
    ackDelay = options.retryDelayMs
    scheduleAck(0)
  }

  return {
    begin(): void {
      if (!active) {
        active = true
        lifetime += 1
        displayed = undefined
        pending = []
        reported = new Set()
        ackDelay = options.retryDelayMs
        clearTimer()
        options.publish(null)
      }
      void runRead(lifetime)
    },
    end(): void {
      active = false
      lifetime += 1
      displayed = undefined
      pending = []
      reported = new Set()
      clearTimer()
      options.publish(null)
    },
    shown(orderId: AccountBonusOrderId): void {
      report(orderId)
    },
    dismiss(orderId: AccountBonusOrderId): void {
      report(orderId)
      setDisplayed(undefined)
    },
  }
}
