/**
 * Balance presentation. Amounts are validated decimal strings; the section
 * renders them the way Platform Web does, so a wallet reads the same in the
 * product and on the Platform pages it links to.
 */

/** Currency symbol a wallet currency renders with. */
export type CurrencySymbol = '¥' | '$'

/** Rounding a rendered amount applies to its magnitude. */
type Rounding = 'down' | 'half-up'

/** One integer with thousands separators. */
function addCommas(value: bigint): string {
  return value.toLocaleString('en-US')
}

/** An amount's digits after the sign, split into whole and fractional parts. */
function split(amount: string): { readonly whole: string; readonly fraction: string } {
  const [whole = '', fraction = ''] = amount.split('.')
  return { whole: whole === '' ? '0' : whole, fraction }
}

/**
 * Reduce one unsigned decimal amount to whole cents.
 * @param amount - digits without the sign.
 * @param rounding - `down` truncates, which is what a displayed balance uses;
 *   `half-up` matches how Platform Web renders a negative magnitude.
 * @returns the amount in cents.
 */
function toCents(amount: string, rounding: Rounding): bigint {
  const { whole, fraction } = split(amount)
  const digits = `${fraction}00`
  const cents = BigInt(whole + digits.slice(0, 2))
  if (rounding === 'down') return cents
  const third = digits[2]
  return third !== undefined && third >= '5' ? cents + 1n : cents
}

/** Render one cent count as a grouped two-decimal amount. */
function render(cents: bigint): string {
  return `${addCommas(cents / 100n)}.${(cents % 100n).toString().padStart(2, '0')}`
}

/**
 * Format a decimal balance with two decimals, grouped digits, a `<` marker for
 * a positive sub-cent amount, and the sign ahead of the currency symbol.
 * @param amount - validated decimal balance string.
 * @param symbol - currency symbol for the wallet's currency.
 * @returns the formatted amount, including its symbol.
 */
export function formatBalance(amount: string, symbol: CurrencySymbol): string {
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  // Every spelling of zero (`0`, `-0`, `0.00`) carries no non-zero digit.
  if (!/[1-9]/.test(digits)) return `${symbol}0.00`
  const subCent = toCents(digits, 'down') === 0n
  if (negative) return `-${symbol}${subCent ? '0.01' : render(toCents(digits, 'half-up'))}`
  if (subCent) return `<${symbol}0.01`
  return `${symbol}${render(toCents(digits, 'down'))}`
}

/**
 * Report whether a decimal balance is strictly positive.
 * @param balance - validated decimal balance string.
 * @returns true when the amount carries a non-zero digit and no negative sign.
 */
export function isPositiveBalance(balance: string): boolean {
  return !balance.startsWith('-') && /[1-9]/.test(balance)
}

/**
 * Join wallet amounts into one line.
 * @param wallets - wallets to render, in Host order.
 * @returns the formatted amounts separated by a middle dot.
 */
export function walletText(wallets: readonly { readonly currency: 'CNY' | 'USD'; readonly balance: string }[]): string {
  return wallets
    .map(wallet => formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$'))
    .join(' · ')
}
