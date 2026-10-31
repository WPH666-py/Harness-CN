/** Data contract between the registrant and the chip component. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BillingBalanceView } from './balance.ts'

/** Injected face of the bottom-row chip. */
export interface BillingBalanceInjected {
  /** Latest sample; both amounts absent renders nothing. */
  readonly hooks: { readonly balance: HostObservable<BillingBalanceView> }
  /** Dashboard opener, present only while a billing service exposes one. */
  readonly openDashboard: (() => void) | undefined
}
