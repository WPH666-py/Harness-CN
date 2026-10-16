// @vitest-environment jsdom
/**
 * Client metadata every account remote call carries: locale, client build
 * version, and the browser's timezone offset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountClientMetadata } from '../src/client/client-metadata.ts'

const NOW = Date.parse('2026-06-01T12:00:00.000Z')

describe('accountClientMetadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the locale, the build version, and the offset from UTC in seconds', () => {
    expect(accountClientMetadata('zh-CN', '0.1.5-rc.26')).toEqual({
      version: '0.1.5-rc.26',
      locale: 'zh-CN',
      // The Host stores UTC, so the browser's inverted minutes offset becomes seconds.
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
  })

  it('expresses the timezone offset in whole seconds', () => {
    const metadata = accountClientMetadata('en', '1.0.0')

    expect(metadata.timezoneOffsetSeconds % 60).toBe(0)
  })

  it('refuses to build metadata without a client build version', () => {
    expect(() => accountClientMetadata('en', undefined))
      .toThrow('account client metadata requires a client build version')
  })
})
