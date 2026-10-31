/** Poller behind the bottom-row chip: one sample per cycle, failures keep the last. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BillingBalanceView } from './balance.ts'
import { parseMonthCost } from './billing-service.ts'
import type { BillingMetricsService } from './billing-service.ts'
import { pickRemainingBalance } from './usage.ts'
import type { ProviderUsage } from './usage.ts'

/** Poll cadence; the billing plugin refreshes its own sidebar gauge twice as often. */
export const BALANCE_POLL_INTERVAL_MS = 60_000

/** Collaborators of one polling source. */
export interface BillingBalanceSourceOptions {
  /** Store the chip reads; the source only writes it. */
  readonly view: SnapshotStore<BillingBalanceView>
  /** Loads provider usage rows. */
  readonly loadUsage: (signal: AbortSignal) => Promise<readonly ProviderUsage[]>
  /** Resolves the optional billing service on every cycle. */
  readonly service?: (() => BillingMetricsService | undefined) | undefined
  /** Milliseconds between polls. */
  readonly intervalMs?: number | undefined
  /** Whether the page is hidden; polling pauses while it is. */
  readonly isHidden?: (() => boolean) | undefined
}

/** Handle over one running poller. */
export interface BillingBalanceSource {
  /** Run one cycle now; a hidden page defers to the next cycle. */
  refresh(): void
  /** Stop the timer, the visibility listener, the in-flight request, and the cost feed. */
  dispose(): void
}

/**
 * Start polling for the balance chip.
 * @param options - store, loader, and optional service access.
 * @returns the running source; dispose it from the owning effect.
 */
export function startBillingBalance(options: BillingBalanceSourceOptions): BillingBalanceSource {
  const { view } = options
  const isHidden = options.isHidden ?? ((): boolean => document.hidden)
  const intervalMs = options.intervalMs ?? BALANCE_POLL_INTERVAL_MS
  let disposed = false
  let request: AbortController | undefined
  let releaseCosts: (() => void) | undefined
  let connected = false
  let monthCost: number | undefined

  const publish = (next: BillingBalanceView): void => {
    const previous = view.getSnapshot()
    if (next.balance === previous.balance && next.monthCost === previous.monthCost && next.currency === previous.currency) return
    view.set(next)
  }

  const publishMonthCost = (value: number | undefined): void => {
    if (value === undefined) return
    monthCost = value
    publish({ ...view.getSnapshot(), monthCost: value })
  }

  const readServiceCosts = (service: BillingMetricsService): void => {
    publishMonthCost(service.monthCost)
    if (service.readCosts === undefined) return
    try {
      publishMonthCost(parseMonthCost(service.readCosts()))
    } catch {
      // The optional service must never break the chip; the next cycle retries.
    }
  }

  const connectService = (service: BillingMetricsService): void => {
    if (connected) return
    connected = true
    if (service.subscribeCosts === undefined) return
    try {
      releaseCosts = service.subscribeCosts((costs) => {
        publishMonthCost(parseMonthCost(costs))
      })
    } catch {
      // A failing feed falls back to the per-cycle read above.
    }
  }

  const load = (): void => {
    request?.abort()
    const current = new AbortController()
    request = current
    void options.loadUsage(current.signal).then((providers) => {
      if (disposed || current.signal.aborted) return
      const balance = pickRemainingBalance(providers)
      if (balance === undefined) return
      publish({ balance: balance.amount, monthCost, currency: balance.currency })
    }, () => {
      // Keep the last successful sample: a failed request never blanks the chip.
    })
  }

  const refresh = (): void => {
    if (disposed || isHidden()) return
    const service = options.service?.()
    if (service !== undefined) {
      connectService(service)
      readServiceCosts(service)
    }
    load()
  }

  const onVisibilityChange = (): void => {
    if (!isHidden()) refresh()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  const timer = setInterval(refresh, intervalMs)
  refresh()

  return {
    refresh,
    dispose: (): void => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      request?.abort()
      request = undefined
      releaseCosts?.()
      releaseCosts = undefined
    },
  }
}
