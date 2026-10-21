/**
 * Launcher and HTTP proxy for the monolith bridge.
 *
 * The monolith is a plain HTTP server, not a pipe-framed host child, so switching a launch over to it
 * is two jobs: start the process and learn its origin from its first stdout line, then forward every
 * request that arrives on the shell's control surface. Keeping both here means the shell's routing
 * code does not need to know which backend answered.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Line the bridge prints once it is listening. */
const LISTEN_PATTERN = /mono bridge listening on (http:\/\/127\.0\.0\.1:\d+)/u

/** How long the bridge may take to report its origin. */
const START_TIMEOUT_MS = 20_000

/** One request forwarded through the bridge. */
export interface MonoHostStart {
  /** Origin the window and the proxy should use. */
  readonly origin: string
}

/**
 * Resolve the bridge script inside an installation.
 *
 * The packaged layout keeps it beside the sidecar; a checkout keeps it under `mono/src`.
 * @param resourceDir - the installation's `resources` directory.
 * @returns the absolute script path, or undefined when neither layout carries one.
 */
export function resolveMonoScript(resourceDir: string): string | undefined {
  const candidates = [
    join(resourceDir, 'mono', 'src', 'server.mjs'),
    join(resourceDir, 'mono', 'server.mjs'),
    join(resourceDir, '..', 'mono', 'src', 'server.mjs'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

/** One running bridge, owned by the shell. */
export class MonoHostProcess {
  private child: ChildProcess | undefined
  private originValue: string | undefined
  private stderrTail = ''

  /**
   * @param node - bundled Node executable to run the bridge with.
   * @param script - absolute path of `server.mjs`.
   * @param environment - extra environment entries (API key, model, budget).
   */
  constructor(
    private readonly node: string,
    private readonly script: string,
    private readonly environment: Record<string, string> = {},
  ) {}

  /** Origin of the running bridge. */
  get origin(): string | undefined {
    return this.originValue
  }

  /** Last lines the bridge wrote to stderr, for a failure the shell must report. */
  get failure(): string {
    return this.stderrTail.trim()
  }

  /**
   * Start the bridge and wait for its origin.
   * @returns the origin it bound.
   */
  async start(): Promise<MonoHostStart> {
    if (this.child !== undefined && this.originValue !== undefined) return { origin: this.originValue }
    const child = spawn(this.node, [this.script], {
      env: {
        ...process.env,
        MONO_HOST: '127.0.0.1',
        // Port zero: the OS picks one, so two launches never collide.
        MONO_PORT: '0',
        ...this.environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000)
    })
    child.stdout?.setEncoding('utf8')
    return await new Promise<MonoHostStart>((resolvePromise, rejectPromise) => {
      let buffered = ''
      const timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error(`mono bridge did not report an origin within ${String(START_TIMEOUT_MS)} ms: ${this.failure}`))
      }, START_TIMEOUT_MS)
      const settle = (origin: string): void => {
        clearTimeout(timer)
        this.originValue = origin
        resolvePromise({ origin })
      }
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk
        const matched = LISTEN_PATTERN.exec(buffered)
        const origin = matched?.[1]
        if (origin !== undefined && this.originValue === undefined) settle(origin)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (this.originValue === undefined) {
          rejectPromise(new Error(`mono bridge exited with ${String(code)} before listening: ${this.failure}`))
        }
      })
    })
  }

  /**
   * Forward one request to the bridge.
   *
   * Streaming bodies pass through unchanged, so SSE turns keep working: the caller receives the
   * bridge's own `Response` rather than a buffered copy.
   * @param request - request from the window or the control surface.
   * @returns the bridge's response.
   */
  async fetch(request: Request): Promise<Response> {
    const origin = this.originValue
    if (origin === undefined) throw new Error('mono bridge is not running')
    const url = new URL(request.url)
    const target = new URL(`${url.pathname}${url.search}`, origin)
    const headers = new Headers(request.headers)
    headers.delete('host')
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: 'half' } as RequestInit : {}),
    })
    return response
  }

  /**
   * Stop the bridge.
   *
   * The child is killed rather than asked politely: it owns no durable state of its own, and every
   * write it makes is either already fsynced by the store or repeated on the next launch.
   */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.originValue = undefined
    if (child === undefined || child.exitCode !== null) return
    await new Promise<void>((resolvePromise) => {
      child.once('exit', () => { resolvePromise() })
      child.kill()
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolvePromise()
      }, 5_000).unref()
    })
  }
}
