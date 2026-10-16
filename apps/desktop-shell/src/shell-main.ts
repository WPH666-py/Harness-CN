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

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { DesktopHostProcess } from '../../desktop/src/host-process.ts'
import { DesktopLogBuffer, type DesktopLogSnapshot } from '../../desktop/src/log-buffer.ts'
import { resolveDesktopLocale, type DesktopMessages } from '../../desktop/src/locale.ts'
import { resolveDesktopPaths, type DesktopPaths } from '../../desktop/src/paths.ts'
import { adoptHarnessCnHome, describeHomeMigration, migrateLegacyHarnessHome } from '../../desktop/src/product-home.ts'
import {
  describeDesktopRecovery,
  DesktopProjectManager,
  type DesktopProjectHooks,
  type DesktopProjectMutation,
  type DesktopRecoveryReport,
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
import { startShellServer, type ShellApi } from './shell-server.ts'
import { ensureSeedPackage } from './seed-package.ts'
import { verifyStagedRuntime } from './staged-runtime-check.ts'
import type { ShellArguments, ShellCommand, ShellHandshake, ShellStatus } from './shell-types.ts'
import { createReleaseChannel } from './release-channel.ts'
import { FEEDBACK_MESSAGE_MAX, sendFeedbackMail, type FeedbackSubmission } from './feedback-mail.ts'

/** Delay after the workspace opens before the launch's automatic update check runs. */
const AUTOMATIC_UPDATE_CHECK_MS = 10_000

/**
 * How often a session that stays open re-asks the release channel.
 *
 * A launch checks once, and a session can outlive a release by days; re-checking is what makes a
 * long-running window offer the version published while it was open, without polling anything.
 */
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * How long the handover line is given to reach the shell before this process exits.
 *
 * The installer is started by the shell, not here, so what this delay covers is the trip of the
 * `launchinstaller` line up the stdout pipe while the process is still alive to flush it. The
 * shell spawns the installer as soon as it reads the line, and that process is already outside
 * this one's job object, so nothing here has to wait for the installer itself.
 */
const INSTALL_EXIT_DELAY_MS = 800

/** Silent switch of the NSIS installer, which then replaces the previous installation in place. */
const NSIS_SILENT_SWITCH = '/S'

/**
 * Subcommand the installer runs after its files are in place, before the first launch.
 *
 * Building the desktop runtime is the one-time cost of a fresh installation. It is paid on the
 * first launch only because nothing runs at install time; running it here, from the Node runtime
 * the installer just unpacked, moves that cost to the moment the user is already waiting for the
 * installer to finish. A prebuild that fails for any reason — no network, no disk, a machine that
 * refuses — is not fatal: the first launch builds the same runtime the same way.
 */
const PREBUILD_SWITCH = '--prebuild'

/** Directory Node keeps its on-disk V8 compile cache in for the backend process. */
const COMPILE_CACHE_DIRECTORY = 'node-compile-cache'

/** Interval one coalesced batch of run-log lines is published on. */
const LOG_FLUSH_MS = 150

/** Locale key reporting each refused key-binding step. */
const API_KEY_FAILURE_MESSAGES = {
  unauthorized: 'apiKeyInvalid',
  unreachable: 'apiKeyUnreachable',
  rejected: 'apiKeyRejected',
} as const satisfies Readonly<Record<ApiKeyFailureReason, keyof DesktopMessages>>

/** Longest this process waits for the backend to stop before it exits regardless. */
const HOST_STOP_BUDGET_MS = 18_000

/** How long the run log is given to flush after the backend is gone. */
const LOG_FLUSH_BUDGET_MS = 2_000

/**
 * Resolve after `work` settles or after `milliseconds`, whichever comes first.
 *
 * A stop that never returns is the failure this bounds: the shell kills a sidecar that is still
 * waiting, and the Host it was stopping survives the launch it belonged to.
 * @param work - the operation being bounded.
 * @param milliseconds - longest time to wait.
 * @returns whether the operation settled inside the budget.
 */
async function within(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([work.then(() => true, () => true), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

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
  const installDir = readArgument(argv, 'install-dir', true)
  if (resourceDir === undefined || version === undefined || logDirectory === undefined || installDir === undefined) {
    throw new Error('dsh shell: resource directory, install directory, version, and log directory are all required')
  }
  return {
    resourceDir,
    version,
    logDirectory,
    installDir,
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
 * launch, so leaving it behind would hold the profile's files open against that replacement. It
 * is a child, but it is not the whole tree: the agent loop an exit interrupts lives in the Host,
 * and every command, subagent, and background job it started lives below it. Stopping the Host is
 * therefore what stops all of them, and this process does not exit until that stop has either
 * finished or spent its whole budget — exiting first is what turns "the user quit" into a launch
 * whose work is still running.
 * @param code - process exit code.
 */
let shutdown: (code: number) => Promise<void> = async (code: number) => { process.exit(code) }

/**
 * Whether one release-check failure reads as a network failure rather than a release that is broken.
 *
 * The distinction decides the advice: a machine that cannot reach either host needs to hear about
 * proxies and mirrors, while a host that answered with something unreadable needs to hear that the
 * release itself is the problem. Only transport-shaped failures are matched, so an error this
 * product raises in its own words is never given a network explanation it does not have.
 */
const NETWORK_FAILURE_PATTERN = new RegExp(
  [
    'fetch failed', 'ENOTFOUND', 'EAI_AGAIN', 'ECONN', 'ETIMEDOUT', 'EACCES',
    'CERT', 'certificate', 'self.signed', 'socket', 'timed? ?out', 'getaddrinfo', 'proxy',
  ].join('|'),
  'iu',
)

/**
 * One sentence a user can act on, appended to a release-check failure that looks like the network.
 *
 * Both release hosts are named because checking updates asks both: a machine that can reach neither
 * is the case this exists for, and Gitee is the one that answers from inside China. The proxy note
 * points at the same variables the package installer now honours, so "how do I get this machine
 * online" has one answer across the product.
 * @param message - failure as the release channel reported it.
 * @returns the message, with the advice appended when the failure looks like transport.
 */
function describeUpdateFailure(message: string): string {
  if (!NETWORK_FAILURE_PATTERN.test(message)) return message
  return `${message}\n\n检查更新需要访问 gitee.com 或 api.github.com。`
    + '如果这台机器通过代理上网，请在系统环境变量中设置 HTTPS_PROXY 后重试；'
    + '也可以直接从发布页下载安装包手动更新。'
}

/**
 * Adopt the Harness-CN home, and copy the Harness data an earlier Harness-CN left in the shared home.
 *
 * Both entry points run this before they resolve any desktop path, because the home decides where
 * the profile, the package store, and the Host's sessions, storages, attachments, and credentials
 * live. The migration never writes to, renames, or removes the legacy home; when that home also
 * carries the other desktop product, it copies nothing and the log says so.
 * @param log - sink for the migration lines.
 * @returns the resolved Harness-CN home to hand to the path resolver.
 */
function adoptHome(log: (text: string) => void): string {
  const home = adoptHarnessCnHome()
  for (const line of describeHomeMigration(migrateLegacyHarnessHome({ home }))) log(line)
  return home
}

/**
 * Report an interrupted activation repair into the run log.
 *
 * Recovery runs before anything else reads the profile and is silent by construction, so a
 * launch that killed a directory replacement would otherwise leave only the absence of a step
 * to guess from.
 * @param report - what the manager repaired, or undefined when the previous launch committed.
 * @param log - sink for the recovery lines.
 */
function reportRecovery(report: DesktopRecoveryReport | undefined, log: (text: string) => void): void {
  if (report === undefined) return
  for (const line of describeDesktopRecovery(report)) log(line)
}

/**
 * Boot the runtime the installer just built, then stop it, so the first launch starts warm.
 *
 * Every file of a freshly composed profile is being read for the first time on this machine, and
 * that first touch — the operating system filling its cache and the antivirus scanning a path it has
 * never seen — is what makes a cold launch spend about a minute before the backend prints its first
 * line, against the roughly fifteen seconds the same profile costs once it is warm. The installer is
 * the one caller that can pay that minute where nobody is waiting on a splash screen, so it boots
 * the activated profile here and the launch inherits the warmed files.
 *
 * Booting also turns the prebuild into install-time evidence: a profile whose plugin tree cannot
 * compose fails into the installer's log rather than on the user's first launch. That failure is
 * reported and swallowed, because the installer falls back to the first launch's own build either
 * way and this process still has to close its log buffer.
 * @param options - the parsed shell arguments, which name the bundled Node the Host runs on.
 * @param paths - the resolved desktop paths; their profile is the runtime to warm.
 * @param logs - the run log the Host writes its own output into.
 * @param note - sink for the warm-up lines.
 */
async function warmRuntime(
  options: ShellArguments,
  paths: DesktopPaths,
  logs: DesktopLogBuffer,
  note: (text: string) => void,
): Promise<void> {
  const compileCacheDir = join(paths.root, COMPILE_CACHE_DIRECTORY)
  mkdirSync(compileCacheDir, { recursive: true })
  const startedAt = Date.now()
  const probe = new DesktopHostProcess(options.node, paths.profile, undefined, logs, false, compileCacheDir)
  try {
    const ready = await probe.start()
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    note(`desktop runtime warmed: dsh ${ready.dshVersion} in ${String(seconds)} s`)
  } catch (error) {
    note(`desktop runtime warm-up failed: ${errorOf(error, 'the backend did not start').message}`)
  } finally {
    await probe.stop().catch(() => undefined)
  }
}

/**
 * Build the desktop runtime now instead of on the first launch.
 *
 * The installer runs this once its files are in place. It obtains the offline package exactly as a
 * launch would — bundled, cached, or fetched — and then runs the same transaction, so a profile
 * this builds is byte-for-byte the profile the first launch would have built and the launch is left
 * with nothing to do but start the backend. Once that runtime is activated it is booted once and
 * stopped again, because this is the only place the first touch of every one of its files can be
 * paid while nobody is watching a splash screen.
 *
 * Nothing here publishes a handshake or opens a window; the installer is the only reader, and it
 * ignores the exit code so a failure falls back to the first launch's own build.
 * @param argv - this process's arguments, including the prebuild switch.
 */
async function prebuild(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv)
  const logs = new DesktopLogBuffer(join(options.logDirectory, 'harness.log'))
  const note = (text: string): void => { logs.line('shell', `prebuild: ${text}`) }
  const paths = resolveDesktopPaths(adoptHome(note))
  for (const required of [options.node, options.pnpm]) {
    if (!existsSync(required)) throw new Error(`dsh shell: bundled resource is missing: ${required}`)
  }
  const manager = new DesktopProjectManager(paths, { node: options.node, pnpm: options.pnpm })
  reportRecovery(manager.recover(), note)
  note(`building ${options.version} into ${paths.profile}`)
  const seed = await ensureSeedPackage({
    version: options.version,
    resourceDir: options.resourceDir,
    cacheRoot: join(paths.root, 'seed'),
    onProgress: (message) => { if (message !== '') note(message) },
  })
  note(`offline package: ${seed.origin} at ${seed.directory}`)
  const activated = await manager.applyRelease(seed.directory, options.version, {
    healthCheck: async (projectDir) => {
      const report = await verifyStagedRuntime({ projectDir, node: options.node })
      note(`staged runtime verified: ${String(report.files)} files`)
    },
    beforeActivate: async () => {},
    afterActivate: async () => {},
    note,
  })
  note(activated ? 'desktop runtime installed during setup' : 'desktop runtime already matches the release')
  await warmRuntime(options, paths, logs, note)
  await logs.close()
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const locale = resolveDesktopLocale(options.locale)
  const messages = locale.messages
  const logs = new DesktopLogBuffer(join(options.logDirectory, 'harness.log'))
  const logShell = (text: string): void => { logs.line('shell', text) }
  const paths = resolveDesktopPaths(adoptHome(logShell))

  // Node's own on-disk compile cache is what makes the backend's second start cheaper than its
  // first: every module it loads is compiled once and the bytecode is reused afterwards. It must
  // live outside the profile, which a release upgrade replaces wholesale, and it must exist before
  // the backend is told to use it.
  const compileCacheDir = join(paths.root, COMPILE_CACHE_DIRECTORY)
  mkdirSync(compileCacheDir, { recursive: true })

  // The seed is no longer an installer resource, so only the runtime itself has to be present:
  // an offline or full installer still carries a seed beside it, and a normal one fetches it on
  // the first launch. Either way the seed's own inventory is what vouches for it.
  for (const required of [options.node, options.pnpm]) {
    if (!existsSync(required)) throw new Error(`dsh shell: bundled resource is missing: ${required}`)
  }

  let status: ShellStatus = { phase: 'starting', progress: 0.05, version: options.version }
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let host: DesktopHostProcess | undefined
  let stopping = false
  /** Periodic release-channel re-check, owned here so the stop that ends this process clears it. */
  let recheck: ReturnType<typeof setInterval> | undefined

  function publishStatus(next: ShellStatus): void {
    status = next
    // The control surface is listening before anything publishes a status: this closure and the
    // update coordinator below are only ever called after `startShellServer` has resolved.
    running.publish('status', next)
    handshake({ type: 'status', status: next })
  }

  const manager = new DesktopProjectManager(paths, { node: options.node, pnpm: options.pnpm })
  reportRecovery(manager.recover(), logShell)

  /** Start the Host from one project directory, sharing this process's run log. */
  const startHost = async (projectDir: string): Promise<DesktopHostProcess> => {
    const next = new DesktopHostProcess(options.node, projectDir, undefined, logs, false, compileCacheDir)
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
    step: (label: string, fraction: number) => {
      publishStatus({ ...status, step: label, stepProgress: fraction })
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
      running.publish('update', state)
      handshake({ type: 'update', state })
      // A check nobody asked for has to leave a trace: the automatic check runs ten seconds after
      // the workspace opens and every six hours after that, and a machine that cannot reach either
      // release host would otherwise sit on an old version with nothing anywhere saying so. The run
      // log keeps the reason, and the shell marks its own update entry, so the state is visible
      // from the menu bar rather than only to a window the user has to think to open.
      if (state.phase === 'error' && state.message !== undefined) {
        logShell(`release check failed: ${state.message}`)
      }
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
    // The installer must outlive this process, and it can only do that if the shell starts it:
    // this process and every child it spawns live in the shell's kill-on-close job, so an
    // installer started here would be terminated as part of the same exit that is supposed to
    // hand over to it. The shell sets `CREATE_BREAKAWAY_FROM_JOB` on that one process, and the
    // delay below is what lets the line reach the shell's reader before this process ends.
    (installer: string) => {
      handshake({ type: 'launchinstaller', installer, silentSwitch: NSIS_SILENT_SWITCH })
      const timer = setTimeout(() => { void shutdown(0) }, INSTALL_EXIT_DELAY_MS)
      timer.unref()
    },
    skipped,
    logShell,
    options.version,
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
    cancelUpdates: () => {
      const cancelled = updates.cancel()
      if (cancelled) logShell('the user cancelled the installer download')
      return cancelled
    },
    uninstall: () => {
      // Uninstalling is the user taking the product off this machine, so it ends the same way an
      // installation does: the Host and everything it started stop first, and the platform
      // uninstaller removes the files only after this process is gone. It is detached because it
      // deletes the very executable running it, which is why the uninstaller copies itself out
      // before removing the installation directory.
      const uninstaller = join(options.installDir, 'uninstall.exe')
      logShell(`the user asked to uninstall; starting ${uninstaller}`)
      spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' }).unref()
      const timer = setTimeout(() => { void shutdown(0) }, INSTALL_EXIT_DELAY_MS)
      timer.unref()
    },
    skipUpdate: (version: string) => { skipped.remember(version) },
    sendFeedback: async (submission: FeedbackSubmission): Promise<void> => {
      const message = submission.message.trim()
      const email = submission.email.trim()
      if (message === '') throw new Error('反馈内容不能为空')
      if (message.length > FEEDBACK_MESSAGE_MAX) {
        throw new Error(`反馈内容过长，请控制在 ${String(FEEDBACK_MESSAGE_MAX)} 字以内`)
      }
      // The form asks for a QQ mailbox because that is what the author replies through;
      // anything else is refused here rather than discovered as a bounce later.
      if (!/^[\w.+-]+@qq\.com$/iu.test(email)) throw new Error('请填写有效的 QQ 邮箱')
      await sendFeedbackMail({ message, email })
      logShell('one feedback message was sent to the author')
    },
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

  const running = await startShellServer({
    resourceDir: options.resourceDir,
    api,
    note: (text) => { logShell(text) },
  })
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
    if (recheck !== undefined) clearInterval(recheck)
    logShell('stopping: closing the workspace and every task it started')
    const active = host
    host = undefined
    if (active !== undefined) {
      const stopped = await within(active.stop().catch((error: unknown) => {
        logShell(`backend stop failed: ${errorOf(error, 'backend stop failed').message}`)
      }), HOST_STOP_BUDGET_MS)
      // One host left running would be a second copy holding this profile, so a stop that ran out
      // its budget is reported rather than passed over; the shell's own containment ends it.
      if (!stopped) {
        logShell(`backend stop did not finish within ${String(HOST_STOP_BUDGET_MS)} ms; ending the process`)
        process.exit(code)
      }
    }
    await running.close().catch(() => undefined)
    await within(logs.close().catch(() => undefined), LOG_FLUSH_BUDGET_MS)
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
      onProgress: (note, fraction, step) => {
        // The status type keeps `step` and `stepProgress` absent rather than undefined, so a
        // message that has no step to name carries no step key at all.
        publishStatus({
          phase: 'starting',
          // The fetch owns the first tenth of the bar; the install that follows owns the rest.
          progress: fraction === undefined ? status.progress : 0.05 + fraction * 0.09,
          version: options.version,
          note,
          ...(step === undefined ? {} : { step }),
          ...(fraction === undefined ? {} : { stepProgress: fraction }),
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
        const report = await verifyStagedRuntime({
          projectDir,
          node: options.node,
          onProgress: (fraction) => {
            publishStatus({ ...status, step: '检查运行时完整性', stepProgress: fraction })
          },
        })
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
    // Starting the Host is the one step with no denominator: dsh reports that it is ready, and
    // nothing in between counts anything, so this shows how long it has been running instead of a
    // percentage that would have to be invented. Silence is what a stuck launch looks like.
    publishStatus({
      phase: 'starting',
      progress: 0.95,
      version: options.version,
      step: '启动工作区',
      note: '正在启动工作区…',
    })
    const hostStartedAt = Date.now()
    const hostTicker = setInterval(() => {
      publishStatus({
        ...status,
        note: `正在启动工作区… 已等待 ${String(Math.round((Date.now() - hostStartedAt) / 1000))} 秒`,
      })
    }, 1000)
    try {
      host = await startHost(paths.profile)
    } finally {
      clearInterval(hostTicker)
    }
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
    // A window that stays open for days outlives the release channel it checked at launch, so the
    // check repeats. A skipped version stays skipped here as it does on the first check; only the
    // menu's own check overrides that, because only that one is the user asking.
    const recheckPeriod = setInterval(() => { void updates.check(false) }, UPDATE_RECHECK_MS)
    recheckPeriod.unref()
    recheck = recheckPeriod

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
          } else if (state.phase === 'available') {
            // A manual check is answered even when the release was already offered: the menu item
            // promises an answer, and the state sink alone is only visible to a window that is
            // already open. An available release also opens the prompt through the handshake the
            // state sink publishes, so this line reports what that window is about to show.
            const version = state.version ?? ''
            logShell(`release channel offers ${version}; opening the update prompt`)
          } else if (state.phase === 'error') {
            handshake({
              type: 'message',
              title: messages.updateCheckFailedTitle,
              body: describeUpdateFailure(state.message ?? messages.unknownError),
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

const argv = process.argv.slice(2)
if (argv.includes(PREBUILD_SWITCH)) {
  // The installer runs this once its files are in place. A failure is reported on stderr, which
  // the installer writes to its own log, and sets the exit code so a manual run can tell success
  // from failure; the installer ignores both and falls back to the first launch's own build.
  await prebuild(argv).catch((error: unknown) => {
    process.stderr.write(`dsh shell: prebuild failed: ${errorOf(error, 'prebuild failed').message}\n`)
    process.exitCode = 1
  })
} else {
  await main()
}
