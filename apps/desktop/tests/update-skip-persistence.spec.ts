import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import type { DesktopUpdateBackend, DesktopUpdateOffer } from '../src/update-backend.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')
const { DesktopUpdateSkipStore } = await import('../src/update-skip-store.ts')

/**
 * One release offer, as a channel answers when it has a version to install.
 * @param version - version the offer installs.
 * @returns an offer with nothing published about it beyond the version.
 */
function offerOf(version: string): DesktopUpdateOffer {
  return { version, notes: '', publishedAt: '', page: '', size: undefined }
}

/**
 * The state a coordinator publishes for one available release.
 * @param version - version the release channel offered.
 * @returns that state, spelled out so a changed field fails this expectation.
 */
function availableState(version: string): DesktopUpdateState {
  return { phase: 'available', current: '', version, notes: '', publishedAt: '' }
}

/**
 * The state a coordinator publishes once one release is downloaded and ready to install.
 * @param version - version that was installed from.
 * @returns that state, spelled out so a changed field fails this expectation.
 */
function readyState(version: string): DesktopUpdateState {
  return { phase: 'ready', current: '', version, notes: '', publishedAt: '', progress: 1 }
}

/**
 * Build a backend that offers one version and records what it was asked to do.
 * @param version - version the channel offers, undefined when the build is current.
 * @returns stub backend plus its call record.
 */
function offering(version: string | undefined): DesktopUpdateBackend & {
  readonly download: ReturnType<typeof vi.fn>
  readonly install: ReturnType<typeof vi.fn>
} {
  return {
    check: async () => (version === undefined ? undefined : offerOf(version)),
    download: vi.fn(async () => 'verified' as const),
    install: vi.fn(async () => {}),
  } as DesktopUpdateBackend & {
    readonly download: ReturnType<typeof vi.fn>
    readonly install: ReturnType<typeof vi.fn>
  }
}

describe('desktop update skip wiring', () => {
  /** Scratch userData directory each case writes its skip record into. */
  let directory: string
  /** Run-log lines the coordinator reported, which the shell normally owns. */
  let notes: string[]
  /** Published states, in order. */
  let states: DesktopUpdateState[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-cn-skip-wiring-'))
    notes = []
    states = []
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  /**
   * Wire the skip record into a coordinator the way the shell does.
   *
   * The skip value is held in one mutable slot exactly as `main.ts` holds it,
   * so a version skipped during a session is visible to later checks without
   * any extra read.
   * @param backend - release channel the coordinator drives.
   * @param store - durable record of the version the user skipped.
   * @param remembered - slot holding the skipped version the shell compares against.
   * @returns coordinator publishing into this case's state list.
   */
  function coordinatorOver(
    backend: DesktopUpdateBackend,
    store: InstanceType<typeof DesktopUpdateSkipStore>,
    remembered: { version: string | undefined },
  ): InstanceType<typeof DesktopUpdateCoordinator> {
    return new DesktopUpdateCoordinator(
      (state) => {
        states.push(state)
        return state
      },
      async () => {},
      backend,
      () => {},
      {
        remember: (version) => {
          remembered.version = version
          void store.remember(version)
        },
        suppresses: version => version === remembered.version,
      },
      (note) => { notes.push(note) },
    )
  }

  it('stays silent on the automatic path for the skipped version and installs nothing', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    await store.remember('0.1.6')
    const remembered = { version: undefined as string | undefined }
    remembered.version = await store.read()
    const backend = offering('0.1.6')
    const coordinator = coordinatorOver(backend, store, remembered)

    await expect(coordinator.check()).resolves.toEqual({ phase: 'idle', current: '' })
    await expect(coordinator.install()).rejects.toThrow(/no verified update is available/u)
    expect(backend.download).not.toHaveBeenCalled()
  })

  it('offers the same version again when the user checks manually', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    await store.remember('0.1.6')
    const remembered = { version: await store.read() }
    const backend = offering('0.1.6')
    const coordinator = coordinatorOver(backend, store, remembered)

    await expect(coordinator.check(true)).resolves.toEqual(availableState('0.1.6'))
  })

  it('offers a newer version after the user skipped an older one', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    await store.remember('0.1.6')
    const remembered = { version: await store.read() }
    const backend = offering('0.1.7')
    const coordinator = coordinatorOver(backend, store, remembered)

    await expect(coordinator.check()).resolves.toEqual(availableState('0.1.7'))
  })

  it('records a version skipped during this session for the next automatic check', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    const remembered = { version: undefined as string | undefined }
    const backend = offering('0.1.6')
    const coordinator = coordinatorOver(backend, store, remembered)

    await expect(coordinator.check()).resolves.toEqual(availableState('0.1.6'))
    // What the dialog's skip button runs, before the automatic check on the next launch.
    remembered.version = '0.1.6'
    await store.remember('0.1.6')
    const relaunched = coordinatorOver(offering('0.1.6'), store, { version: await store.read() })

    await expect(relaunched.check()).resolves.toEqual({ phase: 'idle', current: '' })
    expect(notes).toEqual(['release channel offers 0.1.6'])
  })

  it('reports how the downloaded installer was vouched for', async () => {
    const store = new DesktopUpdateSkipStore(join(directory, 'update-skip.json'))
    const remembered = { version: undefined as string | undefined }
    const unverified: DesktopUpdateBackend = {
      check: async () => offerOf('0.1.6'),
      download: async () => 'unverified',
      install: async () => {},
    }
    const coordinator = coordinatorOver(unverified, store, remembered)

    await coordinator.check()
    await expect(coordinator.install()).resolves.toEqual(readyState('0.1.6'))

    expect(notes).toEqual([
      'release channel offers 0.1.6',
      'desktop update 0.1.6 downloaded (unverified)',
    ])
  })
})
