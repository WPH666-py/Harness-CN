/** Pure formatting and usage-row parsing of the chip. */
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { EMPTY_BILLING_BALANCE, formatAmount, formatBillingBalance } from '../src/client/balance.ts'
import type { BillingBalanceView } from '../src/client/balance.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  BALANCE_PATH, fetchUsageStats, isRecord, parseUsageStats, pickRemainingBalance, readAmount, USAGE_STATS_PATH,
} from '../src/client/usage.ts'
import type { ProviderUsage } from '../src/client/usage.ts'

const t = makeTranslate(zh)

describe('formatAmount', () => {
  it('prefixes the currency symbol and keeps two decimals', () => {
    expect(formatAmount(12.3, 'CNY')).toBe('¥12.30')
    expect(formatAmount(1234.5, 'CNY')).toBe('¥1,234.50')
  })

  it('falls back to the yuan sign for absent or unknown currencies', () => {
    expect(formatAmount(1.1, undefined)).toBe('¥1.10')
    expect(formatAmount(1.1, 'XYZ')).toBe('¥1.10')
  })

  it('recognizes the dollar and euro codes', () => {
    expect(formatAmount(2, 'USD')).toBe('$2.00')
    expect(formatAmount(4.5, 'EUR')).toBe('€4.50')
    expect(formatAmount(1, 'usd')).toBe('$1.00')
  })

  it('keeps the sign of negative amounts', () => {
    expect(formatAmount(-3, 'CNY')).toBe('¥-3.00')
  })
})

describe('formatBillingBalance', () => {
  it('renders nothing before the first sample', () => {
    expect(formatBillingBalance(EMPTY_BILLING_BALANCE, t)).toBeUndefined()
  })

  it('prefers the remaining balance over the month spend', () => {
    expect(formatBillingBalance({ balance: 12.34, monthCost: 1.86, currency: 'CNY' }, t)).toBe('余额 ¥12.34')
  })

  it('falls back to the month spend', () => {
    expect(formatBillingBalance({ balance: undefined, monthCost: 1.86, currency: 'CNY' }, t)).toBe('本月 ¥1.86')
  })

  it('ignores amounts that are not finite', () => {
    expect(formatBillingBalance({ balance: Number.NaN, monthCost: 1.86, currency: 'CNY' }, t)).toBe('本月 ¥1.86')
    const infinite: BillingBalanceView = {
      balance: Number.POSITIVE_INFINITY,
      monthCost: Number.NEGATIVE_INFINITY,
      currency: undefined,
    }
    expect(formatBillingBalance(infinite, t)).toBeUndefined()
  })

  it('localizes through the injected dictionary', () => {
    const translate = makeTranslate(en)
    expect(formatBillingBalance({ balance: 12.34, monthCost: undefined, currency: 'CNY' }, translate)).toBe('Balance ¥12.34')
    expect(formatBillingBalance({ balance: undefined, monthCost: 1.2, currency: 'USD' }, translate)).toBe('This month $1.20')
  })
})

describe('readAmount', () => {
  it('accepts finite numbers and numeric strings', () => {
    expect(readAmount(12.34)).toBe(12.34)
    expect(readAmount(' 1.86 ')).toBe(1.86)
  })

  it('rejects absent, empty, and non-finite values', () => {
    expect(readAmount(undefined)).toBeUndefined()
    expect(readAmount(null)).toBeUndefined()
    expect(readAmount('')).toBeUndefined()
    expect(readAmount('   ')).toBeUndefined()
    expect(readAmount('abc')).toBeUndefined()
    expect(readAmount(Number.NaN)).toBeUndefined()
    expect(readAmount(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(readAmount({ amount: 1 })).toBeUndefined()
  })
})

describe('isRecord', () => {
  it('rejects arrays, null, and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('balance')).toBe(false)
  })
})

describe('parseUsageStats', () => {
  it('returns no rows for a payload that carries no row list', () => {
    expect(parseUsageStats(undefined)).toEqual([])
    expect(parseUsageStats({ providers: [] })).toEqual([])
    expect(parseUsageStats({ balances: 'none' })).toEqual([])
  })

  it('reads the wrapped balance rows of the balance route', () => {
    const rows = parseUsageStats({
      balances: [
        { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 106.59, isAvailable: true },
        { provider: '月之暗面', displayName: '月之暗面', error: 'unconfigured' },
      ],
    })
    expect(rows).toEqual([
      { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 106.59, error: undefined },
      { provider: '月之暗面', displayName: '月之暗面', currency: undefined, totalBalance: undefined, error: 'unconfigured' },
    ])
  })

  it('keeps usable rows and drops entries without a provider id', () => {
    const rows = parseUsageStats([
      { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: '12.34', error: null },
      { displayName: 'anonymous' },
      'deepseek',
      { provider: 'openai', currency: 7, totalBalance: null, error: 'quota exceeded' },
    ])
    expect(rows).toEqual([
      { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 12.34, error: undefined },
      { provider: 'openai', displayName: undefined, currency: undefined, totalBalance: undefined, error: 'quota exceeded' },
    ])
  })
})

describe('pickRemainingBalance', () => {
  const row = (overrides: Partial<ProviderUsage>): ProviderUsage => ({
    provider: 'deepseek',
    displayName: undefined,
    currency: undefined,
    totalBalance: undefined,
    error: undefined,
    ...overrides,
  })

  it('skips providers that reported an error or no balance', () => {
    expect(pickRemainingBalance([
      row({ error: 'quota exceeded', totalBalance: 1 }),
      row({ totalBalance: undefined }),
      row({ provider: 'moonshot', totalBalance: 12.34, currency: 'CNY' }),
    ])).toEqual({ amount: 12.34, currency: 'CNY' })
  })

  it('returns nothing when no provider has a usable balance', () => {
    expect(pickRemainingBalance([])).toBeUndefined()
    expect(pickRemainingBalance([row({ error: 'unauthorized' })])).toBeUndefined()
  })
})

describe('fetchUsageStats', () => {
  it('reads the balance route first', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [{ provider: 'deepseek', displayName: 'DeepSeek', totalBalance: 106.59, currency: 'CNY' }],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const signal = new AbortController().signal
      const rows = await fetchUsageStats(signal)
      expect(rows).toEqual([
        { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 106.59, error: undefined },
      ])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(BALANCE_PATH, expect.objectContaining({ signal, credentials: 'same-origin' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the usage route when the balance route is missing', async () => {
    const fetchMock = vi.fn(async (path: string) => path === BALANCE_PATH
      ? { ok: false, status: 404, json: async () => null }
      : { ok: true, status: 200, json: async () => [{ provider: 'deepseek', totalBalance: 12.34, currency: 'CNY' }] })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const rows = await fetchUsageStats(new AbortController().signal)
      expect(rows).toEqual([
        { provider: 'deepseek', displayName: undefined, currency: 'CNY', totalBalance: 12.34, error: undefined },
      ])
      expect(fetchMock).toHaveBeenNthCalledWith(1, BALANCE_PATH, expect.anything())
      expect(fetchMock).toHaveBeenNthCalledWith(2, USAGE_STATS_PATH, expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the usage route when the balance route carries no rows', async () => {
    const fetchMock = vi.fn(async (path: string) => path === BALANCE_PATH
      ? { ok: true, status: 200, json: async () => ({ balances: [] }) }
      : { ok: true, status: 200, json: async () => [{ provider: 'deepseek', totalBalance: 1 }] })
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await fetchUsageStats(new AbortController().signal)).toEqual([
        { provider: 'deepseek', displayName: undefined, currency: undefined, totalBalance: 1, error: undefined },
      ])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws on a non-success status so the caller keeps its last sample', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => null })))
    try {
      await expect(fetchUsageStats(new AbortController().signal))
        .rejects.toThrow(`${USAGE_STATS_PATH} request failed with status 503`)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
