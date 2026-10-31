/** Provider balance rows read from the billing host. */

/** Same-origin route that returns one row per billing provider, each with its remaining balance. */
export const BALANCE_PATH = '/api/billing/balance'

/** Older route of the billing plugin: it reports aggregate usage rather than per-provider balances. */
export const USAGE_STATS_PATH = '/api/billing/usage-stats'

/** One provider row of a billing response. */
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
 * Pick the provider rows out of either answer shape: the balance route wraps them in
 * `balances`, the older usage route is the bare list.
 * @param payload - decoded JSON body.
 * @returns the row list, or an empty list for a payload carrying none.
 */
function rowsOf(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload) && Array.isArray(payload.balances)) return payload.balances
  return []
}

/**
 * Parse a billing payload, dropping rows the chip cannot use.
 * @param payload - decoded JSON body.
 * @returns usable provider rows; empty for a payload carrying none.
 */
export function parseUsageStats(payload: unknown): readonly ProviderUsage[] {
  const rows: ProviderUsage[] = []
  for (const entry of rowsOf(payload)) {
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
 * Read one billing route.
 * @param path - same-origin route to request.
 * @param signal - aborts the request when the chip is torn down.
 * @returns parsed provider rows.
 */
async function readRoute(path: string, signal: AbortSignal): Promise<readonly ProviderUsage[]> {
  const response = await fetch(path, {
    signal,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${path} request failed with status ${String(response.status)}`)
  const payload: unknown = await response.json()
  return parseUsageStats(payload)
}

/**
 * Read the provider rows, preferring the balance route and falling back to the usage route
 * when the installed billing plugin only serves the older one.
 * @param signal - aborts the request when the chip is torn down.
 * @returns parsed provider rows.
 */
export async function fetchUsageStats(signal: AbortSignal): Promise<readonly ProviderUsage[]> {
  try {
    const balances = await readRoute(BALANCE_PATH, signal)
    if (balances.length > 0) return balances
  } catch {
    // An older plugin has no balance route; the usage route below is the fallback.
  }
  return readRoute(USAGE_STATS_PATH, signal)
}
