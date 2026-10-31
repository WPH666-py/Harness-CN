// @vitest-environment jsdom
/** Bottom-row chip rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BillingBalance } from '../src/client/BillingBalance.tsx'
import type { BillingBalanceProps } from '../src/client/BillingBalance.tsx'
import { EMPTY_BILLING_BALANCE } from '../src/client/balance.ts'
import type { BillingBalanceView } from '../src/client/balance.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

interface MountOptions {
  readonly view?: BillingBalanceView
  readonly openDashboard?: (() => void) | undefined
}

function mount(options: MountOptions = {}): ReturnType<typeof render> {
  const snapshot = createSnapshotStore<BillingBalanceView>(options.view ?? EMPTY_BILLING_BALANCE)
  const props = {
    t: makeTranslate(zh),
    useBalance: <S,>(selector: (view: BillingBalanceView) => S): S => selector(snapshot.getSnapshot()),
    openDashboard: options.openDashboard,
  } as unknown as BillingBalanceProps
  return render(<BillingBalance {...props} />)
}

describe('BillingBalance', () => {
  it('renders nothing before the first usable sample', () => {
    const { container } = mount()
    expect(container.innerHTML).toBe('')
  })

  it('renders the balance as a plain label without a dashboard opener', () => {
    const { container, getByText } = mount({ view: { balance: 12.34, monthCost: 1.86, currency: 'CNY' } })
    expect(getByText('余额 ¥12.34')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-billing-balance]')?.tagName).toBe('SPAN')
  })

  it('renders the month spend when no provider balance is known', () => {
    const { getByText } = mount({ view: { balance: undefined, monthCost: 1.86, currency: 'CNY' } })
    expect(getByText('本月 ¥1.86')).toBeTruthy()
  })

  it('opens the dashboard through the injected opener', () => {
    const openDashboard = vi.fn()
    const { getByRole } = mount({ view: { balance: 12.34, monthCost: undefined, currency: 'CNY' }, openDashboard })
    const chip = getByRole('button', { name: '打开用量与账单面板' })
    expect(chip.getAttribute('title')).toBe('打开用量与账单面板')
    fireEvent.click(chip)
    expect(openDashboard).toHaveBeenCalledTimes(1)
  })
})
