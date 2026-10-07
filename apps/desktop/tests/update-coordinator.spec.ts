import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import type { DesktopUpdateBackend } from '../src/update-backend.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')
const { DesktopUpdateSkipStore } = await import('../src/update-skip-store.ts')

/**
 * Build a backend that answers one version and records its calls.
 * @param version - version the channel offers, undefined when the build is current.
 * @param overrides - partial overrides for the download and install steps.
 * @returns stub backend plus its call record.
 */
function stubBackend(
  version: string | undefined,
  overrides: Partial<DesktopUpdateBackend> = {},
): DesktopUpdateBackend & {
  readonly download: ReturnType<typeof vi.fn>
  readonly install: ReturnType<typeof vi.fn>
  readonly check: ReturnType<typeof vi.fn>
} {
  const backend = {
    check: vi.fn(async () => version),
    download: vi.fn(async () => 'verified' as const),
    install: vi.fn(async () => {}),
    ...overrides,
  }
  return backend as DesktopUpdateBackend & {
    readonly download: ReturnType<typeof vi.fn>
    readonly install: ReturnType<typeof vi.fn>
    readonly check: ReturnType<typeof vi.fn>
  }
}

/**
 * Build a backend whose check never settles, to observe operation coalescing.
 * @returns backend plus its own resolver.
 */
function pendingBackend(): {
  readonly backend: DesktopUpdateBackend
  readonly settled: PromiseWithResolvers<string | undefined>
  readonly download: ReturnType<typeof vi.fn>
} {
  const settled = Promise.withResolvers<string | undefined>()
  const download = vi.fn(async () => 'verified' as const)
  return {
    backend: { check: () => settled.promise, download, install: vi.fn(async () => {}) },
    settled,
    download,
  }
}

/**
 * Build a coordinator whose state sink records every published state.
 * @param backend - release channel the coordinator drives.
 * @returns coordinator plus the recorded states and the injectable callbacks.
 */
function coordinatorOver(backend: DesktopUpdateBackend): {
  readonly states: DesktopUpdateState[]
  readonly coordinator: InstanceType<typeof DesktopUpdateCoordinator>
  readonly beforeRestart: ReturnType<typeof vi.fn>
  readonly requestExit: ReturnType<typeof vi.fn>
  readonly skipped: { remember: ReturnType<typeof vi.fn>; suppresses: (version: string) => boolean }
  readonly order: string[]
  readonly notes: string[]
} {
  const states: DesktopUpdateState[] = []
  const order: string[] = []
  const notes: string[] = []
  const beforeRestart = vi.fn(async () => { order.push('beforeRestart') })
  const requestExit = vi.fn(() => { order.push('exit') })
  const remembered: string[] = []
  const skipped = {
    remember: vi.fn((version: string) => { remembered.push(version) }),
    suppresses: (version: string) => remembered.includes(version),
  }
  const tracking: DesktopUpdateBackend = {
    check: backend.check,
    download: async (request) => {
      order.push('download')
      return await backend.download(request)
    },
    install: async () => {
      order.push('install')
      await backend.install()
    },
  }
  return {
    states,
    coordinator: new DesktopUpdateCoordinator(
      (state) => {
        states.push(state)
        return state
      },
      beforeRestart,
      tracking,
      requestExit,
      skipped,
      (note) => { notes.push(note) },
    ),
    beforeRestart,
    requestExit,
    skipped,
    order,
    notes,
  }
}

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '7.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'latest' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

describe('desktop update coordinator', () => {
  it('downloads, stops the backend, starts the installer, and ends the process in order', async () => {
    const backend = stubBackend('1.1.0')
    const { coordinator, states, order, requestExit, beforeRestart } = coordinatorOver(backend)

    await expect(coordinator.check()).resolves.toEqual({ phase: 'available', version: '1.1.0' })
    await expect(coordinator.install()).resolves.toEqual({ phase: 'ready', version: '1.1.0' })

    expect(order).toEqual(['download', 'beforeRestart', 'install', 'exit'])
    expect(backend.download).toHaveBeenCalledWith({ version: '1.1.0', progress: expect.any(Function) })
    expect(beforeRestart).toHaveBeenCalledOnce()
    expect(requestExit).toHaveBeenCalledOnce()
    expect(states.map(state => state.phase)).toEqual(['checking', 'available', 'installing', 'ready'])
  })

  it('ends the process exactly once for a successful install', async () => {
    const { coordinator, requestExit } = coordinatorOver(stubBackend('1.1.0'))

    await coordinator.check()
    await coordinator.install()

    expect(requestExit).toHaveBeenCalledTimes(1)
  })

  it('leaves the process running when the download fails', async () => {
    const backend = stubBackend('1.1.0', { download: async () => { throw new Error('download refused') } })
    const { coordinator, requestExit, beforeRestart } = coordinatorOver(backend)

    await coordinator.check()
    await expect(coordinator.install()).resolves.toEqual({
      phase: 'error',
      version: '1.1.0',
      message: 'download refused',
    })

    expect(requestExit).not.toHaveBeenCalled()
    expect(beforeRestart).not.toHaveBeenCalled()
  })

  it('leaves the process running when the installer cannot start', async () => {
    const backend = stubBackend('1.1.0', { install: async () => { throw new Error('installer refused') } })
    const { coordinator, requestExit } = coordinatorOver(backend)

    await coordinator.check()
    await expect(coordinator.install()).resolves.toMatchObject({ phase: 'error', message: 'installer refused' })

    expect(requestExit).not.toHaveBeenCalled()
  })

  it('reports download progress through the state sink', async () => {
    const backend = stubBackend('1.1.0', {
      download: async ({ progress }) => {
        progress(0.25)
        progress(1)
        return 'verified'
      },
    })
    const { coordinator, states } = coordinatorOver(backend)

    await coordinator.check()
    await coordinator.install()

    expect(states.filter(state => state.progress !== undefined)).toEqual([
      { phase: 'installing', version: '1.1.0', progress: 0.25 },
      { phase: 'installing', version: '1.1.0', progress: 1 },
    ])
  })

  it('logs an installer the channel could not vouch for', async () => {
    // `unverified` is a real outcome of the GitHub channel, which cannot verify a release
    // that declares no digest; the user-facing state stays identical and the run log carries it.
    const backend = stubBackend('1.1.0', { download: async () => 'unverified' })
    const { coordinator, notes } = coordinatorOver(backend)

    await coordinator.check()
    await expect(coordinator.install()).resolves.toEqual({ phase: 'ready', version: '1.1.0' })

    expect(notes).toEqual(['desktop update 1.1.0 downloaded (unverified)'])
  })

  it('reports no update when the channel offers none', async () => {
    const { coordinator, states } = coordinatorOver(stubBackend(undefined))

    await expect(coordinator.check()).resolves.toEqual({ phase: 'idle' })
    expect(states.map(state => state.phase)).toEqual(['checking', 'idle'])
  })

  it('reports a check failure only as state for the caller to decide on', async () => {
    const backend = stubBackend(undefined, { check: async () => { throw new Error('offline') } })
    const { coordinator } = coordinatorOver(backend)

    await expect(coordinator.check()).resolves.toEqual({ phase: 'error', message: 'offline' })
  })

  it('queues install behind an in-flight check instead of returning the check result', async () => {
    const pending = pendingBackend()
    const { coordinator } = coordinatorOver(pending.backend)

    const checking = coordinator.check()
    const installing = coordinator.install()
    expect(pending.download).not.toHaveBeenCalled()
    pending.settled.resolve('1.2.0')

    await expect(checking).resolves.toEqual({ phase: 'available', version: '1.2.0' })
    await expect(installing).resolves.toEqual({ phase: 'ready', version: '1.2.0' })
    expect(pending.download).toHaveBeenCalledOnce()
  })
})

describe('desktop update skip state', () => {
  /** Scratch userData directory each skip test writes into. */
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-cn-skip-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('stays quiet on an automatic check for exactly the skipped version', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    const { coordinator } = coordinatorOver(stubBackend('1.1.0'))
    const skipping = new DesktopUpdateCoordinator(
      state => state,
      async () => {},
      stubBackend('1.1.0'),
      () => {},
      {
        remember: (version) => { void store.remember(version) },
        suppresses: version => version === '1.1.0',
      },
    )
    expect(coordinator).toBeDefined()
    await store.remember('1.1.0')

    await expect(skipping.check()).resolves.toEqual({ phase: 'idle' })
    await expect(skipping.install()).rejects.toThrow(/no verified update is available/u)
  })

  it('prompts again for the skipped version when the user checks manually', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    await store.remember('1.1.0')
    const skipped = {
      remember: (version: string) => { void store.remember(version) },
      suppresses: (version: string) => version === '1.1.0',
    }
    const manual = new DesktopUpdateCoordinator(state => state, async () => {}, stubBackend('1.1.0'), () => {}, skipped)

    await expect(manual.check(true)).resolves.toEqual({ phase: 'available', version: '1.1.0' })
  })

  it('prompts for a version newer than the skipped one', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    await store.remember('1.1.0')
    const skipped = {
      remember: (version: string) => { void store.remember(version) },
      suppresses: (version: string) => version === '1.1.0',
    }
    const newer = new DesktopUpdateCoordinator(state => state, async () => {}, stubBackend('1.2.0'), () => {}, skipped)

    await expect(newer.check()).resolves.toEqual({ phase: 'available', version: '1.2.0' })
  })

  it('records the skipped version as one JSON file and reads it back', async () => {
    const file = join(directory, 'nested', 'update-skip.json')
    const store = new DesktopUpdateSkipStore(file)
    await expect(store.read()).resolves.toBeUndefined()

    await store.remember('1.1.0')

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ skippedVersion: '1.1.0' })
    const reopened = new DesktopUpdateSkipStore(file)
    await expect(reopened.read()).resolves.toBe('1.1.0')
  })

  it('reports no skipped version for a corrupt, wrong-shaped, or unreadable file', async () => {
    const corrupt = join(directory, 'corrupt.json')
    await writeFile(corrupt, '{ not json', 'utf8')
    await expect(new DesktopUpdateSkipStore(corrupt).read()).resolves.toBeUndefined()

    const wrongShape = join(directory, 'wrong-shape.json')
    await writeFile(wrongShape, JSON.stringify({ skippedVersion: 7 }), 'utf8')
    await expect(new DesktopUpdateSkipStore(wrongShape).read()).resolves.toBeUndefined()

    const directoryPath = join(directory, 'a-directory')
    await writeFile(join(directory, 'placeholder'), '', 'utf8')
    await rm(directoryPath, { force: true })
    await expect(new DesktopUpdateSkipStore(directoryPath).read()).resolves.toBeUndefined()
  })

  it('retains the skipped version for this process when the record cannot be written', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'placeholder', 'update-skip.json'))
    await store.remember('1.1.0')

    await expect(store.read()).resolves.toBe('1.1.0')
  })
})
