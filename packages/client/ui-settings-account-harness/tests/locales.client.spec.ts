// @vitest-environment jsdom
/**
 * Copy for the Account & balance section: both dictionaries must cover the same
 * keys, because the section reads every key through one bound translate.
 */

import { describe, expect, it } from 'vitest'
import { en, zh, type AccountSettingsKey } from '../src/client/locales.ts'

describe('account section copy', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('gives every key non-empty copy in both locales', () => {
    for (const key of Object.keys(en) as AccountSettingsKey[]) {
      expect(en[key].trim(), `en.${key}`).not.toBe('')
      expect(zh[key].trim(), `zh.${key}`).not.toBe('')
    }
  })

  it('localizes the copy instead of reusing the English dictionary', () => {
    expect(zh).not.toEqual(en)
  })
})
