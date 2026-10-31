/** Copy for the bottom-row billing chip. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'billing-balance': BillingBalanceKey
  }
}

/** Chinese dictionary of the chip. */
export const zh = {
  'balance.remaining': '余额 {amount}',
  'balance.month': '本月 {amount}',
  'dashboard.open': '打开用量与账单面板',
} satisfies Record<string, string>

/** Key union of the chip's dictionary. */
export type BillingBalanceKey = keyof typeof zh

/** English dictionary of the chip. */
export const en = {
  'balance.remaining': 'Balance {amount}',
  'balance.month': 'This month {amount}',
  'dashboard.open': 'Open the usage and billing dashboard',
} satisfies Record<BillingBalanceKey, string>
