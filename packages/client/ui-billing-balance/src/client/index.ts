/** Registers the balance/spend chip in the shell's bottom row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BillingBalance } from './BillingBalance.tsx'
import { EMPTY_BILLING_BALANCE } from './balance.ts'
import type { BillingBalanceView } from './balance.ts'
import { readBillingMetrics } from './billing-service.ts'
import type { BillingMetricsService } from './billing-service.ts'
import type { BillingBalanceInjected } from './injected.ts'
import { en, zh } from './locales.ts'
import { startBillingBalance } from './source.ts'
import { fetchUsageStats } from './usage.ts'

/** Locale namespace of the chip, which is also its slot entry address. */
const NS = 'billing-balance'

/** Client services this plugin reads eagerly; `billingMetrics` stays optional. */
export const inject = ['slots', 'locale']

/**
 * Register the chip and keep its sample fresh while the page is visible.
 * @param ctx - client context of this plugin.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-billing-balance: dictionaries')
  const service = (): BillingMetricsService | undefined => readBillingMetrics(() => ctx.get('billingMetrics'))
  const view = createSnapshotStore<BillingBalanceView>(EMPTY_BILLING_BALANCE)
  ctx.effect(() => {
    const source = startBillingBalance({ view, loadUsage: fetchUsageStats, service })
    return () => {
      source.dispose()
    }
  }, 'ui-billing-balance: usage polling')
  ctx.effect(() => ctx.slots.inject('shell.bottom', () => ctx.slots.register({
    name: 'shell.bottom',
    locale: NS,
    inject: (): BillingBalanceInjected => {
      const openDashboard = service()?.openDashboard
      return {
        hooks: { balance: view },
        openDashboard: openDashboard === undefined ? undefined : () => {
          openDashboard()
        },
      }
    },
  }, BillingBalance)), 'ui-billing-balance: bottom chip')
}
