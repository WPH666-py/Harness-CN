/** Provider usage rows read from the billing host's usage-stats route. */

/** Same-origin route that returns one usage row per billing provider. */
export const USAGE_STATS_PATH = '/api/billing/usage-stats'

/** One provider row of the usage-stats response. */
export interface ProviderUsage {
  /** Stable provider identifier reported by the host. */
  readonly provider: string
  /** Human-readable provider name, when the host sends one. */
  readonly displayName: string | undefined
  /** Currency code the amounts are denominated in, when known. */
  readonly currency: string | undefined
  /** Remaining balance, when the provider answered without an error. */
  readonly totalBalance: number | undefined
  /** Provider failure reported in place of a balance. */
  readonly error: string | undefined
}

/** The balance picked for the chip. */
export interface RemainingBalance {
  /** Usable remaining amount. */
  readonly amount: number
  /** Currency code the amount is denominated in, when known. */
  readonly currency: string | undefined
}

/**
 * Type guard for the loose JSON every billing surface returns.
 * @param value - decoded value of unknown shape.
 * @returns whether the value is a plain record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a finite amount from a number or a numeric string.
 * @param value - raw field value.
 * @returns the amount, or `undefined` when the field is absent or unusable.
 */
export function readAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  const amount = Number(text)
  return Number.isFinite(amount) ? amount : undefined
}

/**
 * Parse the usage-stats payload, dropping rows the chip cannot use.
 * @param payload - decoded JSON body.
 * @returns usable provider rows; empty for an unusable payload.
 */
export function parseUsageStats(payload: unknown): readonly ProviderUsage[] {
  if (!Array.isArray(payload)) return []
  const entries: readonly unknown[] = payload
  const rows: ProviderUsage[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (typeof entry.provider !== 'string') continue
    rows.push({
      provider: entry.provider,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
      currency: typeof entry.currency === 'string' ? entry.currency : undefined,
      totalBalance: readAmount(entry.totalBalance),
      error: typeof entry.error === 'string' ? entry.error : undefined,
    })
  }
  return rows
}

/**
 * Pick the first provider that answered with a usable balance.
 * @param providers - parsed usage rows.
 * @returns the balance to display, or `undefined` when no provider has one.
 */
export function pickRemainingBalance(providers: readonly ProviderUsage[]): RemainingBalance | undefined {
  for (const provider of providers) {
    if (provider.error !== undefined) continue
    if (provider.totalBalance === undefined) continue
    return { amount: provider.totalBalance, currency: provider.currency }
  }
  return undefined
}

/**
 * Read the usage rows from the billing host's same-origin route.
 * @param signal - aborts the request when the chip is torn down.
 * @returns parsed provider rows.
 */
export async function fetchUsageStats(signal: AbortSignal): Promise<readonly ProviderUsage[]> {
  const response = await fetch(USAGE_STATS_PATH, {
    signal,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`usage-stats request failed with status ${String(response.status)}`)
  const payload: unknown = await response.json()
  return parseUsageStats(payload)
}
