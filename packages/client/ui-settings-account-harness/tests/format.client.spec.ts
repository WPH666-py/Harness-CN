// @vitest-environment jsdom
/**
 * Balance presentation: a wallet must read exactly the way Platform Web renders
 * the same amount, in both the topped-up and the granted balance rows.
 */

import { describe, expect, it } from 'vitest'
import { formatBalance, isPositiveBalance, walletText } from '../src/client/format.ts'

describe('formatBalance', () => {
  it.each([
    ['0', '¥', '¥0.00'],
    ['-0', '¥', '¥0.00'],
    ['0.00', '$', '$0.00'],
    ['5', '¥', '¥5.00'],
    ['1.5', '¥', '¥1.50'],
    ['1.05', '¥', '¥1.05'],
    ['1.999', '¥', '¥1.99'],
    ['1234567.89', '¥', '¥1,234,567.89'],
    ['0.001', '¥', '<¥0.01'],
    ['0.009', '$', '<$0.01'],
    ['-5', '¥', '-¥5.00'],
    ['-1.5', '$', '-$1.50'],
    ['-1.004', '¥', '-¥1.00'],
    ['-1.005', '¥', '-¥1.01'],
    ['-0.001', '¥', '-¥0.01'],
  ] as const)('renders %s in %s as %s', (amount, symbol, rendered) => {
    expect(formatBalance(amount, symbol)).toBe(rendered)
  })

  it.each([
    ['.5', '¥', '¥0.50'],
    ['-.5', '$', '-$0.50'],
  ] as const)('reads the fraction of %s with an empty whole part', (amount, symbol, rendered) => {
    // A decimal string written without whole digits still has to render: its
    // whole part counts as zero rather than as an empty digit group.
    expect(formatBalance(amount, symbol)).toBe(rendered)
  })
})

describe('isPositiveBalance', () => {
  it.each([
    ['1.00', true],
    ['0.01', true],
    ['1234567.89', true],
    ['0', false],
    ['0.00', false],
    ['-1', false],
    ['-0.01', false],
  ] as const)('reports %s as %s', (balance, positive) => {
    expect(isPositiveBalance(balance)).toBe(positive)
  })
})

describe('walletText', () => {
  it('joins every wallet in Host order with one middle dot', () => {
    expect(walletText([
      { currency: 'CNY', balance: '1.5' },
      { currency: 'USD', balance: '-0.001' },
      { currency: 'CNY', balance: '0' },
    ])).toBe('¥1.50 · -$0.01 · ¥0.00')
  })

  it('renders one wallet without a separator', () => {
    expect(walletText([{ currency: 'USD', balance: '1' }])).toBe('$1.00')
  })

  it('renders no wallets as an empty line', () => {
    expect(walletText([])).toBe('')
  })
})
