/** Loopback HTTP surface for the Tauri shell: shell pages, control API, and the Host proxy. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DesktopApiKeyStatus, DesktopUpdateState } from '../../desktop/src/ipc.ts'
import type { DesktopLogSnapshot } from '../../desktop/src/log-buffer.ts'
import type { DesktopLocale } from '../../desktop/src/locale.ts'
import type { DesktopPluginRecord, DesktopProjectMutation } from '../../desktop/src/project-manager.ts'
import type { ShellStatus } from './shell-types.ts'

/** Path prefix serving the shell's own HTML, CSS, and video assets. */
export const SHELL_ASSET_PREFIX = '/shell/'

/**
 * Path prefix of the shell control API.
 *
 * The dsh Host owns `/api/` for its own Remote gateway, so the shell cannot take that
 * prefix without shadowing the product's own transport.
 */
export const SHELL_API_PREFIX = '/shell-api/'

/** Cookie the WebView receives with the first response and presents on every control call. */
const SHELL_COOKIE = 'hcn'

/** Longest accepted request body on the control API. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
}

/** Headers that belong to one hop and must not be forwarded through the Host proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Operations the shell's pages reach over HTTP. */
export interface ShellApi {
  /** Current launch status. */
  status(): ShellStatus
  /** Localized shell copy. */
  locale(): DesktopLocale
  /** Retained run log. */
  logs(): DesktopLogSnapshot
  /** Empty the retained run log. */
  clearLogs(): DesktopLogSnapshot
  /** Show the run-log file in the platform file manager. */
  revealLogs(): void
  /** Installed desktop plugin inventory. */
  plugins(): readonly DesktopPluginRecord[]
  /** Apply one plugin mutation. */
  mutate(mutation: DesktopProjectMutation): Promise<void>
  /** Most recent release-channel state. */
  updateState(): DesktopUpdateState
  /** Check the release channel. */
  checkUpdates(): Promise<DesktopUpdateState>
  /** Download and start the offered release. */
  installUpdates(): Promise<DesktopUpdateState>
  /** Stop a download the user cancelled. */
  cancelUpdates(): boolean
  /** Remove this installation, leaving the user's own files alone. */
  uninstall(): void
  /** Remember the release the user chose not to install. */
  skipUpdate(version: string): void
  /** Whether the DeepSeek credential is configured. */
  apiKeyStatus(): Promise<DesktopApiKeyStatus>
  /** Prove and store one DeepSeek key. */
  saveApiKey(key: string): Promise<DesktopApiKeyStatus>
  /** Continue without binding a key. */
  deferApiKey(): void
  /** End the shell. */
  quit(): void
  /** Forward one request to the running Host. */
  fetchHost(request: Request): Promise<Response>
}

/** Options for {@link startShellServer}. */
export interface ShellServerOptions {
  /** Absolute directory holding the shell's static pages under `shell/`. */
  readonly resourceDir: string
  /** Control surface the pages and the Rust shell drive. */
  readonly api: ShellApi
}

/** One running loopback server. */
export interface ShellServer {
  /** Port the server bound on `127.0.0.1`. */
  readonly port: number
  /** Origin the WebView must load. */
  readonly origin: string
  /** Send one Server-Sent Event to every subscribed page. */
  publish(name: 'status' | 'logs' | 'update', value: unknown): void
  /** Stop accepting requests and release the port. */
  close(): Promise<void>
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Reject a request whose Host header does not name this exact loopback listener. */
function hostAllowed(message: IncomingMessage, port: number): boolean {
  const host = message.headers.host
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`
}

function sameToken(expected: string, cookie: string | undefined): boolean {
  if (cookie === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(cookie)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Read the shell cookie value out of one request's Cookie header. */
function shellCookie(message: IncomingMessage): string | undefined {
  const header = message.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === SHELL_COOKIE) return part.slice(separator + 1).trim()
  }
  return undefined
}

async function readJsonBody(message: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of message) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_CONTROL_BODY_BYTES) throw new Error('dsh shell: control request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('dsh shell: control request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requireString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`dsh shell: ${subject} must be a non-empty string`)
  return value
}

/** Build the Fetch request the Host pipe protocol carries for one incoming message. */
function toHostRequest(message: IncomingMessage, port: number): Request {
  const method = (message.method ?? 'GET').toUpperCase()
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'host') continue
    if (Array.isArray(value)) for (const one of value) headers.append(name, one)
    else headers.set(name, value)
  }
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const init = {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  }
  return new Request(`http://127.0.0.1:${String(port)}${message.url ?? '/'}`, init as RequestInit)
}

async function writeResponse(message: ServerResponse, response: Response): Promise<void> {
  const headers: [string, string][] = []
  for (const [name, value] of response.headers) {
    // `content-encoding` and `content-length` describe the bytes the Host sent, not the bytes the
    // Fetch layer hands back: it decodes a compressed body before this code ever sees it, so
    // forwarding either header would describe the body wrongly.
    if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'content-encoding') continue
    headers.push([name, value])
  }
  for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie])
  message.writeHead(response.status, Object.fromEntries(headers))
  if (response.body === null) {
    message.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), message)
}

function sendJson(message: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  message.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  message.end(body)
}

async function serveShellAsset(message: ServerResponse, resourceDir: string, pathname: string): Promise<void> {
  const root = resolve(resourceDir, 'shell')
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.slice(SHELL_ASSET_PREFIX.length))
  } catch {
    sendJson(message, 400, { error: 'dsh shell: malformed asset path' })
    return
  }
  const target = resolve(normalize(join(root, decoded === '' ? 'startup.html' : decoded)))
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(message, 403, { error: 'dsh shell: asset path escapes the shell root' })
    return
  }
  try {
    const body = await readFile(target)
    message.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    })
    message.end(body)
  } catch {
    sendJson(message, 404, { error: 'dsh shell: asset not found' })
  }
}

/**
 * Start the shell's loopback HTTP surface.
 *
 * The listener is bound to `127.0.0.1` on an ephemeral port, which is the only address
 * the WebView can reach and the only one this process has to publish. Every control call
 * additionally has to present the per-launch cookie handed out with the first response, so
 * a page in the user's browser cannot drive the shell's package and update operations with
 * a cross-site request, and a Host header that is not this listener is refused outright so
 * a rebound name cannot reach it either.
 * @param options - static root and control surface.
 * @returns the running server with its bound port and event fan-out.
 */
export async function startShellServer(options: ShellServerOptions): Promise<ShellServer> {
  const token = randomBytes(32).toString('hex')
  const clients = new Set<ServerResponse>()
  /** Requests still being answered, with the signal that ends each one. */
  const inFlight = new Set<AbortController>()
  let port = 0

  const publish = (name: string, value: unknown): void => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`
    for (const client of clients) client.write(frame)
  }

  const handleControl = async (message: IncomingMessage, response: ServerResponse, route: string): Promise<void> => {
    const method = (message.method ?? 'GET').toUpperCase()
    if (route === 'events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      response.write(`event: status\ndata: ${JSON.stringify(options.api.status())}\n\n`)
      response.write(`event: update\ndata: ${JSON.stringify(options.api.updateState())}\n\n`)
      clients.add(response)
      message.on('close', () => { clients.delete(response) })
      return
    }
    if (route === 'status' && method === 'GET') return sendJson(response, 200, options.api.status())
    if (route === 'locale' && method === 'GET') return sendJson(response, 200, options.api.locale())
    if (route === 'logs' && method === 'GET') return sendJson(response, 200, options.api.logs())
    if (route === 'logs/clear' && method === 'POST') return sendJson(response, 200, options.api.clearLogs())
    if (route === 'logs/reveal' && method === 'POST') {
      options.api.revealLogs()
      return sendJson(response, 200, {})
    }
    if (route === 'plugins' && method === 'GET') return sendJson(response, 200, options.api.plugins())
    if (route.startsWith('plugins/') && method === 'POST') {
      const body = await readJsonBody(message)
      const action = route.slice('plugins/'.length)
      if (action === 'add') {
        await options.api.mutate({ type: 'plugin-add', spec: requireString(body.spec, 'plugin spec') })
      } else if (action === 'remove') {
        await options.api.mutate({ type: 'plugin-remove', name: requireString(body.name, 'plugin name') })
      } else if (action === 'update') {
        await options.api.mutate({
          type: 'plugin-update',
          name: requireString(body.name, 'plugin name'),
          version: requireString(body.version, 'plugin version'),
        })
      } else {
        return sendJson(response, 404, { error: 'dsh shell: unknown plugin operation' })
      }
      return sendJson(response, 200, {})
    }
    if (route === 'updates' && method === 'GET') return sendJson(response, 200, options.api.updateState())
    if (route === 'updates/check' && method === 'POST') return sendJson(response, 200, await options.api.checkUpdates())
    if (route === 'updates/install' && method === 'POST') return sendJson(response, 200, await options.api.installUpdates())
    if (route === 'updates/cancel' && method === 'POST') {
      return sendJson(response, 200, { cancelled: options.api.cancelUpdates() })
    }
    if (route === 'updates/uninstall' && method === 'POST') {
      options.api.uninstall()
      return sendJson(response, 200, {})
    }
    if (route === 'updates/skip' && method === 'POST') {
      const body = await readJsonBody(message)
      options.api.skipUpdate(requireString(body.version, 'release version'))
      return sendJson(response, 200, {})
    }
    if (route === 'api-key' && method === 'GET') return sendJson(response, 200, await options.api.apiKeyStatus())
    if (route === 'api-key' && method === 'POST') {
      const body = await readJsonBody(message)
      return sendJson(response, 200, await options.api.saveApiKey(requireString(body.key, 'API key')))
    }
    if (route === 'api-key/defer' && method === 'POST') {
      options.api.deferApiKey()
      return sendJson(response, 200, {})
    }
    if (route === 'quit' && method === 'POST') {
      sendJson(response, 200, {})
      setImmediate(() => { options.api.quit() })
      return
    }
    return sendJson(response, 404, { error: 'dsh shell: unknown control route' })
  }

  const server: Server = createServer((message, response) => {
    void (async () => {
      const url = new URL(message.url ?? '/', `http://127.0.0.1:${String(port)}`)
      if (!hostAllowed(message, port)) {
        sendJson(response, 403, { error: 'dsh shell: unexpected Host header' })
        return
      }
      const cookie = shellCookie(message)
      if (cookie === undefined) {
        response.setHeader('set-cookie', `${SHELL_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`)
      }
      // A Host request can outlive the exit that started: the workspace's event stream is open
      // until the page is gone, so a stop that waited for connections to drain would wait for the
      // WebView it is in the middle of closing. Tracking the request is what lets the stop abort
      // it instead.
      const abort = new AbortController()
      inFlight.add(abort)
      try {
        if (url.pathname.startsWith(SHELL_API_PREFIX)) {
          if (!sameToken(token, cookie)) {
            sendJson(response, 403, { error: 'dsh shell: control surface requires the shell session cookie' })
            return
          }
          await handleControl(message, response, url.pathname.slice(SHELL_API_PREFIX.length))
          return
        }
        if (url.pathname.startsWith(SHELL_ASSET_PREFIX)) {
          await serveShellAsset(response, options.resourceDir, url.pathname)
          return
        }
        const forwarded = toHostRequest(message, port)
        abort.signal.addEventListener('abort', () => { forwarded.signal.throwIfAborted() }, { once: true })
        await writeResponse(response, await options.api.fetchHost(forwarded))
      } catch (error) {
        if (response.headersSent) {
          response.destroy()
          return
        }
        sendJson(response, 500, { error: errorOf(error, 'dsh shell: request failed').message })
      } finally {
        inFlight.delete(abort)
      }
    })()
  })
  server.keepAliveTimeout = 65_000
  // A long-lived event stream must not be closed by the default request timeout.
  server.requestTimeout = 0
  server.headersTimeout = 65_000

  await new Promise<void>((settle, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { settle() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('dsh shell: loopback listener has no port')
  port = address.port

  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    publish: (name: 'status' | 'logs' | 'update', value: unknown) => { publish(name, value) },
    close: async () => {
      for (const client of clients) client.end()
      clients.clear()
      // The workspace holds its own event stream open for as long as the page is loaded, and the
      // page is only unloaded once this process is gone. Waiting for the connections to drain
      // would therefore wait for the exit that is trying to happen, so each in-flight request is
      // aborted and the sockets still open when the listener stops accepting are destroyed.
      for (const abort of inFlight) abort.abort(new Error('dsh shell: the control surface is stopping'))
      inFlight.clear()
      const closed = new Promise<void>((settle) => { server.close(() => { settle() }) })
      server.closeIdleConnections()
      server.closeAllConnections()
      await closed
    },
  }
}
