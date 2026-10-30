/**
 * Electron child-process entry: boots the desktop project without a listening
 * socket and carries API plus validated Web assets over framed byte pipes.
 * @module @deepseek-ai/dsh-desktop-host
 */

import { createRequire } from 'node:module'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  loadLayeredEnv,
  loadProfileDirectory,
  loadOverlayPatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { headersForAuthority, unclaimedRequestOwner } from './request-routing.ts'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostRequestDecoder,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
  type DesktopHostRequestFrame,
} from './wire.ts'

export { DESKTOP_HOST_PROTOCOL_VERSION } from './wire.ts'

/** One request forwarded from Electron's `dsh-app://` handler. */
export interface DesktopHostFetchCommand {
  readonly streamId: number
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers: readonly [string, string][]
  }
}

/** Commands accepted by the desktop child process. */
export type DesktopHostCommand = {
  readonly type: 'shutdown'
}

/** Events emitted by the desktop child process. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
  /**
   * Absolute URL carrying this process's launch token for the root path.
   *
   * A carrier that serves the page itself (the Tauri shell) has to hand the browser one chance to
   * exchange the token for the signed cookie every later request is authenticated by. Without it the
   * page renders but every connection stays unauthenticated, which is what "Loading plugins…" means.
   */
  readonly launchUrl: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** Controller returned to tests and the self-executing process entry. */
export interface DesktopHostController {
  /** Installed dsh version carried by this host. */
  readonly dshVersion: string
  /** Dispatch one custom-protocol request and stream its response to the response pipe. */
  fetch(command: DesktopHostFetchCommand, body: ReadableStream<Uint8Array> | null): Promise<void>
  /** Abort one in-flight request. */
  cancel(streamId: number): void
  /** Absolute URL carrying this launch's token for the root path. */
  readonly launchUrl: string
  /** Mount the profile bundles this boot deferred, in order, reporting each one. */
  mountDeferred(): Promise<void>
  /** Stop accepting messages and await complete host teardown. */
  dispose(): Promise<void>
}

/**
 * Bundles whose Host half is mounted after the handshake instead of before it.
 *
 * Each one spends seconds inside `apply()` doing work no other plugin waits on: StudyMate starts a
 * Node child and waits for it, WeChat opens a network login. Mounting them first held the window on
 * the splash screen for the length of that work; the conversation now paints as soon as the core
 * composition is up and these arrive behind it. `DSH_DESKTOP_DEFERRED` adds more, so a machine can
 * defer a plugin this build does not know about.
 */
const DEFERRED_BUNDLES: readonly string[] = [
  // Empty by default. Mounting a loader entry after `ready` extends the client module graph while
  // the page's connection generation is already negotiating, and that generation then never becomes
  // ready: the window reconnects forever instead of showing sessions. Until the client can be told to
  // re-bootstrap against an extended graph, deferral stays opt-in per machine.
  ...(process.env.DSH_DESKTOP_DEFERRED ?? '').split(',').map(name => name.trim()).filter(name => name !== ''),
]

/** One composed entry row, as `composeEntries` produces them. */
type ComposedEntry = ReturnType<typeof composeEntries>[number]

/**
 * Line the Host prints when every deferred bundle has finished mounting.
 *
 * It crosses the process boundary as ordinary stdout, which the shell already mirrors into its run
 * log, so the shell needs no protocol change to learn that the deferred panels exist.
 */
export const DEFERRED_READY_MARKER = '[dsh desktop] deferred plugins ready'

/** One deferred bundle's patch rows, kept together so it mounts as one unit. */
interface DeferredBundle {
  readonly packageName: string
  readonly rows: ComposedEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDesktopHostCommand(message: unknown): message is DesktopHostCommand {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as Record<string, unknown>).type === 'shutdown'
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))
const ROOT_CONFIG = '# Electron desktop composition root; package transactions own this file.\n[]\n'
const ROOT_CONFIG_FILENAME = 'desktop.cordis.yml'
const DESKTOP_STREAM_PATH = '/.dsh/remote-stream'
/** Path the shell's multiplexer answers on; one socket carries every stream the page opens. */
const DESKTOP_MUX_PATH = '/.dsh/stream-mux'

const DESKTOP_TRANSPORT_SCRIPT = `globalThis.__DSH_TRANSPORT__=(function(){
var MUX=${JSON.stringify(DESKTOP_MUX_PATH)},STREAM=${JSON.stringify(DESKTOP_STREAM_PATH)}
var socket=null,nextId=0,muxBroken=false,pending={}
function wake(entry){if(entry.notify){var notify=entry.notify;entry.notify=null;notify()}}
function connect(){
  if(socket!==null&&socket.readyState<=1)return socket
  if(muxBroken)return null
  var url=(location.protocol==='https:'?'wss://':'ws://')+location.host+MUX
  var ws
  try{ws=new WebSocket(url)}catch(error){muxBroken=true;return null}
  ws.onmessage=function(event){
    var message
    try{message=JSON.parse(event.data)}catch(error){return}
    var entry=pending[message.id]
    if(entry===undefined)return
    if(message.t==='frame')entry.queue.push(message.value)
    else if(message.t==='end')entry.done=true
    else if(message.t==='error')entry.error=new Error(message.message)
    wake(entry)
  }
  ws.onclose=function(){
    if(socket===ws)socket=null
    for(var key in pending){
      var entry=pending[key]
      if(!entry.done&&entry.error===null)entry.error=new Error('stream mux closed')
      wake(entry)
    }
  }
  // An error is followed by close; banning the mux here made every later stream fall back.
  ws.onerror=function(){}
  socket=ws
  return ws
}
async function* fallback(endpoint,payload,signal){
  var response=await fetch(STREAM,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:endpoint,payload:payload}),signal:signal
  })
  if(!response.ok||response.body===null)throw new Error('desktop stream transport failed: HTTP '+response.status)
  var reader=response.body.getReader(),decoder=new TextDecoder(),pendingLine=''
  for(;;){
    var read=await reader.read()
    pendingLine+=decoder.decode(read.value,{stream:!read.done})
    var newline
    while((newline=pendingLine.indexOf('\\n'))!==-1){
      var line=pendingLine.slice(0,newline);pendingLine=pendingLine.slice(newline+1)
      if(line!=='')yield JSON.parse(line)
    }
    if(read.done)break
  }
  if(pendingLine!=='')yield JSON.parse(pendingLine)
}
async function* openStream(endpoint,payload,signal){
  var ws=connect()
  if(ws!==null&&ws.readyState===0){
    try{
      await new Promise(function(resolve,reject){
        var timer=setTimeout(function(){reject(new Error('stream mux open timeout'))},1500)
        ws.addEventListener('open',function(){clearTimeout(timer);resolve()},{once:true})
        ws.addEventListener('error',function(){clearTimeout(timer);reject(new Error('stream mux error'))},{once:true})
      })
    }catch(error){if(socket===ws)socket=null;ws=null}
  }
  if(ws===null||ws.readyState!==1){
    yield* fallback(endpoint,payload,signal)
    return
  }
  var id=++nextId
  var entry={queue:[],done:false,error:null,notify:null}
  pending[id]=entry
  var send=function(message){if(ws.readyState===1)ws.send(JSON.stringify(message))}
  var onAbort=function(){send({t:'cancel',id:id})}
  if(signal)signal.addEventListener('abort',onAbort,{once:true})
  send({t:'open',id:id,endpoint:endpoint,payload:payload})
  try{
    for(;;){
      if(entry.queue.length>0){yield entry.queue.shift();continue}
      if(entry.error!==null)throw entry.error
      if(entry.done)return
      await new Promise(function(resolve){entry.notify=resolve})
    }
  }finally{
    delete pending[id]
    if(signal)signal.removeEventListener('abort',onAbort)
    send({t:'cancel',id:id})
  }
}
return {ownsHost:true,openStream:openStream,streamBaseUrl:location.origin}
})()
;(function(){
  try{
    if((location.search||"").indexOf("panel=qq-console")===-1)return;
    // 这个窗口只承载控制台：隐藏应用本体，让面板铺满整个窗口。
    var chrome = document.createElement('style');
    chrome.id="qq-console-chrome";
    chrome.textContent="body>*:not(#qqs-dock-panel){display:none!important}"
      +"#qqs-dock-panel{position:fixed!important;inset:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;margin:0!important;border-radius:0!important}";
    document.head.appendChild(chrome);
    var tries=0;
    var timer=setInterval(function(){
      if(typeof window.__qqbotOpenConsole==="function"){clearInterval(timer);window.__qqbotOpenConsole()}
      else if(++tries>120){clearInterval(timer)}
    },250);
  }catch(error){}
})()`

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`dsh desktop: ${path} must contain a package manifest`)
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
  }
}

function packageManifestPath(projectDir: string, packageName: string): string {
  const path = join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) throw new Error(`dsh desktop: installed package ${JSON.stringify(packageName)} has no manifest`)
  return path
}

function isProjectPath(projectDir: string, target: string): boolean {
  const root = realpathSync(projectDir)
  const path = realpathSync(target)
  return path === root || path.startsWith(root + sep)
}

/**
 * Read the bundle packages the installed profile was composed from.
 * @param projectDir - installed desktop profile holding `package.json`.
 * @returns the recorded bundle names, or an empty list when the manifest is unreadable.
 */
function profileBundles(projectDir: string): readonly string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: readonly string[] } }
    }
    return manifest.dsh?.profile?.bundles ?? []
  } catch (error) {
    // An unreadable manifest cannot describe its bundles; the launcher still boots
    // because every other input is already resolved from the files it did read.
    if (error instanceof Error) return []
    throw error
  }
}

/**
 * Compose the profile's patches, split into what boots and what mounts after the handshake.
 * @param projectDir - installed desktop profile.
 * @param allowLinkedPackages - whether a bundle may resolve outside the profile.
 * @returns the patches this boot applies, plus one group per deferred bundle.
 */
function desktopPatches(projectDir: string, allowLinkedPackages: boolean): {
  core: PatchOptions[]
  deferred: DeferredBundle[]
} {
  const dshRoot = dirname(packageManifestPath(projectDir, '@deepseek-ai/dsh'))
  const profile = loadProfileDirectory('dsh desktop', projectDir, join(dshRoot, 'package.json'))
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir)) {
      throw new Error(`dsh desktop: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the desktop profile`)
    }
  }
  const deferredNames = new Set(DEFERRED_BUNDLES)
  const deferred: DeferredBundle[] = []
  const layers: PatchOptions[][] = []
  for (const layer of profile.layers) {
    if (!deferredNames.has(layer.packageName)) {
      layers.push(layer.patches)
      continue
    }
    // The rows are composed here, before the Loader exists, so a bundle whose patch file is
    // malformed still fails the launch instead of failing after the user is already typing.
    deferred.push({ packageName: layer.packageName, rows: composeEntries([layer.patches]) })
  }
  layers.push(profile.patches, loadOverlayPatches('dsh desktop', DESKTOP_PATCH))
  const rows = new Map(composeEntries(layers).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const agentPresets = rows.get('agent-presets')
  if (agentPresets !== undefined) {
    layers.push([{
      id: 'agent-presets',
      config: {
        ...(agentPresets.config ?? {}) as Record<string, unknown>,
        roots: [{ path: join(dshRoot, 'config', 'agent-presets'), trust: 'system' }],
      },
    }])
  }
  return { core: layers.flat(), deferred }
}

function dshVersion(projectDir: string): string {
  const manifest = readManifest(packageManifestPath(projectDir, '@deepseek-ai/dsh'))
  if (typeof manifest.version !== 'string') throw new Error('dsh desktop: installed dsh manifest has no version')
  return manifest.version
}

function assetHandler(ctx: Context, projectDir: string): ConnectionFetchHandler {
  const require = createRequire(join(projectDir, 'package.json'))
  const distIndex = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  const distRoot = realpathSync(dirname(distIndex))
  const renderIndex = async (): Promise<Response> => {
    const rows: IndexInjection[] = [{ kind: 'script', placement: 'head', text: DESKTOP_TRANSPORT_SCRIPT }]
    ctx.emit('webserver/index-inject', rows)
    const body = renderIndexInjections(await readFile(distIndex, 'utf8'), rows)
    return new Response(body, { headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' } })
  }
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const url = new URL(request.url)
      if (url.pathname.startsWith('/plugins/')) return ctx.clientModules.fetchBundle(request)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (pathname === '/' || pathname === '/index.html') return renderIndex()
      const target = resolve(normalize(join(distRoot, pathname)))
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
      try {
        const realTarget = realpathSync(target)
        if (realTarget !== distRoot && !realTarget.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
        return new Response(request.method === 'HEAD' ? null : await readFile(realTarget), {
          headers: { 'content-type': MIME[extname(realTarget)] ?? 'application/octet-stream' },
        })
      } catch {
        return renderIndex()
      }
    },
  }
}

function remoteStreamHandler(ctx: Context): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request): Promise<Response> {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const gateway = ctx.get('typertGateway')
      if (gateway === undefined) return new Response('gateway unavailable', { status: 503 })
      const connection = ctx.get('connection')
      if (connection === undefined) return new Response('connection unavailable', { status: 503 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (!isRecord(body) || typeof body.endpoint !== 'string') {
        return new Response('invalid stream request', { status: 400 })
      }
      // The shell already admitted this request: it owns the LAN gate, the loopback listener and the
      // page's multiplexer, and it reaches this handler in-process. Asking BrowserAuth for a browser
      // cookie again would demand a launch-token round trip no native shell can complete, so the lane
      // runs as the owner Peer exactly like the shared `/api` route does.
      const peer = connection.browserPeer
      const abort = new AbortController()
      const cancel = (): void => { abort.abort(request.signal.reason) }
      request.signal.addEventListener('abort', cancel, { once: true })
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            // The shell posts one logical stream at a time and never sends uplink items, so an
            // exhausted iterator is the whole Client-to-Host lane.
            const values = await gateway.wireStream.open(
              body.endpoint as string,
              body.payload,
              (async function* empty() {})(),
              peer,
              abort.signal,
            )
            for await (const value of values) {
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            request.signal.removeEventListener('abort', cancel)
          }
        },
        cancel(reason) {
          abort.abort(reason)
          request.signal.removeEventListener('abort', cancel)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  }
}

interface NodeRequestInit extends RequestInit {
  readonly duplex?: 'half'
}

/**
 * Boot one installed desktop npm project.
 * @param projectDir - active or staged Electron-owned desktop profile.
 * @param writeResponse - serialized response-pipe writer that applies byte backpressure.
 * @param options - development-only allowance for workspace-linked bundle packages.
 * @returns controller after every Host and client-manifest row is active.
 */
export async function runDesktopHost(
  projectDir: string,
  writeResponse: (frame: Buffer) => Promise<void>,
  options: { allowLinkedPackages?: boolean } = {},
): Promise<DesktopHostController> {
  const absoluteProject = resolve(projectDir)
  mkdirSync(absoluteProject, { recursive: true })
  const rootConfig = join(absoluteProject, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)
  const environment = loadLayeredEnv('dsh desktop')
  let current: Context | undefined
  const plan = desktopPatches(absoluteProject, options.allowLinkedPackages === true)
  const ctx = await boot('dsh desktop', rootConfig, structuredClone(plan.core), (hostCtx) => {
    current = hostCtx
    // The profile launcher owns profile identity: settings and config-editor stay
    // pending until this presence is published, and every plugin that injects
    // `settings` (mail, QQ, editor connectors) waits on them in turn.
    hostCtx.provide('profileContext', {
      name: 'desktop',
      dir: absoluteProject,
      patchPath: join(absoluteProject, 'cordis.patch.yml'),
      installAnchor: absoluteProject,
      startedBundles: profileBundles(absoluteProject),
      cwd: process.cwd(),
      home: process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? absoluteProject, '.dsh'),
      overlays: [],
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    } satisfies ProfileContext)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, { args: [], exit: () => {} })
  })
  current = ctx
  const connection = ctx.get('connection')
  const clientModules = ctx.get('clientModules')
  const gateway = ctx.get('typertGateway')
  if (connection === undefined || clientModules === undefined || gateway === undefined) {
    await ctx.fiber.dispose()
    throw new Error('dsh desktop: composition did not provide connection, typertGateway, and clientModules')
  }
  const webServer = ctx.get('webServer')
  const assets = assetHandler(ctx, absoluteProject)
  const streams = remoteStreamHandler(ctx)
  const requests = new Map<number, AbortController>()
  let disposing: Promise<void> | undefined

  /**
   * Offer one request to the composed webserver, the only owner of the routes plugin host
   * halves register with `ctx.inject(['webServer'])`.
   *
   * This carrier claims `/.dsh/remote-stream` and `/api` itself and hands everything else here,
   * body included: a panel's JSON write is a POST to a route the webserver owns, and dropping it
   * into the asset handler is what turned every such write into a method error. Assets are
   * read-only, so only a read the webserver did not claim is offered to them afterwards.
   *
   * `/plugins` used to be claimed here as well, on the reading that every such path is a client
   * bundle. That is only true of `鈥?client.js`: a plugin's Host half registers its own routes
   * under the same prefix (`/plugins/<package>/status` is one), so claiming the whole prefix
   * answered those routes with the bundle table's 404 鈥?the account panel that polls its status
   * showed "璇锋眰澶辫触 / HTTP 404" while the plugin itself was running fine.
   * @param request - request no in-process handler claimed.
   * @returns the plugin route's response, or the shell's own asset response.
   */
  // The browser's `/connect` handshake mints an API cookie scoped to this listener's own authority,
  // and the shell serves the page from a different one, so the cookie cannot travel with the page's
  // own requests. Mint it once here instead and attach it to the webserver leg, which is the only
  // leg that checks it: `/api` is answered locally by the shared connection handler.
  let apiCookie: Promise<string | undefined> | undefined
  const webserverCookie = (): Promise<string | undefined> => {
    apiCookie ??= (async (): Promise<string | undefined> => {
      const port = webServer?.port
      if (port === undefined) return undefined
      const token = new URL(connection.authenticatedUrl('http://127.0.0.1/'), 'http://127.0.0.1').searchParams.get('token')
      if (token === null) return undefined
      try {
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/connect?token=${encodeURIComponent(token)}&interactions=none`,
          { redirect: 'manual' },
        )
        const cookies = response.headers.getSetCookie()
          .map((one) => one.split(';')[0] ?? '')
          .filter((one) => one !== '')
        return cookies.length === 0 ? undefined : cookies.join('; ')
      } catch {
        return undefined
      }
    })()
    return apiCookie
  }

  const pluginRoutes = async (request: Request): Promise<Response> => {
    const port = webServer?.port
    if (unclaimedRequestOwner({ method: request.method, port }) === 'assets') {
      return assets.fetch(request, connection.browserPeer)
    }
    const url = new URL(request.url)
    const forwarded = headersForAuthority(request.headers, `http://127.0.0.1:${String(port)}`)
    const cookie = await webserverCookie()
    if (cookie !== undefined) forwarded.set('cookie', cookie)
    const init: NodeRequestInit = {
      method: request.method,
      headers: forwarded,
      signal: request.signal,
      // A request body is a stream that can be read once, so it is forwarded rather than
      // rebuilt; `duplex: 'half'` is what Node requires to send a streaming body.
      ...(request.body === null ? {} : { body: request.body, duplex: 'half' }),
    }
    // Redirects belong to the browser, not to this carrier: `/connect` answers 302 with the API
    // cookie in `Set-Cookie`, and following it here would spend that redirect in a fetch that
    // keeps no cookies, turning the handshake into a 401 from the `/api` route.
    const routed = await fetch(new Request(
      new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${String(port)}`),
      { ...init, redirect: 'manual' },
    ))
    // An API route answers its own 404: falling through to the asset handler would hand a client
    // fetch (or an SSE stream) the index page, which is how every unclaimed /api call turned into
    // 'response has a MIME type text/html' instead of the 404 that names the missing route.
    if (url.pathname.startsWith('/api/')) return routed
    return unclaimedRequestOwner({ method: request.method, port, status: routed.status }) === 'assets'
      ? await assets.fetch(request, connection.browserPeer)
      : routed
  }

  /**
   * Answer `/api` requests this carrier claims itself.
   *
   * Exact Fetch routes and the shared RPC interceptor answer first. A request neither
   * owns still belongs to the composed webserver, whose longest-prefix dispatch serves
   * plugin Host routes registered under `/api` 鈥?the Mobile access admin API is one. In
   * the browser the webserver already sits in front of this handler; here the carrier is
   * the front door, so the webserver's dispatch has to be supplied as the fallback.
   * @param request - authenticated `/api` request carried from the WebView.
   * @returns the in-process owner's response, the plugin route's, or the asset answer.
   */
  const shared = connection.createSharedFetchHandler('/api')
  const api: ConnectionFetchHandler = {
    requestBodyMode: shared.requestBodyMode,
    fetch: async (request, peer) => {
      const owned = await shared.fetch(request, peer)
      return owned.status === 404 ? await pluginRoutes(request) : owned
    },
  }

  const dispose = async (): Promise<void> => {
    disposing ??= (async () => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      await current?.fiber.dispose()
      current = undefined
    })()
    await disposing
  }

  /**
   * Mount one deferred bundle's rows on the live Loader.
   *
   * The rows are the same ones the bundle's own patch file would have inserted at boot, so a
   * deferred plugin is composed exactly as it would have been 鈥?it only arrives later. A bundle
   * that throws here is reported and skipped: it must not take down a host that is already serving
   * the conversation.
   * @param bundle - composed rows and the package name they came from.
   */
  const mountBundle = async (bundle: DeferredBundle): Promise<void> => {
    const started = Date.now()
    try {
      for (const row of bundle.rows) await ctx.loader.create(row)
      console.log(`[dsh desktop] deferred plugin mounted: ${bundle.packageName} in ${String(Date.now() - started)} ms`)
    } catch (error) {
      console.error(
        `[dsh desktop] deferred plugin failed: ${bundle.packageName}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  let deferredRun: Promise<void> | undefined

  return {
    dshVersion: dshVersion(absoluteProject),
    // The carrier picks the origin: only the token this URL carries is consumed, and the shell that
    // serves the page rewrites it onto its own listener. `authenticatedUrl` insists on an absolute
    // URL, so a placeholder loopback origin stands in.
    launchUrl: connection.authenticatedUrl('http://127.0.0.1/'),

    cancel(streamId) {
      requests.get(streamId)?.abort()
    },
    async mountDeferred() {
      deferredRun ??= (async () => {
        for (const bundle of plan.deferred) await mountBundle(bundle)
        // The shell watches its child's stdout for this marker: it is what tells the window its
        // deferred panels now exist, so the page can reload once and show them.
        console.log(DEFERRED_READY_MARKER)
      })()
      await deferredRun
    },
    async fetch(command, body) {
      if (disposing !== undefined) throw new Error('dsh desktop: host is disposing')
      const controller = new AbortController()
      requests.set(command.streamId, controller)
      try {
        const url = new URL(command.request.url)
        const init: NodeRequestInit = {
          method: command.request.method,
          headers: new Headers(command.request.headers.map(([name, value]) => [name, value] as [string, string])),
          ...(body === null ? {} : { body, duplex: 'half' }),
          signal: controller.signal,
        }
        const request = new Request(url, init)
        const response = url.pathname === DESKTOP_STREAM_PATH
          ? await streams.fetch(request, connection.browserPeer)
          : url.pathname.startsWith('/api/')
            ? await api.fetch(request, connection.browserPeer)
            : await pluginRoutes(request)
        await writeResponse(encodeDesktopResponseStart(command.streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null,
        }))
        if (response.body !== null) {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk)
            for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
              await writeResponse(encodeDesktopResponseData(
                command.streamId,
                bytes.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
              ))
            }
          }
        }
        await writeResponse(encodeDesktopResponseEnd(command.streamId))
      } catch (error) {
        if (!controller.signal.aborted) {
          await writeResponse(encodeDesktopResponseError(
            command.streamId,
            error instanceof Error ? error.message : String(error),
          ))
        }
      } finally {
        requests.delete(command.streamId)
      }
    },
    dispose,
  }
}

async function main(): Promise<void> {
  const projectDir = process.argv[2]
  if (projectDir === undefined || process.send === undefined) {
    throw new Error('dsh desktop: expected project directory, byte pipes, and a Node IPC channel')
  }
  const option = process.argv[3]
  if (option !== undefined && option !== '--allow-linked-profile') {
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(option)}`)
  }
  const requestPipe = createReadStream('', { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false })
  const responsePipe = createWriteStream('', { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false })
  let responseWriteTail: Promise<void> = Promise.resolve()
  const writeResponse = (frame: Buffer): Promise<void> => {
    const write = responseWriteTail.then(async () => {
      if (responsePipe.destroyed) throw new Error('dsh desktop: Electron response pipe is unavailable')
      if (!responsePipe.write(frame)) await once(responsePipe, 'drain')
    })
    responseWriteTail = write.catch(() => undefined)
    return write
  }
  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return
    try {
      process.send(event)
    } catch (error) {
      // A concurrent parent disconnect owns teardown; only that closed-channel
      // condition is safe to discard while streamed responses unwind.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }
  const controller = await runDesktopHost(projectDir, writeResponse, { allowLinkedPackages: option !== undefined })
  send({
    type: 'ready',
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    dshVersion: controller.dshVersion,
    launchUrl: controller.launchUrl,
  })
  // Behind the handshake on purpose: the shell paints the conversation as soon as it hears `ready`,
  // and these bundles are the ones that made it wait.
  void controller.mountDeferred()
  const decoder = new DesktopHostRequestDecoder()
  const requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const blockedRequests = new Set<number>()
  const discardedRequestBodies = new Set<number>()
  const runs = new Set<Promise<void>>()
  let lastStreamId = 0
  let requestedExitCode = 0
  let stopping: Promise<void> | undefined

  const resumeRequestPipe = (): void => {
    if (blockedRequests.size === 0) requestPipe.resume()
  }

  /**
   * Close one inherited pipe descriptor, tolerating one Electron has already released.
   *
   * Electron owns the other end of both pipes. When it closes first, this process's
   * descriptor is already gone and `closeSync` reports EBADF. That is the state shutdown
   * wants, but letting it throw turns an ordinary stop into an uncaught exception inside
   * the stop path, which the Shell records as a Host crash and a reader has to rule out.
   * @param fd - inherited descriptor owned by this process until it is closed.
   */
  const closePipe = (fd: number): void => {
    try {
      closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
    }
  }

  const stop = (exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    stopping ??= (async () => {
      requestPipe.pause()
      requestPipe.removeAllListeners('data')
      const stopped = new Error('dsh desktop: Host is stopping')
      for (const body of requestBodies.values()) body.error(stopped)
      requestBodies.clear()
      blockedRequests.clear()
      discardedRequestBodies.clear()
      requestPipe.destroy()
      closePipe(DESKTOP_REQUEST_PIPE_FD)
      await controller.dispose()
      await Promise.allSettled([...runs])
      await responseWriteTail.catch(() => undefined)
      if (!responsePipe.destroyed) {
        await new Promise<void>((resolvePromise) => { responsePipe.end(resolvePromise) })
        responsePipe.destroy()
      }
      closePipe(DESKTOP_RESPONSE_PIPE_FD)
      if (process.connected) process.disconnect()
      process.exitCode = requestedExitCode
    })()
    return stopping
  }

  const failTransport = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    send({ type: 'fatal', message })
    void stop(1)
  }

  const beginRequest = (frame: Extract<DesktopHostRequestFrame, { type: 'start' }>): void => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`dsh desktop: Electron reused or reordered request stream ${String(frame.streamId)}`)
    }
    lastStreamId = frame.streamId
    let body: ReadableStream<Uint8Array> | null = null
    if (frame.hasBody) {
      body = new ReadableStream<Uint8Array>({
        start(controllerOfBody) {
          requestBodies.set(frame.streamId, controllerOfBody)
        },
        pull() {
          blockedRequests.delete(frame.streamId)
          resumeRequestPipe()
        },
        cancel() {
          requestBodies.delete(frame.streamId)
          blockedRequests.delete(frame.streamId)
          controller.cancel(frame.streamId)
          resumeRequestPipe()
        },
      })
    }
    const run = controller.fetch({
      streamId: frame.streamId,
      request: {
        url: frame.url,
        method: frame.method,
        headers: frame.headers,
      },
    }, body)
    runs.add(run)
    void run.catch(failTransport).finally(() => {
      runs.delete(run)
      const openBody = requestBodies.get(frame.streamId)
      if (openBody === undefined) return
      openBody.error(new Error('dsh desktop: response completed before the request body ended'))
      requestBodies.delete(frame.streamId)
      blockedRequests.delete(frame.streamId)
      discardedRequestBodies.add(frame.streamId)
      resumeRequestPipe()
    })
  }

  const handleRequestFrame = (frame: DesktopHostRequestFrame): void => {
    switch (frame.type) {
      case 'start':
        beginRequest(frame)
        return
      case 'data': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.has(frame.streamId)) return
          throw new Error(`dsh desktop: Electron sent body data for inactive stream ${String(frame.streamId)}`)
        }
        body.enqueue(frame.data)
        if ((body.desiredSize ?? 0) <= 0) {
          blockedRequests.add(frame.streamId)
          requestPipe.pause()
        }
        return
      }
      case 'end': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.delete(frame.streamId)) return
          throw new Error(`dsh desktop: Electron ended inactive body stream ${String(frame.streamId)}`)
        }
        body.close()
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        resumeRequestPipe()
        return
      }
      case 'cancel': {
        if (frame.streamId > lastStreamId) {
          throw new Error(`dsh desktop: Electron canceled unknown stream ${String(frame.streamId)}`)
        }
        const body = requestBodies.get(frame.streamId)
        body?.error(new Error('dsh desktop: Electron canceled the request'))
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        discardedRequestBodies.delete(frame.streamId)
        controller.cancel(frame.streamId)
        resumeRequestPipe()
        return
      }
      default:
        frame satisfies never
    }
  }

  requestPipe.on('data', (chunk: string | Buffer) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame)
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('end', () => {
    if (stopping !== undefined) return
    try {
      decoder.finish()
      failTransport(new Error('dsh desktop: Electron request pipe ended'))
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('error', failTransport)
  responsePipe.once('error', failTransport)
  process.on('message', (message: unknown) => {
    if (!isDesktopHostCommand(message)) {
      send({ type: 'fatal', message: 'dsh desktop: invalid Electron IPC command' })
      void stop(1)
      return
    }
    void stop()
  })
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.send !== undefined) process.send({ type: 'fatal', message } satisfies DesktopHostEvent)
    else process.stderr.write(`dsh desktop: ${message}\n`)
    process.exitCode = 1
  })
}
