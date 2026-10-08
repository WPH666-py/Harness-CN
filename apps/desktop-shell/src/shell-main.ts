/**
 * Sidecar entry point of the Tauri shell.
 *
 * The Rust shell owns windows and process lifetime; everything that is actually about the
 * product lives here, in the same Node code the Electron build ran. The split is deliberate:
 * the desktop project transaction, the seed transport, the Host pipe carrier, and the release
 * channel never needed Electron, so moving the shell to Tauri only had to replace the window,
 * menu, and protocol layers around them.
 *
 * The sidecar publishes its own control surface on `127.0.0.1` and forwards everything else to
 * the Host, which is the role Electron's privileged `dsh-app://` protocol used to play.
 *
 * Its own stdout is a line protocol read by the Rust shell, so nothing else may write there.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { DesktopHostProcess } from '../../desktop/src/host-process.ts'
import { DesktopLogBuffer, type DesktopLogSnapshot } from '../../desktop/src/log-buffer.ts'
import { resolveDesktopLocale, type DesktopMessages } from '../../desktop/src/locale.ts'
import { resolveDesktopPaths } from '../../desktop/src/paths.ts'
import {
  DesktopProjectManager,
  type DesktopProjectHooks,
  type DesktopProjectMutation,
} from '../../desktop/src/project-manager.ts'
import {
  ApiKeyError,
  describeApiKey,
  storeApiKey,
  verifyDeepSeekKey,
  type ApiKeyFailureReason,
} from '../../desktop/src/credentials-client.ts'
import { DesktopUpdateCoordinator } from '../../desktop/src/update-coordinator.ts'
import { DesktopUpdateSkipStore } from '../../desktop/src/update-skip-store.ts'
import type { DesktopApiKeyStatus, DesktopUpdateState } from '../../desktop/src/ipc.ts'
import { startShellServer, type ShellApi, type ShellServer } from './shell-server.ts'
import { ensureSeedPackage } from './seed-package.ts'
import { verifyStagedRuntime } from './staged-runtime-check.ts'
import type { ShellArguments, ShellCommand, ShellHandshake, ShellStatus } from './shell-types.ts'
import { createReleaseChannel } from './release-channel.ts'

/** Delay after the workspace opens before the launch's automatic update check runs. */
const AUTOMATIC_UPDATE_CHECK_MS = 10_000

/** Interval one coalesced batch of run-log lines is published on. */
const LOG_FLUSH_MS = 150

/** Locale key reporting each refused key-binding step. */
const API_KEY_FAILURE_MESSAGES = {
  unauthorized: 'apiKeyInvalid',
  unreachable: 'apiKeyUnreachable',
  rejected: 'apiKeyRejected',
} as const satisfies Readonly<Record<ApiKeyFailureReason, keyof DesktopMessages>>

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Read one `--name value` pair out of the sidecar's own command line. */
function readArgument(argv: readonly string[], name: string, required: boolean): string | undefined {
  const index = argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : argv[index + 1]
  if (value === undefined || value === '') {
    if (required) throw new Error(`dsh shell: --${name} is required`)
    return undefined
  }
  return value
}

function parseArguments(argv: readonly string[]): ShellArguments & { readonly locale: string } {
  const resourceDir = readArgument(argv, 'resource-dir', true)
  const version = readArgument(argv, 'version', true)
  const logDirectory = readArgument(argv, 'log-dir', true)
  if (resourceDir === undefined || version === undefined || logDirectory === undefined) {
    throw new Error('dsh shell: resource directory, version, and log directory are all required')
  }
  return {
    resourceDir,
    version,
    logDirectory,
    locale: readArgument(argv, 'locale', false) ?? 'zh-CN',
    node: join(resourceDir, 'runtime', 'node', 'node.exe'),
    pnpm: join(resourceDir, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  }
}

/** Write one handshake line the Rust shell reads off this process's stdout. */
function handshake(message: ShellHandshake): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * End this sidecar, which is also how the Host and the pnpm children end.
 *
 * The Host is a child of this process and the profile it runs from is replaced on the next
 * launch, so leaving it behind would hold the profile's files open against that replacement.
 * @param code - process exit code.
 */
let shutdown: (code: number) => Promise<void> = async (code: number) => { process.exit(code) }

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const locale = resolveDesktopLocale(options.locale)
  const messages = locale.messages
  const paths = resolveDesktopPaths()

  // The seed is no longer an installer resource, so only the runtime itself has to be present:
  // an offline or full installer still carries a seed beside it, and a normal one fetches it on
  // the first launch. Either way the seed's own inventory is what vouches for it.
  for (const required of [options.node, options.pnpm]) {
    if (!existsSync(required)) throw new Error(`dsh shell: bundled resource is missing: ${required}`)
  }

  const logs = new DesktopLogBuffer(join(options.logDirectory, 'harness.log'))
  const logShell = (text: string): void => { logs.line('shell', text) }
  let status: ShellStatus = { phase: 'starting', progress: 0.05, version: options.version }
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let host: DesktopHostProcess | undefined
  let server: ShellServer | undefined
  let stopping = false

  function publishStatus(next: ShellStatus): void {
    status = next
    server?.publish('status', next)
    handshake({ type: 'status', status: next })
  }

  const manager = new DesktopProjectManager(paths, { node: options.node, pnpm: options.pnpm })
  manager.recover()

  /** Start the Host from one project directory, sharing this process's run log. */
  const startHost = async (projectDir: string): Promise<DesktopHostProcess> => {
    const next = new DesktopHostProcess(options.node, projectDir, undefined, logs, false)
    const ready = await next.start()
    logShell(`backend ready: dsh ${ready.dshVersion} from ${projectDir}`)
    return next
  }

  const hooks: DesktopProjectHooks = {
    // Booting a Host from the staged tree is the strongest available proof that it composes, and
    // it is kept for the one operation that can introduce a package this build never saw: adding,
    // removing, or updating a plugin. A first launch and an upgrade install a tree assembled from
    // a seed whose every file was verified against the published inventory, and for those the
    // structural check below establishes completeness in a few seconds instead of fifty.
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
          host = await startHost(paths.profile)
        } catch (error) {
          restartFailure = error
        }
      }
      if (healthFailure !== undefined && restartFailure !== undefined) {
        throw new AggregateError([
          errorOf(healthFailure, 'dsh shell: staged health check failed'),
          errorOf(restartFailure, 'dsh shell: active backend restart failed'),
        ], 'dsh shell: staged health check and active backend restart failed')
      }
      if (healthFailure !== undefined) throw errorOf(healthFailure, 'dsh shell: staged health check failed')
      if (restartFailure !== undefined) throw errorOf(restartFailure, 'dsh shell: active backend restart failed')
    },
    beforeActivate: async () => {
      const active = host
      host = undefined
      await active?.stop()
    },
    afterActivate: async () => { host = await startHost(paths.profile) },
    note: logShell,
    progress: (fraction: number) => {
      publishStatus({ ...status, progress: Math.min(1, Math.max(status.progress, fraction)) })
    },
  }

  const requireHost = (): DesktopHostProcess => {
    const active = host
    if (active === undefined) throw new Error('dsh shell: the backend is not running')
    return active
  }

  const skipStore = new DesktopUpdateSkipStore(join(paths.root, 'update-skip.json'))
  let skippedVersion = await skipStore.read()
  const skipped = {
    remember: (version: string): void => {
      skippedVersion = version
      void skipStore.remember(version)
    },
    suppresses: (version: string): boolean => version === skippedVersion,
  }
  const updates = new DesktopUpdateCoordinator(
    (state) => {
      updateState = state
      server?.publish('update', state)
      handshake({ type: 'update', state })
      return state
    },
    async () => {
      const active = host
      host = undefined
      await active?.stop()
    },
    createReleaseChannel({
      currentVersion: options.version,
      downloadDirectory: join(paths.root, 'update'),
    }),
    () => { void shutdown(0) },
    skipped,
    logShell,
  )

  const runApiKeyStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (error) {
      if (error instanceof ApiKeyError) throw new Error(messages[API_KEY_FAILURE_MESSAGES[error.reason]])
      throw error
    }
  }

  const api: ShellApi = {
    status: () => status,
    locale: () => locale,
    logs: (): DesktopLogSnapshot => logs.snapshot(),
    clearLogs: (): DesktopLogSnapshot => {
      logs.clear()
      logShell('run log cleared by the user')
      return logs.snapshot()
    },
    revealLogs: () => {
      const file = logs.snapshot().file
      logShell(`run log: ${file}`)
      // The shell has no plugin for this and does not need one: the platform's own file manager
      // already does it, and a failure here is cosmetic rather than something to report.
      spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref()
    },
    plugins: () => manager.listPlugins(),
    mutate: async (mutation: DesktopProjectMutation) => { await manager.mutate(mutation, hooks) },
    updateState: () => updateState,
    checkUpdates: async () => await updates.check(true),
    installUpdates: async () => await updates.install(),
    skipUpdate: (version: string) => { skipped.remember(version) },
    apiKeyStatus: async (): Promise<DesktopApiKeyStatus> =>
      await runApiKeyStep(async () => await describeApiKey(requireHost())),
    saveApiKey: async (key: string): Promise<DesktopApiKeyStatus> => await runApiKeyStep(async () => {
      await verifyDeepSeekKey(key)
      return await storeApiKey(requireHost(), key)
    }),
    deferApiKey: () => { logShell('API key binding deferred by the user') },
    quit: () => { void shutdown(0) },
    fetchHost: async (request: Request): Promise<Response> => {
      const active = host
      if (active === undefined) return new Response('backend unavailable', { status: 503 })
      return await active.fetch(request)
    },
  }

  const running = await startShellServer({ resourceDir: options.resourceDir, api })
  server = running
  logShell(`Harness-CN ${options.version} starting; control surface on ${running.origin}`)
  handshake({ type: 'listen', port: running.port })

  // The viewers drain one coalesced batch per interval rather than one push per line: Host
  // output arrives in bursts, and this keeps the event stream off the logging path.
  const logTimer = setInterval(() => {
    const update = logs.drain()
    if (update.entries.length === 0) return
    running.publish('logs', update)
  }, LOG_FLUSH_MS)
  logTimer.unref()

  shutdown = async (code: number): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(logTimer)
    const active = host
    host = undefined
    await active?.stop().catch((error: unknown) => {
      logShell(`backend stop failed: ${errorOf(error, 'backend stop failed').message}`)
    })
    await running.close().catch(() => undefined)
    await logs.close().catch(() => undefined)
    process.exit(code)
  }

  try {
    publishStatus({ phase: 'starting', progress: 0.05, version: options.version })
    // The offline package is obtained before anything can be installed from it. A first launch on
    // a normal installation fetches it once; every later launch finds it where it was left, and an
    // offline installer ships it beside the runtime so nothing is fetched at all.
    const seed = await ensureSeedPackage({
      version: options.version,
      resourceDir: options.resourceDir,
      cacheRoot: join(paths.root, 'seed'),
      onProgress: (note, fraction) => {
        publishStatus({
          phase: 'starting',
          // The fetch owns the first tenth of the bar; the install that follows owns the rest.
          progress: fraction === undefined ? status.progress : 0.05 + fraction * 0.09,
          version: options.version,
          note,
        })
      },
    })
    logShell(`offline package: ${seed.origin} at ${seed.directory}`)
    publishStatus({ phase: 'starting', progress: 0.15, version: options.version })
    logShell('checking the desktop runtime against the bundled release')
    const activated = await manager.applyRelease(seed.directory, options.version, {
      ...hooks,
      // A tree built from a verified seed is checked for completeness rather than booted: the boot
      // would cost about fifty seconds of every first launch and every upgrade, and the only thing
      // it adds over this is proof that a composition applies — which cannot have changed, because
      // no package in this tree is new. Plugin changes still take the boot.
      healthCheck: async (projectDir) => {
        const report = await verifyStagedRuntime({ projectDir, node: options.node })
        logShell(
          `staged runtime verified: ${String(report.files)} files,`
          + ` native modules [${report.nativeModules.join(', ')}]`,
        )
      },
      beforeActivate: async () => {},
      afterActivate: async () => {},
    })
    logShell(activated
      ? 'desktop runtime installed from the bundled seed'
      : 'desktop runtime already matches the bundled release')
    publishStatus({ phase: 'starting', progress: 0.95, version: options.version })

    host = await startHost(paths.profile)
    publishStatus({ phase: 'ready', progress: 1, version: options.version })

    let needsApiKey = false
    try {
      const keyStatus = await describeApiKey(host)
      needsApiKey = !keyStatus.configured
      logShell(keyStatus.configured
        ? `DeepSeek API key is configured${keyStatus.source === undefined ? '' : ` from ${keyStatus.source}`}`
        : 'DeepSeek API key is not configured; offering the binding window')
    } catch (error) {
      // A credential service this shell cannot reach must not decide whether the application
      // opens: the user keeps a working shell and can bind the key from the menu.
      logShell(`credential check failed; skipping the binding gate: ${errorOf(error, 'credential check failed').message}`)
    }
    handshake({ type: 'ready', port: running.port, needsApiKey })

    const timer = setTimeout(() => { void updates.check(false) }, AUTOMATIC_UPDATE_CHECK_MS)
    timer.unref()

    // The Rust shell's menu bar has no other way to reach an operation that only this process
    // can perform, so the commands it raises arrive here, where the release channel lives. A
    // closed stdin means the shell is gone, which is also the last moment the Host may run.
    const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })
    commands.on('line', (line: string) => {
      let command: ShellCommand
      try {
        command = JSON.parse(line) as ShellCommand
      } catch {
        return
      }
      if (command.command === 'check-updates') {
        void updates.check(true).then((state) => {
          if (state.phase === 'idle') {
            handshake({ type: 'message', title: messages.updateCheckTitle, body: messages.updateCurrent })
          } else if (state.phase === 'error') {
            handshake({
              type: 'message',
              title: messages.updateCheckFailedTitle,
              body: state.message ?? messages.unknownError,
            })
          }
        })
      } else if (command.command === 'quit') {
        void shutdown(0)
      }
    })
    commands.on('close', () => { void shutdown(0) })
  } catch (error) {
    const message = errorOf(error, messages.startupFailed).message
    publishStatus({ phase: 'error', progress: status.progress, version: options.version, message })
    logShell(`startup failed: ${message}`)
    handshake({ type: 'fatal', message })
    await shutdown(1)
  }
}

process.on('SIGTERM', () => { void shutdown(0) })
process.on('SIGINT', () => { void shutdown(0) })
process.on('uncaughtException', (error) => {
  handshake({ type: 'fatal', message: errorOf(error, 'dsh shell: uncaught exception').message })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  handshake({ type: 'fatal', message: errorOf(reason, 'dsh shell: unhandled rejection').message })
  process.exit(1)
})

await main()
