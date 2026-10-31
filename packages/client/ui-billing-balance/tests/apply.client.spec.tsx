// @vitest-environment jsdom
/** Registration of the chip in the shell's bottom row, through the production renderer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

function okResponse(body: unknown): unknown {
  return { ok: true, status: 200, json: async () => body }
}

async function setup(provideBilling?: (runtime: SlotTestRuntime) => void) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  locale.setLocale('zh')
  provideBilling?.(runtime)
  await runtime.declare({ 'shell.bottom': { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, body: runtime.renderSlot('shell.bottom', {}) }
}

describe('ui-billing-balance registration', () => {
  it('shows the provider balance in the bottom row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([
      { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 12.34, error: null },
    ])))
    const { body } = await setup()
    await waitFor(() => {
      expect(body.view.getByText('余额 ¥12.34')).toBeTruthy()
    })
    expect(body.container.querySelector('[data-billing-balance]')?.tagName).toBe('SPAN')
  })

  it('keeps the row empty before the first usable amount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([])))
    const { body } = await setup()
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    expect(body.container.innerHTML).toBe('')
  })

  it('shows the month spend and opens the dashboard from the billing service', async () => {
    const openDashboard = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([])))
    const { body } = await setup((runtime) => {
      runtime.ctx.provide('billingMetrics', {
        monthCost: 1.86,
        readCosts: () => ({ monthCost: 1.86 }),
        subscribeCosts: () => () => {},
        openDashboard,
      })
    })
    await waitFor(() => {
      expect(body.view.getByText('本月 ¥1.86')).toBeTruthy()
    })
    fireEvent.click(body.view.getByRole('button', { name: '打开用量与账单面板' }))
    expect(openDashboard).toHaveBeenCalledTimes(1)
  })
})
