/** Loopback HTTP surface for the Tauri shell: shell pages, control API, and the Host proxy. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { attachStreamMux } from './ws-mux.ts'
import QRCode from 'qrcode'
import type { DesktopApiKeyStatus, DesktopUpdateState } from '../../desktop/src/ipc.ts'
import type { DesktopLogSnapshot } from '../../desktop/src/log-buffer.ts'
import type { DesktopLocale } from '../../desktop/src/locale.ts'
import type { DesktopPluginRecord, DesktopProjectMutation } from '../../desktop/src/project-manager.ts'
import type { FeedbackSubmission } from './feedback-mail.ts'
import { LAN_COOKIE, LAN_UNLOCK_PATH, lanAddresses, type LanAccess } from './lan-access.ts'
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
  '.json': 'application/json; charset=utf-8',
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
  /** Mail one submitted review to the author's own mailbox. */
  sendFeedback(submission: FeedbackSubmission): Promise<void>
  /** Whether the DeepSeek credential is configured. */
  apiKeyStatus(): Promise<DesktopApiKeyStatus>
  /** Prove and store one DeepSeek key. */
  saveApiKey(key: string): Promise<DesktopApiKeyStatus>
  /** Continue without binding a key. */
  deferApiKey(): void
  /** End the shell. */
  quit(): void
  /**
   * Replace this application with a fresh copy of itself.
   *
   * The window menu offers the same action; the phone menu asks for it over HTTP, so the control
   * surface hands the request back to the process that owns the single-instance claim.
   */
  restart(): void
  /** Forward one request to the running Host. */
  fetchHost(request: Request): Promise<Response>
}

/** Options for {@link startShellServer}. */
export interface ShellServerOptions {
  /** Absolute directory holding the shell's static pages under `shell/`. */
  readonly resourceDir: string
  /** Control surface the pages and the Rust shell drive. */
  readonly api: ShellApi
  /**
   * Record one line in the run log the shell pages read.
   *
   * A shell page is the one window whose failure cannot be reported by the page itself: if its
   * script never runs, the window paints markup and says nothing. This process serves that page, so
   * it is the only participant that can record which one was requested, and the run log is where a
   * user can go and look.
   */
  readonly note?: ((text: string) => void) | undefined
  /**
   * The LAN door this process serves.
   *
   * The listener always binds every interface so a phone can reach it; this object decides
   * whether the request is answered. Keeping the decision here rather than in the bind address is
   * what lets the switch change without restarting the Host behind it.
   */
  readonly lan: LanAccess
  /**
   * Whether the Host has finished mounting the plugins this launch deferred.
   *
   * Those bundles are mounted after the handshake so the conversation paints first; until this
   * answers true the page is missing their panels, which is what the reload below is for.
   */
  readonly deferredReady?: (() => boolean) | undefined
}

/** One running loopback server. */
export interface ShellServer {
  /** Port the server bound on `127.0.0.1`. */
  readonly port: number
  /** Origin the WebView must load. */
  readonly origin: string
  /** Origin the shell's own windows load from: `/shell/*` and `/shell-api/*` only, loopback only. */
  readonly shellOrigin: string
  /** Port behind {@link shellOrigin}. */
  readonly shellPort: number
  /** Send one Server-Sent Event to every subscribed page. */
  publish(name: 'status' | 'logs' | 'update', value: unknown): void
  /** Stop accepting requests and release the port. */
  close(): Promise<void>
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Reject a request whose Host header names neither this listener nor a LAN address it serves. */
function hostAllowed(message: IncomingMessage, ports: readonly number[]): boolean {
  const host = message.headers.host
  if (host === undefined) return false
  for (const port of ports) {
    if (host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`) return true
    if (lanAddresses().some((address) => host === `${address}:${String(port)}`)) return true
  }
  return false
}

/** Whether one peer address is this machine talking to itself. */
function isLoopbackPeer(peer: string | undefined): boolean {
  if (peer === undefined) return true
  const bare = peer.startsWith('::ffff:') ? peer.slice('::ffff:'.length) : peer
  return bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.')
}

/**
 * Control routes a paired phone may drive.
 *
 * The phone menu offers restart, the run log, plugin management, the author page, the shop and a
 * review; the author page and the shop are plain pages, so only these five operations remain. The
 * list is a whitelist rather than a denylist: a route added later is local until someone says
 * otherwise here.
 */
const LAN_CONTROL_ROUTES: ReadonlySet<string> = new Set([
  'status',
  'locale',
  'logs',
  'logs/clear',
  'plugins',
  'feedback',
  'restart',
])

/** Whether one control route is part of the phone menu's surface. */
function lanControlRoute(route: string): boolean {
  if (LAN_CONTROL_ROUTES.has(route)) return true
  return route.startsWith('plugins/')
}

/**
 * Tags the phone menu adds to the Host page before it reaches a phone.
 *
 * Injection is the only place a page the Host serves can gain UI without the Host knowing about
 * it, and it is what makes the menu reachable at all: the phone sees the GUI, not a shell page.
 */
const MOBILE_MENU_TAGS = '<link rel="stylesheet" href="/shell/mobile-menu.css">'
  + '<script src="/shell/mobile-menu.js" defer></script>'

/**
 * Tags every page gets: the deferred-plugin watcher.
 *
 * It is not part of {@link MOBILE_MENU_TAGS} because it applies to the desktop window as well: the
 * launch defers slow plugin host halves, so the first paint is missing their panels, and the reload
 * this script performs is what makes them appear without the user doing anything.
 */
/**
 * Back control injected into the shell's own pages when a phone asked for them.
 *
 * Those pages are separate documents, so on a phone they replace the workspace page and the only way
 * back is the browser's own chrome — which the in-app menu had just covered with a full-screen sheet.
 * A desktop window has a title bar instead, so this is added only for remote requests. It is a
 * same-origin script because these pages carry script-src 'self', which blocks inline script.
 */
const MOBILE_BACK_TAGS = '<script src="/shell/mobile-back.js" defer></script>'

/** Presentation overrides that apply to the desktop window and a phone alike. */
const PRESENTATION_TAGS = '<link rel="stylesheet" href="/shell/plugin-overrides.css">'
const DEFERRED_WATCHER_TAGS = '<script src="/shell/deferred.js" defer></script>'

/** Add the given tags to an HTML response, leaving every other response untouched. */
async function withShellTags(response: Response, tags: string): Promise<Response> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/html')) return response
  const html = await response.text()
  if (!html.includes('</head>')) return response
  const headers = new Headers(response.headers)
  // The body is rewritten here, so the length and encoding the Host sent describe bytes this
  // process no longer produces.
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(html.replace('</head>', `${tags}</head>`), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Read the LAN cookie value out of one request's Cookie header. */
function lanCookie(message: IncomingMessage): string | undefined {
  const header = message.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === LAN_COOKIE) return part.slice(separator + 1).trim()
  }
  return undefined
}

/**
 * Answer a phone that reached the LAN door without a valid secret.
 *
 * The page carries no product data and no credential: it says what the door needs and where the
 * link comes from. Every asset the real GUI would request is answered with this one page while the
 * visitor is unknown, so a scanner that finds the port learns nothing it could replay.
 */
function sendLanNotice(response: ServerResponse, reason: 'off' | 'locked'): void {
  const body = Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="dsh-lan-door" content="${reason}">`
    + `<title>Harness-CN 移动访问</title><style>`    + `body{margin:0;padding:32px 20px;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#1f2328;background:#f6f7f9}`
    + `main{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 2px 16px rgba(0,0,0,.06)}`
    + `h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:#4b5563}code{background:#f3f4f6;border-radius:6px;padding:2px 6px}`
    + `</style></head><body><main><h1>${reason === 'off' ? '局域网访问未开启' : '这台手机还没有配对'}</h1>`
    + (reason === 'off'
      ? `<p>电脑端的 Harness-CN 目前只允许本机访问。请在电脑上打开「移动访问」窗口，开启局域网访问，再用窗口里给出的链接或二维码连接。</p>`
      : `<p>请在电脑上打开「移动访问」窗口，用手机扫描二维码，或把窗口里的链接发到这台手机打开。</p>`)
    + `<p>链接只在这台电脑上生成，不需要安装证书，也不需要输入配对码。</p>`
    + `</main></body></html>`,
    'utf8',
  )
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
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

/**
 * Response types the proxy re-compresses on the way out.
 *
 * The Host answers with a compressed body and the Fetch layer decodes it before this process can
 * write a single byte, so without this step every byte of the GUI — the client bundles are ~19 MB of
 * JavaScript on a machine with third-party plugins — crosses the loopback socket expanded. Text and
 * script are the types that compress; an image or a video is already compressed and re-encoding it
 * would cost CPU per request and gain nothing.
 */
/** Path the desktop host serves one logical event stream on. */
const STREAM_PATH = '/.dsh/remote-stream'

const COMPRESSIBLE_TYPE = /^(?:text\/(?!event-stream)|application\/(?:javascript|json|xml|x-typescript)|image\/svg\+xml)/iu

/** Hashed Vite assets never change under the same name, so a browser may keep them for a year. */
const ASSET_CACHE = 'public, max-age=31536000, immutable'

/** Path prefix of the built GUI's content-addressed assets. */
const ASSET_PREFIX = '/assets/'

/**
 * Report whether the client asked for gzip.
 * @param message - the request whose response is about to be written.
 * @returns whether `gzip` is acceptable, treating an explicit `q=0` as a refusal.
 */
function acceptsGzip(message: ServerResponse): boolean {
  const header = message.req?.headers['accept-encoding']
  if (typeof header !== 'string') return false
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';')
    if (name !== 'gzip' && name !== '*') continue
    const refused = parameters.some(parameter => /^q\s*=\s*0(?:\.0+)?$/u.test(parameter.trim()))
    if (!refused) return true
  }
  return false
}

/**
 * Write one Host response to the browser, compressing what compresses.
 *
 * Everything the GUI loads travels this path, so this is the only place a Harness-CN launch can win
 * back the expansion the Fetch layer applied: the first paint of the conversation waits on these
 * bytes, and they are the same bytes on every launch.
 * @param message - the response to write.
 * @param response - the Host's answer, already decoded by the Fetch layer.
 */
/**
 * Requests that have not finished yet, by path.
 *
 * Kept because the browser shares one connection pool per origin: six long-lived streams on this
 * origin leave no slot for a seventh request, which is how an auxiliary window ends up blank while
 * every route still answers a fresh client. This map is what makes that state visible.
 */
/**
 * Event streams still open per client, oldest first.
 *
 * The app opens one stream per connection generation and does not close the previous one, so a
 * launch that retried five times leaves five open. This origin only allows six concurrent requests
 * from one browser, so those leftovers are what leaves a window with nothing to load. Keeping the
 * newest few and ending the rest bounds the damage without disturbing the generation in use.
 */
/** Event streams kept open per client; enough for overlapping generations, few enough to leave room. */
const openRequests = new Map<string, number>()

/** Register one in-flight request and arrange to unregister it. */
function trackRequest(message: ServerResponse, path: string): void {
  openRequests.set(path, (openRequests.get(path) ?? 0) + 1)
  const done = (): void => {
    const current = (openRequests.get(path) ?? 1) - 1
    if (current <= 0) openRequests.delete(path)
    else openRequests.set(path, current)
  }
  message.once('close', done)
}

async function writeResponse(message: ServerResponse, response: Response): Promise<void> {
  const headers: [string, string][] = []
  let hasEncoding = false
  for (const [name, value] of response.headers) {
    // `content-encoding` and `content-length` describe the bytes the Host sent, not the bytes the
    // Fetch layer hands back: it decodes a compressed body before this code ever sees it, so
    // forwarding either header would describe the body wrongly.
    if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'content-encoding') {
      if (name === 'content-encoding') hasEncoding = true
      continue
    }
    headers.push([name, value])
  }
  for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie])
  const compress = !hasEncoding
    && response.body !== null
    && message.req?.method !== 'HEAD'
    && COMPRESSIBLE_TYPE.test(response.headers.get('content-type') ?? '')
    && response.headers.get('content-range') === null
    && acceptsGzip(message)
  if (compress) {
    headers.push(['content-encoding', 'gzip'], ['vary', 'accept-encoding'])
  }
  if (response.status === 200 && (message.req?.url ?? '').startsWith(ASSET_PREFIX)) {
    headers.push(['cache-control', ASSET_CACHE])
  }
  message.writeHead(response.status, Object.fromEntries(headers))
  if (response.body === null) {
    message.end()
    return
  }
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  if (!compress) {
    await pipeline(body, message)
    return
  }
  // Level 4 rather than the default 6: the payload is fetched once per launch and decompresses at
  // roughly the same speed either way, so the cheaper encode buys more than the smaller file.
  await pipeline(body, createGzip({ level: 4 }), message)
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

async function serveShellAsset(message: ServerResponse, resourceDir: string, pathname: string, remote: boolean): Promise<void> {
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
    const raw = await readFile(target)
    const inject = remote && extname(target) === '.html'
    const text = inject ? raw.toString('utf8') : ''
    const body = inject && text.includes('</body>')
      ? Buffer.from(text.slice(0, text.indexOf('</body>')) + MOBILE_BACK_TAGS + text.slice(text.indexOf('</body>')), 'utf8')
      : raw
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
 * Start the shell's HTTP surface.
 *
 * The listener binds `0.0.0.0` on an ephemeral port, because the WebView has to reach it on
 * loopback while a phone can only reach it on the LAN address. Which of those two a request
 * belongs to is decided per request, never by the bind address: a LAN visitor is answered only
 * when the user turned the LAN door on and the phone presents the secret behind the link, and the
 * shell's own control surface answers loopback only. Every control call additionally has to
 * present the per-launch cookie handed out with the first response, so a page in the user's own
 * browser cannot drive the shell's package and update operations, and a Host header that names
 * neither this listener nor a served LAN address is refused outright so a rebound name cannot
 * reach it either.
 * @param options - static root, control surface, and the LAN door.
 * @returns the running server with its bound port and event fan-out.
 */
export async function startShellServer(options: ShellServerOptions): Promise<ShellServer> {
  const token = randomBytes(32).toString('hex')
  const clients = new Set<ServerResponse>()
  /** Requests still being answered, with the signal that ends each one. */
  const inFlight = new Set<AbortController>()
  let port = 0
  let shellPort = 0

  const publish = (name: string, value: unknown): void => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`
    for (const client of clients) client.write(frame)
  }

  /** Whether this launch already answered one page's `reload` request. */
  let deferredReloadServed = false

  /** How many superseded event streams this launch closed. */
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
    if (route === 'deferred' && method === 'GET') {
      // `reload` is handed out once per launch: the page asks again after reloading, and a second
      // true would reload it again for as long as the window stays open.
      const ready = options.deferredReady?.() === true
      const reload = ready && !deferredReloadServed
      if (reload) deferredReloadServed = true
      return sendJson(response, 200, { ready, reload })
    }
    if (route === 'streams' && method === 'GET') {
      // Which requests are still open. Six of them on this origin leave no slot for a seventh, and a
      // page that cannot get a slot shows nothing at all, so this is the first thing to read when a
      // window comes up blank while every route answers a fresh client.
      const rows = [...openRequests.entries()].sort((left, right) => right[1] - left[1])
      return sendJson(response, 200, {
        total: rows.reduce((sum, row) => sum + row[1], 0),
        requests: Object.fromEntries(rows),
      })
    }
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
    if (route === 'feedback' && method === 'POST') {
      const body = await readJsonBody(message)
      await options.api.sendFeedback({
        message: requireString(body.message, 'feedback message'),
        email: requireString(body.email, 'reply address'),
      })
      return sendJson(response, 200, { sent: true })
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
    if (route === 'restart' && method === 'POST') {
      // The answer goes out before the process is replaced: the replacement takes this listener
      // with it, so a page that waited for the reply would wait for a socket that cannot answer.
      sendJson(response, 200, { restarting: true })
      setImmediate(() => { options.api.restart() })
      return
    }
    if (route === 'lan' && method === 'GET') return sendJson(response, 200, options.lan.status(port))
    if (route === 'lan/qr' && method === 'GET') {
      // The QR is drawn here rather than in the page so the shell pages stay dependency-free: the
      // encoder is a build-time dependency of this process, and the page receives finished SVG.
      // It is served as the image itself — the page's `<img>` cannot read a JSON wrapper.
      const link = options.lan.status(port).link
      if (link === null) return sendJson(response, 409, { error: 'dsh shell: LAN access is off' })
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      const body = Buffer.from(svg, 'utf8')
      response.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      })
      response.end(body)
      return
    }
    if (route === 'lan/enable' && method === 'POST') return sendJson(response, 200, options.lan.enable(port))
    if (route === 'lan/disable' && method === 'POST') return sendJson(response, 200, options.lan.disable(port))
    if (route === 'lan/rotate' && method === 'POST') return sendJson(response, 200, options.lan.rotate(port))
    return sendJson(response, 404, { error: 'dsh shell: unknown control route' })
  }

  const handle = (message: IncomingMessage, response: ServerResponse, shellOnly: boolean): void => {
    void (async () => {
      const url = new URL(message.url ?? '/', `http://127.0.0.1:${String(port)}`)
      // Every request on this origin shares one browser connection pool, so a request that never
      // finishes keeps a slot from every other page on the same origin. Counted here, where all
      // three kinds of request (page, control, Host proxy) pass through.
      trackRequest(response, url.pathname)
      if (shellOnly && !url.pathname.startsWith(SHELL_API_PREFIX) && !url.pathname.startsWith(SHELL_ASSET_PREFIX)) {
        sendJson(response, 404, { error: 'dsh shell: this origin serves the shell windows only' })
        return
      }
      const remote = !isLoopbackPeer(message.socket.remoteAddress)
      const lanOpen = options.lan.enabled
      if (!hostAllowed(message, shellOnly ? [shellPort] : [port, shellPort])) {
        sendJson(response, 403, { error: 'dsh shell: unexpected Host header' })
        return
      }
      if (remote) {
        if (url.pathname === LAN_UNLOCK_PATH) {
          if (!options.lan.verifyKey(url.searchParams.get('key'))) {
            sendLanNotice(response, lanOpen ? 'locked' : 'off')
            return
          }
          response.writeHead(302, {
            'set-cookie': options.lan.cookieHeader(),
            location: '/',
            'cache-control': 'no-store',
          })
          response.end()
          return
        }
        if (!lanOpen) {
          sendLanNotice(response, 'off')
          return
        }
        if (!options.lan.verify(lanCookie(message))) {
          sendLanNotice(response, 'locked')
          return
        }
        // A paired phone gets the handful of operations its own menu offers. Everything else stays
        // local: an update install, an API key, a log reveal and a quit are not a phone's business,
        // and the pairing cookie is the room key for a GUI, not for the machine.
        if (url.pathname.startsWith(SHELL_API_PREFIX)
          && !lanControlRoute(url.pathname.slice(SHELL_API_PREFIX.length))) {
          sendJson(response, 403, { error: 'dsh shell: that operation answers this computer only' })
          return
        }
      }
      const cookie = shellCookie(message)
      if (!remote && cookie === undefined) {
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
          // A phone that passed the LAN gate is authorized by its pairing cookie, not by the shell
          // session token — that token never leaves this computer.
          if (!remote && !sameToken(token, cookie)) {
            sendJson(response, 403, { error: 'dsh shell: control surface requires the shell session cookie' })
            return
          }
          await handleControl(message, response, url.pathname.slice(SHELL_API_PREFIX.length))
          return
        }
        if (url.pathname.startsWith(SHELL_ASSET_PREFIX)) {
          // Only page loads are recorded: they are the entry points a window is opened for, and one
          // line per page beats one line per stylesheet in a ring that a reader scrolls.
          if (url.pathname.endsWith('.html')) options.note?.(`window page requested: ${url.pathname}`)
          await serveShellAsset(response, options.resourceDir, url.pathname, remote)
          return
        }
        if (url.pathname === '/.dsh/remote-stream') {
          // Which client opens each event stream. The workspace opens several and the browser only
          // allows six requests per origin, so knowing who opened them is what decides whether any
          // of them can be removed.
          options.note?.(
            `event stream: referer=${String(message.headers.referer ?? '-')}`
            + ` dest=${String(message.headers['sec-fetch-dest'] ?? '-')}`
            + ` accept=${String(message.headers.accept ?? '-').slice(0, 40)}`
            + ` client=${String(message.socket.remoteAddress ?? '-')}:${String(message.socket.remotePort ?? '-')}`
            + ` headers=${JSON.stringify(Object.fromEntries(Object.entries(message.headers)
              .filter(([name]) => !['host', 'connection', 'cookie', 'user-agent', 'referer', 'accept'].includes(name))))}`,
          )
        }
        const forwarded = toHostRequest(message, port)
        abort.signal.addEventListener('abort', () => { forwarded.signal.throwIfAborted() }, { once: true })
        const upstream = await options.api.fetchHost(forwarded)
        // The watcher is injected only while this launch is still mounting deferred plugins: a page
        // rendered after they are up already carries their panels, so it needs neither the pill nor
        // a reload. A phone also gets the menu.
        const deferredPending = options.deferredReady?.() !== true
        const tags = PRESENTATION_TAGS + (remote ? MOBILE_MENU_TAGS : '') + (deferredPending ? DEFERRED_WATCHER_TAGS : '')
        await writeResponse(response, tags === '' ? upstream : await withShellTags(upstream, tags))
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
  }

  /** The workspace origin: the app page, its assets, and every Host request. */
  /**
   * Build the workspace listener, bound to `preferredPort` when one is given.
   *
   * A phone's link carries this port, so a port that changes on every launch makes yesterday's link
   * unreachable — which is what "scanned it a few times and now it cannot connect" was. A fresh
   * server is built per attempt because a listener that failed to bind is not reusable.
   * @param preferredPort - port to bind, or 0 for an ephemeral one.
   * @returns the listening server.
   */
  const bindWorkspace = async (preferredPort: number): Promise<Server> => {
    const candidate: Server = createServer((message, response) => { handle(message, response, false) })
    candidate.keepAliveTimeout = 65_000
    candidate.requestTimeout = 0
    candidate.headersTimeout = 65_000
    await new Promise<void>((settle, reject) => {
      const onError = (error: Error): void => { candidate.off('error', onError); reject(error) }
      candidate.once('error', onError)
      candidate.listen(preferredPort, '0.0.0.0', () => { candidate.off('error', onError); settle() })
    })
    return candidate
  }

  /** Port a phone's link should keep across launches; 0 keeps the old random behaviour. */
  const preferredLanPort = options.lan.enabled ? Number(process.env.HARNESS_CN_LAN_PORT ?? '17890') : 0
  let server: Server
  try {
    server = await bindWorkspace(preferredLanPort)
  } catch (error) {
    options.note?.(`LAN port ${String(preferredLanPort)} is busy (${errorOf(error, 'bind failed').message}); the phone link will use a random port`)
    server = await bindWorkspace(0)
  }
  /**
   * The shell origin: /shell/* and /shell-api/* only, loopback only.
   *
   * Separate on purpose. A browser allows six concurrent requests per origin, and the workspace
   * holds five event streams plus a plugin long-poll, so a shell page on the same origin as the
   * app could never get a connection and rendered as a blank window. This listener gives the
   * shell's own windows a pool of their own.
   */
  const shellServer: Server = createServer((message, response) => { handle(message, response, true) })
  // Many logical event streams, one browser connection: the socket does not count against the six
  // requests an origin is allowed, which is what stopped the workspace from starving its own pages.
  attachStreamMux(server, async (endpoint, payload, signal) => {
    const response = await options.api.fetchHost(new Request(`http://127.0.0.1:${String(port)}${STREAM_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
      signal,
    }))
    if (!response.ok || response.body === null) throw new Error('stream upstream failed: HTTP ' + String(response.status))
    return response.body
  })
  for (const listener of [shellServer]) {
    listener.keepAliveTimeout = 65_000
    // A long-lived event stream must not be closed by the default request timeout.
    listener.requestTimeout = 0
    listener.headersTimeout = 65_000
  }

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('dsh shell: loopback listener has no port')
  port = address.port

  // Loopback only: the shell's windows belong to this computer, and a phone never needs them.
  await new Promise<void>((settle, reject) => {
    shellServer.once('error', reject)
    shellServer.listen(0, '127.0.0.1', () => { settle() })
  })
  const shellAddress = shellServer.address()
  if (shellAddress === null || typeof shellAddress === 'string') throw new Error('dsh shell: shell listener has no port')
  shellPort = shellAddress.port

  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    shellPort,
    shellOrigin: `http://127.0.0.1:${String(shellPort)}`,
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
      const closed = new Promise<void>((settle) => {
        let remaining = 2
        const done = (): void => { remaining -= 1; if (remaining === 0) settle() }
        server.close(done)
        shellServer.close(done)
      })
      for (const listener of [shellServer]) {
        listener.closeIdleConnections()
        listener.closeAllConnections()
      }
      await closed
    },
  }
}
