// @vitest-environment jsdom
/**
 * The Host half of the Account & balance plugin: every account call belongs to
 * the browser half, so a Host build has nothing to apply.
 */

import { describe, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('account settings host half', () => {
  it('applies without host-side work', () => {
    // The assertion is the call itself: the Host half registers nothing and must return without throwing.
    apply()
  })
})
