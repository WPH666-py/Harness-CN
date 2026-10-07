/**
 * A `workspaceFiles` namespace whose every verb answers when the spec says so.
 *
 * The package binds these six verbs through `createList`, so these mocks are
 * exactly where a gesture's Remote call lands: a spec asserts the verb and its
 * arguments there, then settles it to drive what the face writes next. A
 * listing answers with the entries and the truncation flag the tree keeps; the
 * endpoint's own workspace-relative path belongs to the adapter's spec.
 */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  WorkspaceDirectoryListing, WorkspaceFileMutation, WorkspaceFileRemoval,
} from '@deepseek-ai/dsh-api-workspace-files/types'
import { createList } from '../src/client/face.ts'
import type {
  WorkspaceFilesBound, WorkspaceFilesListRemote, WorkspaceFilesMutationRemote, WorkspaceFilesMutations,
} from '../src/client/face.ts'
import type { DirLevel } from '../src/client/store.ts'

/** One listing awaiting the spec's answer. */
interface PendingList {
  readonly path: string
  resolve(result: RemoteResult<WorkspaceDirectoryListing>): void
}

/** One entry-producing call awaiting the spec's answer. */
interface PendingEntry {
  readonly verb: string
  resolve(result: RemoteResult<WorkspaceFileMutation>): void
}

/** One removal awaiting the spec's answer. */
interface PendingRemoval {
  resolve(result: RemoteResult<WorkspaceFileRemoval>): void
}

/** The scripted namespace: the mocks the tree calls, and the hands that settle them. */
export interface ScriptedFiles {
  /** The Remote face the package binds, in the shape `createList` accepts. */
  readonly remote: WorkspaceFilesListRemote & WorkspaceFilesMutationRemote
  /** The bound verbs the face performs, as the registration binds them. */
  readonly bound: WorkspaceFilesBound
  readonly list: Mock<WorkspaceFilesListRemote['workspaceFiles']['list']>
  readonly createDirectory: Mock<WorkspaceFilesMutations['createDirectory']>
  readonly createFile: Mock<WorkspaceFilesMutations['createFile']>
  readonly remove: Mock<WorkspaceFilesMutations['remove']>
  readonly copy: Mock<WorkspaceFilesMutations['copy']>
  readonly move: Mock<WorkspaceFilesMutations['move']>
  /**
   * Settle the oldest outstanding listing and let its store write land.
   * @param result - the entries the endpoint answers with.
   */
  readonly settle: (result: RemoteResult<DirLevel>) => Promise<void>
  /**
   * Settle the newest outstanding listing first, so an older one can arrive after it.
   * @param result - the entries the endpoint answers with.
   */
  readonly settleLatest: (result: RemoteResult<DirLevel>) => Promise<void>
  /** Paths of listings not yet settled, oldest first. */
  readonly outstanding: () => readonly string[]
  /**
   * Settle the oldest outstanding call that produces an entry: a create, a
   * copy, or a move.
   * @param result - the produced entry, or the refusal.
   */
  readonly settleEntry: (result: RemoteResult<WorkspaceFileMutation>) => Promise<void>
  /**
   * Settle the oldest outstanding removal.
   * @param result - the removed workspace path, or the refusal.
   */
  readonly settleRemoval: (result: RemoteResult<WorkspaceFileRemoval>) => Promise<void>
}

/** Flush the microtask queue a settled promise's continuation runs on. */
async function settleInto(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Build a namespace whose every verb stays pending until the spec settles it.
 * @returns the scripted verbs, the face they are bound to, and the settling hands.
 */
export function scriptedFiles(): ScriptedFiles {
  const pending: PendingList[] = []
  const pendingEntries: PendingEntry[] = []
  const pendingRemovals: PendingRemoval[] = []
  const list = vi.fn<WorkspaceFilesListRemote['workspaceFiles']['list']>((_sessionId, path) =>
    new Promise((resolve) => { pending.push({ path, resolve }) }))
  const createDirectory = vi.fn<WorkspaceFilesMutations['createDirectory']>(() =>
    new Promise((resolve) => { pendingEntries.push({ verb: 'createDirectory', resolve }) }))
  const createFile = vi.fn<WorkspaceFilesMutations['createFile']>(() =>
    new Promise((resolve) => { pendingEntries.push({ verb: 'createFile', resolve }) }))
  const remove = vi.fn<WorkspaceFilesMutations['remove']>(() =>
    new Promise((resolve) => { pendingRemovals.push({ resolve }) }))
  const copy = vi.fn<WorkspaceFilesMutations['copy']>(() =>
    new Promise((resolve) => { pendingEntries.push({ verb: 'copy', resolve }) }))
  const move = vi.fn<WorkspaceFilesMutations['move']>(() =>
    new Promise((resolve) => { pendingEntries.push({ verb: 'move', resolve }) }))
  const takeList = async (call: PendingList | undefined, result: RemoteResult<DirLevel>): Promise<void> => {
    if (call === undefined) throw new Error('no outstanding listing to settle')
    call.resolve(result.ok ? { ok: true, value: { path: '', ...result.value } } : result)
    await settleInto()
  }
  const remote = { workspaceFiles: { list, createDirectory, createFile, remove, copy, move } }
  return {
    remote,
    bound: createList(remote),
    list,
    createDirectory,
    createFile,
    remove,
    copy,
    move,
    settle: result => takeList(pending.shift(), result),
    settleLatest: result => takeList(pending.pop(), result),
    outstanding: () => pending.map(call => call.path),
    settleEntry: async (result) => {
      const call = pendingEntries.shift()
      if (call === undefined) throw new Error('no outstanding entry-producing call to settle')
      call.resolve(result)
      await settleInto()
    },
    settleRemoval: async (result) => {
      const call = pendingRemovals.shift()
      if (call === undefined) throw new Error('no outstanding removal to settle')
      call.resolve(result)
      await settleInto()
    },
  }
}
