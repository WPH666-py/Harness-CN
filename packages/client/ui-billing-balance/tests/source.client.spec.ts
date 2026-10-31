// @vitest-environment jsdom
/** Poller behavior and optional-service normalization of the chip. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EMPTY_BILLING_BALANCE } from '../src/client/balance.ts'
import type { BillingBalanceView } from '../src/client/balance.ts'
import { parseMonthCost, readBillingMetrics } from '../src/client/billing-service.ts'
import type { BillingMetricsService } from '../src/client/billing-service.ts'
import { BALANCE_POLL_INTERVAL_MS, startBillingBalance } from '../src/client/source.ts'
import type { BillingBalanceSource, BillingBalanceSourceOptions } from '../src/client/source.ts'
import type { ProviderUsage } from '../src/client/usage.ts'

const sources: BillingBalanceSource[] = []

function start(options: BillingBalanceSourceOptions): BillingBalanceSource {
  const source = startBillingBalance(options)
  sources.push(source)
  return source
}

afterEach(() => {
  for (const source of sources.splice(0)) source.dispose()
  vi.useRealTimers()
})

function row(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: 'deepseek',
    displayName: undefined,
    currency: undefined,
    totalBalance: undefined,
    error: undefined,
    ...overrides,
  }
}

function emptyView(): ReturnType<typeof createSnapshotStore<BillingBalanceView>> {
  return createSnapshotStore<BillingBalanceView>(EMPTY_BILLING_BALANCE)
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('startBillingBalance', () => {
  it('publishes the first usable provider balance', async () => {
    const view = emptyView()
    start({ view, loadUsage: async () => [row({ totalBalance: 12.34, currency: 'CNY' })] })
    await vi.waitFor(() => {
      expect(view.getSnapshot().balance).toBe(12.34)
    })
    expect(view.getSnapshot()).toEqual({ balance: 12.34, monthCost: undefined, currency: 'CNY' })
  })

  it('keeps the last sample when a later request fails', async () => {
    const view = emptyView()
    let fail = false
    const loadUsage = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return [row({ totalBalance: 12.34, currency: 'CNY' })]
    })
    const source = start({ view, loadUsage })
    await vi.waitFor(() => {
      expect(view.getSnapshot().balance).toBe(12.34)
    })
    fail = true
    source.refresh()
    await vi.waitFor(() => {
      expect(loadUsage).toHaveBeenCalledTimes(2)
    })
    await flush()
    expect(view.getSnapshot().balance).toBe(12.34)
  })

  it('leaves the row empty while no provider reports a balance', async () => {
    const view = emptyView()
    const loadUsage = vi.fn(async () => [row({ error: 'unauthorized' })])
    start({ view, loadUsage })
    await vi.waitFor(() => {
      expect(loadUsage).toHaveBeenCalledTimes(1)
    })
    await flush()
    expect(view.getSnapshot()).toEqual(EMPTY_BILLING_BALANCE)
  })

  it('skips polling while the page is hidden and catches up when it becomes visible', async () => {
    const view = emptyView()
    let hidden = true
    const loadUsage = vi.fn(async () => [row({ totalBalance: 12.34 })])
    start({ view, loadUsage, isHidden: () => hidden })
    await flush()
    expect(loadUsage).not.toHaveBeenCalled()
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => {
      expect(view.getSnapshot().balance).toBe(12.34)
    })
  })

  it('reads the billing service costs and follows its pushes', async () => {
    const view = emptyView()
    const costs = { monthCost: 1.86 }
    const listeners: ((costs: unknown) => void)[] = []
    const release = vi.fn()
    const service: BillingMetricsService = {
      get monthCost() {
        return costs.monthCost
      },
      readCosts: () => costs,
      subscribeCosts: (listener) => {
        listeners.push(listener)
        return release
      },
      openDashboard: undefined,
    }
    const source = start({ view, service: () => service, loadUsage: async () => [] })
    await vi.waitFor(() => {
      expect(view.getSnapshot().monthCost).toBe(1.86)
    })
    costs.monthCost = 2.5
    listeners[0]?.(costs)
    expect(view.getSnapshot().monthCost).toBe(2.5)
    source.refresh()
    await flush()
    expect(view.getSnapshot().monthCost).toBe(2.5)
    source.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('tolerates a service that exposes neither a reader nor a feed', async () => {
    const view = emptyView()
    const service: BillingMetricsService = {
      monthCost: 1.86,
      readCosts: undefined,
      subscribeCosts: undefined,
      openDashboard: undefined,
    }
    start({ view, service: () => service, loadUsage: async () => [] })
    await vi.waitFor(() => {
      expect(view.getSnapshot().monthCost).toBe(1.86)
    })
  })

  it('keeps the service month cost when its reader throws', async () => {
    const view = emptyView()
    const service: BillingMetricsService = {
      monthCost: 1.86,
      readCosts: () => {
        throw new Error('gone')
      },
      subscribeCosts: undefined,
      openDashboard: undefined,
    }
    start({ view, service: () => service, loadUsage: async () => [] })
    await vi.waitFor(() => {
      expect(view.getSnapshot().monthCost).toBe(1.86)
    })
  })

  it('survives a failing cost subscription and ignores non-cost pushes', async () => {
    const view = emptyView()
    const listeners: ((costs: unknown) => void)[] = []
    const service: BillingMetricsService = {
      monthCost: 1.86,
      readCosts: undefined,
      subscribeCosts: (listener) => {
        listeners.push(listener)
        throw new Error('closed')
      },
      openDashboard: undefined,
    }
    const source = start({ view, service: () => service, loadUsage: async () => [] })
    await vi.waitFor(() => {
      expect(view.getSnapshot().monthCost).toBe(1.86)
    })
    source.refresh()
    await flush()
    expect(view.getSnapshot().monthCost).toBe(1.86)
    expect(listeners).toHaveLength(1)
  })

  it('polls on the configured cadence and stops on dispose', async () => {
    vi.useFakeTimers()
    const view = emptyView()
    const loadUsage = vi.fn(async () => [])
    const source = start({ view, loadUsage })
    await vi.advanceTimersByTimeAsync(0)
    expect(loadUsage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BALANCE_POLL_INTERVAL_MS)
    expect(loadUsage).toHaveBeenCalledTimes(2)
    source.dispose()
    source.refresh()
    await vi.advanceTimersByTimeAsync(BALANCE_POLL_INTERVAL_MS * 2)
    expect(loadUsage).toHaveBeenCalledTimes(2)
  })

  it('aborts the in-flight request and drops its late result', async () => {
    const view = emptyView()
    let settle: ((rows: readonly ProviderUsage[]) => void) | undefined
    let signal: AbortSignal | undefined
    const loadUsage = (next: AbortSignal): Promise<readonly ProviderUsage[]> => {
      signal = next
      return new Promise((resolve) => {
        settle = resolve
      })
    }
    const source = start({ view, loadUsage })
    source.dispose()
    expect(signal?.aborted).toBe(true)
    settle?.([row({ totalBalance: 12.34 })])
    await flush()
    expect(view.getSnapshot()).toEqual(EMPTY_BILLING_BALANCE)
  })
})

describe('readBillingMetrics', () => {
  it('normalizes a plain service object', () => {
    const openDashboard = vi.fn()
    const service = readBillingMetrics(() => ({
      monthCost: '1.86',
      readCosts: () => ({ monthCost: 2 }),
      subscribeCosts: () => () => {},
      openDashboard,
    }))
    expect(service?.monthCost).toBe(1.86)
    expect(service?.readCosts?.()).toEqual({ monthCost: 2 })
    service?.openDashboard?.()
    expect(openDashboard).toHaveBeenCalledTimes(1)
  })

  it('calls a function-valued service handle', () => {
    const service = readBillingMetrics(() => () => ({ monthCost: 1.86 }))
    expect(service?.monthCost).toBe(1.86)
  })

  it('returns undefined when the resolver or the handle throws', () => {
    expect(readBillingMetrics(() => {
      throw new Error('context gone')
    })).toBeUndefined()
    expect(readBillingMetrics(() => () => {
      throw new Error('service gone')
    })).toBeUndefined()
  })

  it('returns undefined for values that are not service records', () => {
    expect(readBillingMetrics(() => undefined)).toBeUndefined()
    expect(readBillingMetrics(() => 'billingMetrics')).toBeUndefined()
    expect(readBillingMetrics(() => [])).toBeUndefined()
  })

  it('tolerates a service without optional members', () => {
    const service = readBillingMetrics(() => ({}))
    expect(service).toEqual({
      monthCost: undefined,
      readCosts: undefined,
      subscribeCosts: undefined,
      openDashboard: undefined,
    })
    expect(service?.subscribeCosts).toBeUndefined()
  })

  it('releases a subscription that returns no disposer', () => {
    const service = readBillingMetrics(() => ({ subscribeCosts: () => undefined }))
    expect(service?.subscribeCosts?.(() => {})).toBeUndefined()
  })
})

describe('parseMonthCost', () => {
  it('reads a finite month cost', () => {
    expect(parseMonthCost({ monthCost: '1.86' })).toBe(1.86)
    expect(parseMonthCost({ monthCost: 2 })).toBe(2)
  })

  it('returns undefined for snapshots without a usable month cost', () => {
    expect(parseMonthCost(5)).toBeUndefined()
    expect(parseMonthCost(undefined)).toBeUndefined()
    expect(parseMonthCost({ monthCost: Number.NaN })).toBeUndefined()
    expect(parseMonthCost({})).toBeUndefined()
  })
})
