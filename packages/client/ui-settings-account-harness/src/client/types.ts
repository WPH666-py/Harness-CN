/**
 * Account domain types the section renders, plus the `account` Remote
 * namespace surface it calls.
 *
 * The namespace is served by the Desktop seed's account controller and its
 * generated Remote contribution is what this plugin's browser half mounts
 * (`./index.ts`), so `TypertRemoteNamespaceMap.account` is declared by that
 * contribution's own declaration file — not restated here. What stays local is
 * the payload vocabulary on screen; the Host serves the identical shapes.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

/** Request identity sent with one account call. */
export interface AccountClientMetadata {
  /** Client build version. */
  readonly version: string
  /** Active UI language; the Host reduces it to the Platform wire locale. */
  readonly locale: string
  /** Local UTC offset in seconds, positive east of Greenwich. */
  readonly timezoneOffsetSeconds: number
}

/** Opaque identity of one sign-in attempt. */
export type SignInAttemptId = Branded<'SignInAttemptId'>

/** Reason a sign-in attempt ended without a credential. */
export type SignInErrorCode = 'network' | 'protocol' | 'expired' | 'storage'

/** One sign-in attempt as the Host reports it. */
export interface SignInAttemptView {
  /** Attempt identity, passed back to cancel it. */
  readonly id: SignInAttemptId
  /** Where the attempt currently is. */
  readonly phase:
    | 'initializing'
    | 'waiting-browser'
    | 'exchanging'
    | 'committing'
    | 'succeeded'
    | 'cancelled'
    | 'expired'
    | 'failed'
  /** Platform page the user continues sign-in on, once the attempt has one. */
  readonly authorizeUrl?: string
  /** Epoch milliseconds after which the attempt is expired. */
  readonly expiresAt?: number
  /** Terminal failure reason. */
  readonly errorCode?: SignInErrorCode
}

/** Platform destinations the account surface links to. */
export interface AccountLinks {
  /** Usage page. */
  readonly usageUrl: string
  /** Top-up page. */
  readonly topUpUrl: string
}

/** Account sign-in state, carrying whatever attempt is in flight. */
export interface AccountView {
  /** Whether a credential is stored on this Host. */
  readonly status: 'signed-out' | 'credential-stored'
  /** Platform destinations for the current sign-in state. */
  readonly links: AccountLinks
  /** In-flight or last-finished attempt; null before the first one. */
  readonly attempt: SignInAttemptView | null
}

/** Opaque identity of one account. */
export type AccountUserId = Branded<'AccountUserId'>

/** Identity fields the Platform reports for the stored credential. */
export interface AccountProfile {
  /** Account id, absent when the Platform reported an anonymous credential. */
  readonly id: AccountUserId | null
  /** Display name. */
  readonly name: string | null
  /** Contact address. */
  readonly contact: string | null
  /** Avatar image URL. */
  readonly avatarUrl?: string | null
}

/** One currency wallet. */
export interface AccountWallet {
  /** Wallet currency. */
  readonly currency: 'CNY' | 'USD'
  /** Decimal balance string. */
  readonly balance: string
}

/**
 * The two independently-read account details. Each field fails on its own, so
 * an unavailable profile never hides a balance that did arrive.
 */
export interface AccountDetails {
  /** Display identity. */
  readonly profile: { readonly status: 'ready'; readonly value: AccountProfile } | { readonly status: 'failed' }
  /** Topped-up and granted wallets. */
  readonly balance:
    | {
      readonly status: 'ready'
      readonly value: readonly AccountWallet[]
      readonly bonusWallets: readonly AccountWallet[]
    }
    | { readonly status: 'failed' }
}

/** Opaque identity of one granted-bonus order. */
export type AccountBonusOrderId = Branded<'AccountBonusOrderId'>

/** One granted bonus the Host has not acknowledged yet. */
export interface AccountBonusNotification {
  /** Order identity, used to acknowledge the notice. */
  readonly orderId: AccountBonusOrderId
  /** Campaign the bonus came from. */
  readonly campaign: string
  /** Decimal granted amount. */
  readonly amount: string
  /** Granted amount currency. */
  readonly currency: 'CNY' | 'USD'
  /** ISO timestamp the bonus was granted at. */
  readonly grantedAt: string
  /** ISO timestamp the bonus expires at. */
  readonly expiresAt: string
  /** Server-authored notice text, shown verbatim. */
  readonly message: string
}

/** Unnotified bonuses for one account. */
export interface AccountBonusBatch {
  /** Account the bonuses belong to. */
  readonly accountId: AccountUserId
  /** Unnotified bonuses, most recent first. */
  readonly bonuses: readonly AccountBonusNotification[]
}

/**
 * Account Remote namespace as the mounted account contribution serves it. The
 * declaration comes from `@deepseek-ai/dsh-api-account-controller/remote`,
 * which `./index.ts` mounts before anything here reads it.
 */
export type AccountRemote = TypertRemoteNamespaceMap['account']
