/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import {
  DesktopProjectManager,
  type DesktopProjectHooks,
  type DesktopProjectMutation,
} from './project-manager.ts'
import { DesktopHostProcess } from './host-process.ts'
import { DESKTOP_IPC, type DesktopApiKeyStatus, type DesktopStartupState, type DesktopUpdateState } from './ipc.ts'
import { DesktopLogBuffer } from './log-buffer.ts'
import {
  ApiKeyError,
  describeApiKey,
  storeApiKey,
  verifyDeepSeekKey,
  type ApiKeyFailureReason,
} from './credentials-client.ts'
import { formatDesktopMessage, resolveDesktopLocale, type DesktopMessages } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'

const SCHEME = 'dsh-app'
/** Delay before the startup window is revealed, so a launch that never needs it does not flash one. */
const SLOW_START_REVEAL_MS = 1200
let focusPrimaryWindow = (): void => {}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Locale key that reports each refused key-binding step. */
const API_KEY_FAILURE_MESSAGES = {
  unauthorized: 'apiKeyInvalid',
  unreachable: 'apiKeyUnreachable',
  rejected: 'apiKeyRejected',
} as const satisfies Readonly<Record<ApiKeyFailureReason, keyof DesktopMessages>>

/**
 * Name one project mutation for the run log.
 * @param mutation - validated mutation the plugin window requested.
 * @returns stable description naming the affected package.
 */
function describeMutation(mutation: DesktopProjectMutation): string {
  switch (mutation.type) {
    case 'plugin-add':
      return `plugin-add ${mutation.spec}`
    case 'plugin-remove':
      return `plugin-remove ${mutation.name}`
    case 'plugin-update':
      return `plugin-update ${mutation.name}@${mutation.version}`
    default:
      mutation satisfies never
      return 'plugin-operation'
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
}

/** Which menu bar a shell window carries. */
type WindowMenu = 'workspace' | 'none'

interface RuntimeResources {
  readonly node: string
  readonly pnpm: string
  readonly seed: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = (development ? process.env.DSH_DESKTOP_NODE_BINARY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const seed = (development ? process.env.DSH_DESKTOP_SEED_DIR : undefined) ?? join(process.resourcesPath, 'seed')
  return { node, pnpm, seed }
}

function developmentProject(): string | undefined {
  const configured = process.env.DSH_DESKTOP_DEV_PROJECT_DIR
  if (configured === undefined || configured === '') return undefined
  if (app.isPackaged) throw new Error('dsh desktop: development project override is unavailable in packaged applications')
  return resolve(configured)
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, menu: WindowMenu): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: menu === 'none',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  // A management window acts on the workspace, so the workspace menu means nothing inside it.
  // Detaching it here also replaces the default menu Electron installs before the application
  // menu exists, which a window opened during startup would otherwise show.
  if (menu === 'none') window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault()
  })
  return window
}

function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

async function main(): Promise<void> {
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = developmentProject()
  const activeProject = development ?? paths.profile
  const hostInspectPort = developmentHostInspectPort(development !== undefined)
  const manager = new DesktopProjectManager(paths, resources)
  if (development === undefined) manager.recover()
  let host: DesktopHostProcess | undefined
  let mainWindow: BrowserWindow | undefined
  let pluginWindow: BrowserWindow | undefined
  // True until the main window exists. The binding gate destroys its own window before the
  // main window is created, and an empty window list in that gap is not a user quit.
  let startupWindowsPending = true
  let shellInstallerOwnsQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const managementPreload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const logs = new DesktopLogBuffer(join(app.getPath('logs'), 'harness.log'))
  const logShell = (text: string): void => { logs.line('shell', text) }
  let logWindow: BrowserWindow | undefined
  let startupWindow: BrowserWindow | undefined
  let apiKeyWindow: BrowserWindow | undefined
  let releaseApiKeyBinding: (() => void) | undefined
  logShell(`Harness-CN ${app.getVersion()} starting; packaged=${String(app.isPackaged)}; locale=${locale.id}`)
  // The viewers drain one coalesced update per interval rather than one push per line: Host
  // output arrives in bursts, and this keeps IPC off the logging path.
  setInterval(() => {
    const update = logs.drain()
    if (update.entries.length === 0) return
    for (const target of [logWindow, startupWindow]) {
      if (target === undefined || target.isDestroyed()) continue
      target.webContents.send(DESKTOP_IPC.logsState, update)
    }
  }, 150).unref()

  let startupProgress = 0
  /**
   * Record how far the launch has come and show it in the opening window.
   *
   * Fractions only ever advance, so a step that reports late cannot walk the bar backwards.
   * The value is kept while no window is open, which is what lets a window created later show
   * the launch as it stands instead of starting over.
   * @param progress - completed fraction of the launch, from 0 through 1.
   */
  const reportStartupProgress = (progress: number): void => {
    startupProgress = Math.min(1, Math.max(startupProgress, progress))
    const window = startupWindow
    if (window === undefined || window.isDestroyed()) return
    window.webContents.send(DESKTOP_IPC.startupState, { progress: startupProgress } satisfies DesktopStartupState)
  }

  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesState, state)
    }
    return state
  }

  const requireHost = (): DesktopHostProcess => {
    const active = host
    if (active === undefined) throw new Error('dsh desktop: backend is not running')
    return active
  }
  const startHost = async (projectDir = activeProject): Promise<DesktopHostProcess> => {
    logShell(`starting the backend from ${projectDir}`)
    const next = new DesktopHostProcess(resources.node, projectDir, hostInspectPort, logs)
    const ready = await next.start()
    logShell(`backend ready: dsh ${ready.dshVersion}`)
    return next
  }
  const hooks: DesktopProjectHooks = {
    healthCheck: async (projectDir) => {
      const active = host
      host = undefined
      await active?.stop()
      let healthFailure: unknown
      let probe: DesktopHostProcess | undefined
      try {
        probe = await startHost(projectDir)
        await probe.stop()
      } catch (error) {
        healthFailure = error
        await probe?.stop().catch(() => undefined)
      }
      let restartFailure: unknown
      if (active !== undefined) {
        try {
          host = await startHost()
        } catch (error) {
          restartFailure = error
        }
      }
      if (healthFailure !== undefined && restartFailure !== undefined) {
        throw new AggregateError([
          errorOf(healthFailure, 'desktop project: staged health check failed'),
          errorOf(restartFailure, 'desktop project: active backend restart failed'),
        ], 'desktop project: staged health check and active backend restart failed')
      }
      if (healthFailure !== undefined) throw errorOf(healthFailure, 'desktop project: staged health check failed')
      if (restartFailure !== undefined) throw errorOf(restartFailure, 'desktop project: active backend restart failed')
    },
    beforeActivate: async () => {
      logShell('stopping the backend before profile activation')
      const active = host
      host = undefined
      await active?.stop()
    },
    afterActivate: async () => {
      host = await startHost()
      logShell('backend restarted after profile activation')
    },
    note: logShell,
    progress: reportStartupProgress,
  }

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      shellInstallerOwnsQuit = true
      const active = host
      host = undefined
      await active?.stop()
    },
  )

  // Served before the backend exists: the startup window and the management windows are shell
  // assets, and `dsh-app://app` answers 503 until a Host is running.
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellAsset(request)
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  const mutate = async (event: IpcMainInvokeEvent, mutation: DesktopProjectMutation): Promise<void> => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) {
      throw new Error('dsh desktop: plugin package changes require a packaged application')
    }
    logShell(`plugin operation started: ${describeMutation(mutation)}`)
    await manager.mutate(mutation, hooks)
    logShell(`plugin operation finished: ${describeMutation(mutation)}`)
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  }
  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.pluginsList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listPlugins()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsAdd, (event, spec: unknown) => {
    if (typeof spec !== 'string') throw new Error('dsh desktop: plugin spec must be a string')
    return mutate(event, { type: 'plugin-add', spec })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsRemove, (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('dsh desktop: plugin name must be a string')
    return mutate(event, { type: 'plugin-remove', name })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsUpdate, (event, name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error('dsh desktop: plugin name and version must be strings')
    }
    return mutate(event, { type: 'plugin-update', name, version })
  })
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertDesktopSender(event, ['shell'])
    return updates.check()
  })
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    assertDesktopSender(event, ['shell'])
    await updates.install()
  })

  // The renderer shows whatever message it receives, so each refusal is translated here
  // rather than exposing the transport's own wording.
  const runApiKeyStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (error) {
      if (error instanceof ApiKeyError) throw new Error(messages[API_KEY_FAILURE_MESSAGES[error.reason]])
      throw error
    }
  }
  ipcMain.handle(DESKTOP_IPC.logsGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return logs.snapshot()
  })
  ipcMain.handle(DESKTOP_IPC.logsClear, (event) => {
    assertDesktopSender(event, ['shell'])
    logs.clear()
    logShell('run log cleared by the user')
    return logs.snapshot()
  })
  ipcMain.handle(DESKTOP_IPC.logsReveal, (event) => {
    assertDesktopSender(event, ['shell'])
    shell.showItemInFolder(logs.snapshot().file)
  })
  ipcMain.handle(DESKTOP_IPC.apiKeyStatus, async (event) => {
    assertDesktopSender(event, ['shell'])
    return await runApiKeyStep(() => describeApiKey(requireHost()))
  })
  ipcMain.handle(DESKTOP_IPC.apiKeySave, async (event, key: unknown) => {
    assertDesktopSender(event, ['shell'])
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('dsh desktop: API key must be a non-empty string')
    }
    const value = key.trim()
    const status = await runApiKeyStep(async () => {
      await verifyDeepSeekKey(value)
      return await storeApiKey(requireHost(), value)
    })
    logShell(`DeepSeek API key bound; configured=${String(status.configured)}`)
    // Deferred so the reply reaches the renderer before the gate window is destroyed.
    setImmediate(() => { releaseApiKeyBinding?.() })
    return status
  })
  ipcMain.handle(DESKTOP_IPC.apiKeyDefer, (event) => {
    assertDesktopSender(event, ['shell'])
    logShell('DeepSeek API key binding deferred by the user')
    setImmediate(() => { releaseApiKeyBinding?.() })
  })
  ipcMain.handle(DESKTOP_IPC.apiKeyQuit, (event) => {
    assertDesktopSender(event, ['shell'])
    logShell('application quit requested from the API key window')
    app.quit()
  })

  // A launch that reuses its installed profile reaches the workspace in about a second, and a
  // window that appears and vanishes inside that second only reads as a flash. The startup
  // window is therefore loaded up front but revealed only once startup is demonstrably slow:
  // a first launch spends minutes unpacking and installing the seed, and an empty desktop for
  // that long is indistinguishable from a hang.
  let startupWindowReady = false
  let startupWindowDue = false
  const showStartupWindow = (): void => {
    const window = startupWindow
    if (!startupWindowDue || !startupWindowReady) return
    if (window !== undefined && !window.isDestroyed() && !window.isVisible()) {
      window.show()
      reportStartupProgress(startupProgress)
    }
  }
  const openStartupWindow = (): void => {
    const window = createWindow(managementPreload, 'none')
    startupWindow = window
    window.setSize(520, 560)
    window.setTitle(messages.startupWindowTitle)
    window.once('ready-to-show', () => { startupWindowReady = true; showStartupWindow() })
    window.once('closed', () => { if (startupWindow === window) startupWindow = undefined })
    void window.loadURL(`${SCHEME}://shell/startup.html`)
  }
  const closeStartupWindow = (): void => {
    const window = startupWindow
    startupWindow = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }
  openStartupWindow()
  reportStartupProgress(0.05)
  setTimeout(() => { startupWindowDue = true; showStartupWindow() }, SLOW_START_REVEAL_MS).unref()

  if (development === undefined) {
    reportStartupProgress(0.1)
    logShell('checking the Desktop runtime against the bundled release')
    const activated = await manager.applyRelease(resources.seed, app.getVersion(), {
      ...hooks,
      beforeActivate: async () => {},
      afterActivate: async () => {},
    })
    logShell(activated
      ? 'Desktop runtime installed from the bundled seed'
      : 'Desktop runtime already matches the bundled release')
  }
  reportStartupProgress(0.95)
  host = await startHost()
  reportStartupProgress(1)

  const checkAndPrompt = async (manual: boolean): Promise<void> => {
    const state = await updates.check()
    logShell(`update check (${manual ? 'manual' : 'automatic'}): ${state.phase}`)
    if (state.phase === 'error') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'error',
          title: messages.updateCheckFailedTitle,
          message: state.message ?? messages.unknownError,
        })
      }
      return
    }
    if (state.phase !== 'available') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: messages.updateCheckTitle,
          message: state.message ?? messages.updateCurrent,
        })
      }
      return
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: messages.updateTitle,
      message: messages.updateAvailable,
      detail: formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' }),
      buttons: [messages.installAndRestart, messages.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response !== 0) return
    const installed = await updates.install()
    if (installed.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateFailedTitle,
        message: installed.message ?? messages.unknownError,
      })
    }
  }

  const openPluginWindow = (): void => {
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
      pluginWindow.focus()
      return
    }
    pluginWindow = createWindow(managementPreload, 'none')
    pluginWindow.setSize(900, 620)
    pluginWindow.setTitle(messages.pluginWindowTitle)
    pluginWindow.once('ready-to-show', () => { pluginWindow?.show() })
    pluginWindow.once('closed', () => { pluginWindow = undefined })
    void pluginWindow.loadURL(`${SCHEME}://shell/plugin-manager.html`)
  }

  const openLogWindow = (): void => {
    const existing = logWindow
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.focus()
      return
    }
    const window = createWindow(managementPreload, 'none')
    logWindow = window
    window.setSize(1000, 700)
    window.setTitle(messages.logWindowTitle)
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    window.once('closed', () => { if (logWindow === window) logWindow = undefined })
    void window.loadURL(`${SCHEME}://shell/log-viewer.html`)
  }

  const createApiKeyWindow = (): BrowserWindow => {
    const window = createWindow(managementPreload, 'none')
    apiKeyWindow = window
    window.setSize(560, 520)
    window.setTitle(messages.apiKeyWindowTitle)
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    return window
  }
  const openApiKeyWindow = (): void => {
    const existing = apiKeyWindow
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.focus()
      return
    }
    const window = createApiKeyWindow()
    window.once('closed', () => { if (apiKeyWindow === window) apiKeyWindow = undefined })
    void window.loadURL(`${SCHEME}://shell/api-key.html`)
  }
  /**
   * Show the binding window and resolve once the user stored a key, chose to continue
   * without one, or closed the window. Binding is a gate, not a lock: every path opens
   * the main window, so an unavailable or refused key never strands the user outside.
   * @returns resolves after the binding window is gone.
   */
  const requestApiKeyBinding = (): Promise<void> => new Promise<void>((resolve) => {
    const window = createApiKeyWindow()
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      releaseApiKeyBinding = undefined
      if (apiKeyWindow === window) apiKeyWindow = undefined
      if (!window.isDestroyed()) window.destroy()
      resolve()
    }
    releaseApiKeyBinding = settle
    window.once('closed', settle)
    void window.loadURL(`${SCHEME}://shell/api-key.html`)
  })

  /**
   * Restart the shell in place.
   *
   * The backend is stopped first so the profile tree is released before the replacement
   * process boots from it, and `app.exit` then skips the `before-quit` teardown that would
   * otherwise wait on a Host this call has just stopped.
   */
  const restartApplication = async (): Promise<void> => {
    logShell('application restart requested')
    const active = host
    host = undefined
    await active?.stop().catch((error: unknown) => {
      logShell(`backend stop failed before restart: ${error instanceof Error ? error.message : String(error)}`)
    })
    await logs.close()
    app.relaunch()
    app.exit(0)
  }
  const openDevTools = (): void => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) return
    logShell('developer tools opened')
    window.webContents.openDevTools({ mode: 'detach' })
  }

  // One flat menu bar: every entry is an action, so no menu carries the application name as
  // its label. The plugin manager keeps its accelerator because the packaged manager is its
  // only entry point.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: messages.restartMenu, click: () => { void restartApplication() } },
    { label: messages.logsMenu, click: openLogWindow },
    { label: messages.checkUpdatesMenu, click: () => { void checkAndPrompt(true) } },
    { label: messages.apiKeyMenu, click: openApiKeyWindow },
    { label: messages.devtoolsMenu, click: openDevTools },
    {
      label: development === undefined ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
      accelerator: 'CmdOrCtrl+,',
      enabled: development === undefined,
      click: openPluginWindow,
    },
    { role: 'quit', label: messages.quitMenu },
  ]))

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, 'workspace')
    mainWindow = window
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      const replacement = createMainWindow()
      void replacement.loadURL(`${SCHEME}://app/index.html`)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  const ensureApiKeyBound = async (): Promise<void> => {
    let status: DesktopApiKeyStatus
    try {
      status = await describeApiKey(requireHost())
    } catch (error) {
      // A credential service the shell cannot reach must not decide whether the
      // application opens: the user keeps a working shell and can bind from the menu.
      logShell(`credential check failed; skipping the binding gate: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (status.configured) {
      logShell(`DeepSeek API key is configured${status.source === undefined ? '' : ` from ${status.source}`}`)
      return
    }
    logShell('DeepSeek API key is not configured; showing the binding window')
    await requestApiKeyBinding()
  }

  await ensureApiKeyBound()
  mainWindow = createMainWindow()
  startupWindowsPending = false
  await mainWindow.loadURL(`${SCHEME}://app/index.html`)
  logShell('main window loaded')
  closeStartupWindow()
  if (development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
  setTimeout(() => { void checkAndPrompt(false) }, 10_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (startupWindowsPending) return
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit) return
    if (host === undefined) return
    event.preventDefault()
    logShell('stopping the backend for application quit')
    const active = host
    host = undefined
    void active.stop()
      .catch((error: unknown) => {
        logShell(`backend stop failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        // Flush the file sink before the process leaves; close is idempotent.
        void logs.close().finally(() => { app.quit() })
      })
  })
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  dialog.showErrorBox(resolveDesktopLocale(app.getLocale()).messages.startupFailed, message)
  app.exit(1)
})
