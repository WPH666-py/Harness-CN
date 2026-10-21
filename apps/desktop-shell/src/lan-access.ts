/**
 * Opt-in LAN access for the shell's plain-HTTP door.
 *
 * The desktop carrier serves the Web GUI and its API from one loopback origin, so a phone can
 * reach the very same pages only when that listener is also bound to the LAN. This module owns
 * the decision and the credential behind it: a switch the user flips, one shared secret minted
 * with it, and a link that carries the secret.
 *
 * Plain HTTP is deliberate. A self-signed certificate is the one thing a phone will not accept
 * without an install step, and every failure this door exists to remove is downstream of that
 * refusal; the pairing secret is what stands in for transport encryption. The secret is only ever
 * compared in constant time, and it never appears in a log line.
 */

import { timingSafeEqual } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Path the phone opens once to exchange the link secret for a cookie. */
export const LAN_UNLOCK_PATH = '/__lan'

/** Cookie the unlocked phone presents on every later request. */
export const LAN_COOKIE = 'hcn_lan'

/** How long a phone stays unlocked. A year, matching the plugin that came before. */
const LAN_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/** Byte length of the shared secret behind the link. */
const SECRET_BYTES = 32

/** On-disk shape. `version` is written so a later field can be added without guessing. */
interface LanAccessFile {
  version: 1
  enabled: boolean
  secret: string | null
  updatedAt: string
}

/** What the shell's pages render. */
export interface LanAccessStatus {
  /** Whether a phone that presents the secret is let in. */
  readonly enabled: boolean
  /** LAN IPv4 address the link names, when one exists and the switch is on. */
  readonly address: string | null
  /** Port the shell listener bound, when known. */
  readonly port: number | null
  /** Full link a phone opens, including the secret. */
  readonly link: string | null
}

/** The state that was read back from disk, with defaults for a first run. */
function readFile(file: string): LanAccessFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return emptyState()
    const record = raw as Partial<Record<keyof LanAccessFile, unknown>>
    return {
      version: 1,
      enabled: record.enabled === true,
      secret: typeof record.secret === 'string' && record.secret !== '' ? record.secret : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return emptyState()
  }
}

function emptyState(): LanAccessFile {
  return { version: 1, enabled: false, secret: null, updatedAt: new Date(0).toISOString() }
}

/** Compare two secrets without letting the comparison time shorten a guess. */
function sameSecret(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(candidate)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Every non-internal IPv4 address of this machine, private ranges first.
 *
 * The link names one address; a machine with several adapters (a VPN, a virtual switch) would
 * otherwise advertise whichever the enumeration happened to list first.
 */
export function lanAddresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push(entry.address)
    }
  }
  const rank = (address: string): number => {
    if (address.startsWith('192.168.')) return 0
    if (address.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) return 2
    if (address.startsWith('169.254.')) return 4
    return 3
  }
  return found.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
}

/**
 * The shell's LAN door: a switch, one shared secret, and the link built from them.
 *
 * Enabling mints a secret on first use and keeps it, so a phone unlocked once keeps working
 * across restarts. Rotating replaces the secret, which is the only way to revoke every device
 * at once — the door keeps no per-device record on purpose: the phone holds one cookie and the
 * desktop holds no list that could go stale.
 */
export class LanAccess {
  #state: LanAccessFile
  readonly #file: string

  /**
   * @param file - absolute path of the JSON state file.
   */
  constructor(file: string) {
    this.#file = file
    this.#state = readFile(file)
  }

  /** @returns whether the door is open to a phone holding the secret. */
  get enabled(): boolean {
    return this.#state.enabled
  }

  /** @returns the secret behind the current link, minting one when the switch is on. */
  secret(): string | null {
    return this.#state.secret
  }

  /**
   * Whether one presented cookie may pass.
   * @param candidate - cookie value read out of the request.
   * @returns true when the door is on, a secret exists, and the value matches it.
   */
  verify(candidate: string | undefined): boolean {
    const secret = this.#state.secret
    return this.#state.enabled && secret !== null && sameSecret(secret, candidate)
  }

  /**
   * Whether one presented link key may pass.
   *
   * The link key is the same value as the cookie: the phone receives it in a URL and trades it
   * for the cookie, so both forms are checked against the one secret.
   * @param candidate - `key` query parameter of the unlock request.
   * @returns true when it matches the current secret.
   */
  verifyKey(candidate: string | null): boolean {
    const secret = this.#state.secret
    return this.#state.enabled && secret !== null && sameSecret(secret, candidate ?? undefined)
  }

  /** @returns the cookie header value the unlock response should set. */
  cookieHeader(): string {
    return `${LAN_COOKIE}=${this.#state.secret ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(LAN_COOKIE_MAX_AGE_SECONDS)}`
  }

  /**
   * Turn the door on, minting the secret the first time.
   * @returns the status after the change.
   */
  enable(port: number | null): LanAccessStatus {
    const secret = this.#state.secret ?? randomBytes(SECRET_BYTES).toString('hex')
    this.#write({ enabled: true, secret })
    return this.status(port)
  }

  /**
   * Turn the door off. The secret is kept so re-enabling does not invalidate paired phones.
   * @returns the status after the change.
   */
  disable(port: number | null): LanAccessStatus {
    this.#write({ enabled: false, secret: this.#state.secret })
    return this.status(port)
  }

  /**
   * Replace the secret, which invalidates every phone at once.
   * @returns the status carrying the new link.
   */
  rotate(port: number | null): LanAccessStatus {
    this.#write({ enabled: this.#state.enabled, secret: randomBytes(SECRET_BYTES).toString('hex') })
    return this.status(port)
  }

  /**
   * Describe the door for the page that renders it.
   * @param port - the bound shell port, or null before the listener is up.
   * @returns the current switch, address, and link.
   */
  status(port: number | null): LanAccessStatus {
    const address = lanAddresses()[0] ?? null
    const link = this.#state.enabled && this.#state.secret !== null && address !== null && port !== null
      ? `http://${address}:${String(port)}${LAN_UNLOCK_PATH}?key=${this.#state.secret}`
      : null
    return { enabled: this.#state.enabled, address, port, link }
  }

  /** Persist one change, replacing the file in one step so a crash cannot truncate it. */
  #write(next: { enabled: boolean; secret: string | null }): void {
    const state: LanAccessFile = {
      version: 1,
      enabled: next.enabled,
      secret: next.secret,
      updatedAt: new Date().toISOString(),
    }
    this.#state = state
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.#file)
  }
}
