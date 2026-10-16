/**
 * Account domain types and the `account` Remote namespace surface.
 *
 * The namespace is served by the Desktop seed's account controller; no
 * workspace package declares it, and the generated Host FaceModel that
 * describes it is not part of this package set. The section therefore states
 * the wire facts it consumes and merges the namespace into
 * `TypertRemoteNamespaceMap`, which is what makes `ctx.remote.account`
 * resolvable.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'

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

/** Account Remote namespace as the Desktop account controller serves it. */
export interface AccountRemote {
  /** Acknowledge that one bonus notice was displayed. */
  ackBonusNotified(
    accountId: AccountUserId,
    orderId: AccountBonusOrderId,
    client: AccountClientMetadata,
  ): Promise<RemoteResult<boolean>>
  /** Cancel an in-flight sign-in attempt. */
  cancelSignIn(attemptId: SignInAttemptId): Promise<RemoteResult<AccountView>>
  /** Read the wallets. */
  getBalance(client: AccountClientMetadata): Promise<RemoteResult<AccountDetails['balance'] | null>>
  /** Read the display identity. */
  getProfile(client: AccountClientMetadata): Promise<RemoteResult<AccountDetails['profile'] | null>>
  /** Read the current sign-in state. */
  getState(): Promise<RemoteResult<AccountView>>
  /** Read the bonuses this account has not been shown yet. */
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<RemoteResult<AccountBonusBatch | null>>
  /** Report whether the Host is running tasks that use this credential. */
  hasRunningAccountTasks(): Promise<RemoteResult<boolean>>
  /** Drop the stored credential. */
  signOut(client: AccountClientMetadata): Promise<RemoteResult<AccountView>>
  /** Begin a sign-in attempt and open the Platform page for it. */
  startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    loginSource: 'web' | 'desktop',
  ): Promise<RemoteResult<AccountView>>
  /** Follow the sign-in state until the caller's signal aborts. */
  watch(signal?: AbortSignal): AsyncIterable<AccountView>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    /** Desktop account controller namespace. */
    account: AccountRemote
  }
}
