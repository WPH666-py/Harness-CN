/** DeepSeek API-key binding through the harness credential service the Host owns. */

import { randomUUID } from 'node:crypto'
import type { DesktopHostProcess } from './host-process.ts'
import type { DesktopApiKeyStatus } from './ipc.ts'

/**
 * Reference the harness DeepSeek provider resolves. `dsh-credentials-local` stores it
 * under `refs` in the harness-home `.credentials.yaml`, so binding from here lands in
 * the same store the product itself reads.
 */
export const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Remote namespace `dsh-api-settings-controller` mounts for credential references. */
const CREDENTIALS_NAMESPACE = 'credentials'

/** Connection channel that carries every unary Remote invocation. */
const API_PATH = '/api'

/** Model listing that proves a key authenticates; it reads no account data. */
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'

/** Bound on one key check so an unreachable endpoint cannot stall the first launch. */
const VALIDATE_TIMEOUT_MS = 15_000

/** Why a key could not be bound, reported as a locale key by the caller. */
export type ApiKeyFailureReason = 'unauthorized' | 'unreachable' | 'rejected'

/** A binding step that failed for a reason the caller renders in the user's locale. */
export class ApiKeyError extends Error {
  /** @param reason - stable discriminator the caller maps to localized copy. */
  constructor(readonly reason: ApiKeyFailureReason) {
    super(reason)
    this.name = 'ApiKeyError'
  }
}

interface CredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/**
 * Invoke one unary Remote method over the desktop host's shared `/api` channel.
 *
 * A unary method travels the Connection channel, not the stream carrier: the gateway
 * refuses a unary descriptor opened through `stream`, so the NDJSON stream path answers
 * every credential call with a signature error instead of a value. The request envelope
 * carries the caller's `rpcId` and the response echoes it, which is what proves the answer
 * belongs to this call.
 * @param host - running desktop host that owns the Remote gateway.
 * @param method - method name inside the credentials namespace.
 * @param args - named arguments the generated Remote descriptor expects.
 * @returns the decoded success value.
 * @throws {ApiKeyError} when the gateway refuses the call.
 */
async function callCredentials(host: DesktopHostProcess, method: string, args: object): Promise<unknown> {
  const endpoint = `${CREDENTIALS_NAMESPACE}/${method}`
  const rpcId = randomUUID()
  let response: Response
  try {
    response = await host.fetch(new Request(`dsh-app://app${API_PATH}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    }))
  } catch {
    throw new ApiKeyError('unreachable')
  }
  if (!response.ok) throw new ApiKeyError('rejected')
  let decoded: unknown
  try {
    decoded = await response.json()
  } catch {
    throw new ApiKeyError('rejected')
  }
  if (typeof decoded !== 'object' || decoded === null) throw new ApiKeyError('rejected')
  const envelope = decoded as { type?: unknown; rpcId?: unknown; result?: unknown }
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new ApiKeyError('rejected')
  if (typeof envelope.result !== 'object' || envelope.result === null) throw new ApiKeyError('rejected')
  const outcome = envelope.result as { ok?: unknown; value?: unknown }
  // The provider refuses a write when the launch environment already shadows the
  // reference; that is a rejection the user can only fix outside the application.
  if (outcome.ok !== true) throw new ApiKeyError('rejected')
  return outcome.value
}

/**
 * Report whether the harness resolves the DeepSeek key and from which layer.
 * @param host - running desktop host.
 * @returns configured state with the supplying layer when one exists.
 * @throws {ApiKeyError} when the credential service is unreachable.
 */
export async function describeApiKey(host: DesktopHostProcess): Promise<DesktopApiKeyStatus> {
  const described = await callCredentials(host, 'describe', { refs: [DEEPSEEK_API_KEY_REF] })
  const info = (described as Record<string, CredentialInfo> | null)?.[DEEPSEEK_API_KEY_REF]
  return {
    configured: info?.configured === true,
    ...(info?.source === undefined ? {} : { source: info.source }),
  }
}

/**
 * Store the key in the harness credential store and confirm the write landed.
 * @param host - running desktop host.
 * @param value - non-empty API key.
 * @returns the store's state after the write.
 * @throws {ApiKeyError} when the provider refuses the write.
 */
export async function storeApiKey(host: DesktopHostProcess, value: string): Promise<DesktopApiKeyStatus> {
  await callCredentials(host, 'set', { ref: DEEPSEEK_API_KEY_REF, value })
  const status = await describeApiKey(host)
  // The seam publishes a stored value immediately, so a read-back that still reports
  // "not configured" means the write did not land where the provider reads it.
  if (!status.configured) throw new ApiKeyError('rejected')
  return status
}

/**
 * Prove a key authenticates against DeepSeek before it is stored.
 * @param value - candidate API key.
 * @throws {ApiKeyError} `unauthorized` when the key is refused, `unreachable` when the endpoint cannot be reached.
 */
export async function verifyDeepSeekKey(value: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(DEEPSEEK_MODELS_URL, {
      headers: { authorization: `Bearer ${value}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
  } catch {
    throw new ApiKeyError('unreachable')
  }
  // The endpoint answers 401 for a bad key; anything else non-OK is an endpoint fault
  // rather than a rejection of this key, so it must not be reported as an invalid key.
  if (response.status === 401 || response.status === 403) throw new ApiKeyError('unauthorized')
  if (!response.ok) throw new ApiKeyError('unreachable')
}
