/** Optional access to the billing plugin's `billingMetrics` Cordis service. */
import { isRecord, readAmount } from './usage.ts'

/** The subset of the billing service the chip reads. */
export interface BillingMetricsService {
  /** Month-to-date spend, when the service already knows it. */
  readonly monthCost: number | undefined
  /** Re-reads the current cost snapshot, when the service exposes a reader. */
  readonly readCosts: (() => unknown) | undefined
  /** Pushes cost snapshots after the initial read, when the service exposes a feed. */
  readonly subscribeCosts: ((listener: (costs: unknown) => void) => (() => void) | undefined) | undefined
  /** Opens the billing dashboard, when the service exposes one. */
  readonly openDashboard: (() => void) | undefined
}

/**
 * Read the month spend carried by a costs snapshot.
 * @param value - raw snapshot.
 * @returns the month cost when it is present and finite.
 */
export function parseMonthCost(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  return readAmount(value.monthCost)
}

/**
 * Normalize an optional service value into the subset the chip reads.
 * @param resolve - resolves the service from the Cordis context on each call.
 * @returns the readable subset, or `undefined` when no service answers.
 */
export function readBillingMetrics(resolve: () => unknown): BillingMetricsService | undefined {
  let candidate: unknown
  try {
    candidate = resolve()
  } catch {
    return undefined
  }
  if (typeof candidate === 'function') {
    try {
      candidate = candidate()
    } catch {
      return undefined
    }
  }
  if (!isRecord(candidate)) return undefined
  const readCostsRaw: unknown = candidate.readCosts
  const subscribeCostsRaw: unknown = candidate.subscribeCosts
  const openDashboardRaw: unknown = candidate.openDashboard
  return {
    monthCost: readAmount(candidate.monthCost),
    readCosts: typeof readCostsRaw === 'function' ? (): unknown => readCostsRaw() : undefined,
    subscribeCosts: typeof subscribeCostsRaw === 'function'
      ? (listener: (costs: unknown) => void): (() => void) | undefined => {
        const release: unknown = subscribeCostsRaw((costs: unknown) => {
          listener(costs)
        })
        return typeof release === 'function' ? () => {
          release()
        } : undefined
      }
      : undefined,
    openDashboard: typeof openDashboardRaw === 'function' ? (): void => {
      openDashboardRaw()
    } : undefined,
  }
}
