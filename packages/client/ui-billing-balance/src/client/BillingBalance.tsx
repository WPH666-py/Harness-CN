/** Single-line balance chip for the shell's bottom row. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatBillingBalance } from './balance.ts'
import type { BillingBalanceInjected } from './injected.ts'
import css from './BillingBalance.module.css'

/** Props of the bottom-row chip; every share is derived by the slot framework. */
export type BillingBalanceProps = PropsRuntime<'shell.bottom'> & PropsLocale<'billing-balance'> & InjectFace<BillingBalanceInjected>

/**
 * Render the balance chip, or nothing before the first usable sample.
 * @param props - slot framework shares plus the injected sample.
 * @returns one text line, or `null` while no amount is known.
 */
export function BillingBalance({ t, useBalance, openDashboard }: BillingBalanceProps): ReactNode {
  const sample = useBalance(snapshot => snapshot)
  const text = formatBillingBalance(sample, t)
  if (text === undefined) return null
  if (openDashboard === undefined) {
    return <span className={css.chip} data-billing-balance>{text}</span>
  }
  const action = t('dashboard.open')
  return (
    <button type="button" className={css.chip} title={action} aria-label={action} data-billing-balance onClick={openDashboard}>
      {text}
    </button>
  )
}
