/**
 * Request identity for one account call. The Host forwards the active UI
 * language and the local UTC offset so the Platform answers in the reader's
 * language and resolves day boundaries in their zone.
 */

import type { AccountClientMetadata } from './types.ts'

/**
 * Build the request identity for one account call.
 * @param locale - active UI language; the Host reduces it to the Platform wire locale.
 * @param version - client build version inlined by the client bundle.
 * @returns the metadata every account call carries.
 * @throws {Error} when the bundle carries no version, instead of reporting an empty one.
 */
export function accountClientMetadata(locale: string, version: string | undefined): AccountClientMetadata {
  // A bundle without a version is a build defect: the Host rejects the call,
  // so failing here names the cause instead of the symptom.
  if (version === undefined) throw new Error('account client metadata requires a client build version')
  return { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
}
