/** View model and pure formatting of the chip's single line. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** The single sample the chip renders. */
export interface BillingBalanceView {
  /** Remaining provider balance, when one is known. */
  readonly balance: number | undefined
  /** Month spend, when the billing service reports one. */
  readonly monthCost: number | undefined
  /** Currency code shared by both amounts, when known. */
  readonly currency: string | undefined
}

/** Sample rendered before the first successful read. */
export const EMPTY_BILLING_BALANCE: BillingBalanceView = {
  balance: undefined,
  monthCost: undefined,
  currency: undefined,
}

/** Symbols the chip prints; an unknown code keeps the yuan sign of the Chinese copy. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
}

/** Translate function bound to the chip's dictionary. */
export type BalanceTranslate = TranslateNS<'billing-balance'>

/**
 * Format one amount with two decimals behind its currency symbol.
 * Chinese and English digit grouping agree, so the amount is formatted
 * independently of the interface locale.
 * @param amount - finite amount to format.
 * @param currency - currency code reported by the provider.
 * @returns the symbol followed by the grouped amount.
 */
export function formatAmount(amount: number, currency: string | undefined): string {
  const symbol = (currency === undefined ? undefined : CURRENCY_SYMBOLS[currency.toUpperCase()]) ?? '¥'
  const digits = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${symbol}${digits}`
}

/**
 * Decide whether an amount can be displayed.
 * @param value - amount read from a billing surface.
 * @returns whether the amount is a finite number.
 */
function isDisplayableAmount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

/**
 * Render the chip's line: remaining balance first, month spend as the fallback.
 * @param view - latest sample.
 * @param t - translate function of the chip's dictionary.
 * @returns the line to display, or `undefined` before the first usable amount.
 */
export function formatBillingBalance(view: BillingBalanceView, t: BalanceTranslate): string | undefined {
  if (isDisplayableAmount(view.balance)) {
    return t('balance.remaining', { amount: formatAmount(view.balance, view.currency) })
  }
  if (isDisplayableAmount(view.monthCost)) {
    return t('balance.month', { amount: formatAmount(view.monthCost, view.currency) })
  }
  return undefined
}
