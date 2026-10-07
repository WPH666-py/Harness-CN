/**
 * The tree's asynchronous half: listing directories into the store, and the
 * file operations a file manager adds.
 *
 * The component never awaits anything. It calls `start` / `load` / `toggle` for
 * what it draws and `createEntry` / `removeEntry` / `pasteEntry` for what the
 * reader changes, and this face performs the Remote call and writes the outcome
 * through the store's own actions — the Slot-standard `inject` shape, so the
 * session id is resolved by the framework and the write set stays the store's.
 *
 * The verbs are bound here to the Client Remote face: the tree keys every level
 * by absolute path and hands the endpoint that same absolute path; the endpoint
 * answers with the directory's workspace-relative path as well, which the tree
 * has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset, the refresh a landed mutation
 * performs — retires the listing still in flight for it, whose settlement then
 * writes nothing. Cleanup rides the owner's `signal`: a request is not made for
 * a record that already ended, a settlement after the abort writes nothing, and
 * when the record goes away the bucket and the tab's listing bookkeeping are
 * forgotten.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, FilesClipboard, NewEntryDraft, createFilesStore } from './store.ts'

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * The five `workspaceFiles` verbs that change what the tree shows, exactly as
 * the Host's generated client declares them.
 */
export type WorkspaceFilesMutations = Pick<
  ClientRemote['workspaceFiles'],
  'createDirectory' | 'createFile' | 'remove' | 'copy' | 'move'
>

/**
 * The slice of the Client Remote face this package mutates through: the
 * `workspaceFiles` namespace's five mutating verbs.
 */
export type WorkspaceFilesMutationRemote = {
  readonly workspaceFiles: WorkspaceFilesMutations
}

/**
 * Every `workspaceFiles` verb this package performs, bound to one Remote face.
 *
 * Each verb is forwarded rather than captured, so a namespace that remounts
 * hands the tree the live method on its next call; only the listing narrows,
 * because the tree stores the entries and the truncation flag and drops the
 * endpoint's workspace-relative path.
 */
export interface WorkspaceFilesBound extends WorkspaceFilesMutations {
  /** The listing, narrowed to what one level keeps. */
  readonly list: ListWorkspaceDirectory
}

/**
 * Bind the tree's Remote verbs to one face.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing and the five mutating verbs, as the tree performs them.
 */
export function createList(remote: WorkspaceFilesListRemote & WorkspaceFilesMutationRemote): WorkspaceFilesBound {
  return {
    list: async (sessionId, path, signal) => {
      const result = await remote.workspaceFiles.list(sessionId, path, signal)
      if (!result.ok) return result
      return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
    },
    createDirectory: (sessionId, path, name, signal) =>
      remote.workspaceFiles.createDirectory(sessionId, path, name, signal),
    createFile: (sessionId, path, name, signal) =>
      remote.workspaceFiles.createFile(sessionId, path, name, signal),
    remove: (sessionId, path, options, signal) =>
      remote.workspaceFiles.remove(sessionId, path, options, signal),
    copy: (sessionId, fromPath, toPath, signal) =>
      remote.workspaceFiles.copy(sessionId, fromPath, toPath, signal),
    move: (sessionId, fromPath, toPath, signal) =>
      remote.workspaceFiles.move(sessionId, fromPath, toPath, signal),
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/**
 * The directory one entry sits in, the inverse of {@link childPath}.
 * @param path - absolute path of an entry under the tree's root.
 * @returns the absolute path of its parent directory.
 */
export function parentPath(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

/**
 * The name one entry keeps when a paste places it somewhere else.
 * @param path - absolute path of an entry.
 * @returns its last `/`-separated segment.
 */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, listing it the first time it opens.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param loaded - whether this level already has state.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, path: string, loaded: boolean, signal: AbortSignal) => void
  /**
   * Create one entry under a directory and list that directory again.
   *
   * The name input stays open until the creation lands, so a refused name — one
   * already taken, most often — keeps what the reader typed next to the line
   * saying why.
   * @param tabId - the tab being drawn.
   * @param parent - absolute path of the directory the entry is created in.
   * @param name - one path segment.
   * @param kind - the entry to create.
   * @param signal - the tab record's lifetime.
   */
  readonly createEntry: (
    tabId: TabId, parent: string, name: string, kind: NewEntryDraft['kind'], signal: AbortSignal,
  ) => void
  /**
   * Remove one entry and list its directory again.
   * @param tabId - the tab being drawn.
   * @param path - absolute path of the entry to remove.
   * @param recursive - whether a directory goes with everything inside it.
   * @param signal - the tab record's lifetime.
   */
  readonly removeEntry: (tabId: TabId, path: string, recursive: boolean, signal: AbortSignal) => void
  /**
   * Paste one clipboard entry into a directory under the name it already has.
   *
   * A landed `cut` releases the clipboard and forgets the source subtree; a
   * `copy` leaves both alone.
   * @param tabId - the tab being drawn.
   * @param clipboard - the entry and the verb the paste performs.
   * @param destination - absolute path of the directory to place it in.
   * @param signal - the tab record's lifetime.
   */
  readonly pasteEntry: (
    tabId: TabId, clipboard: FilesClipboard, destination: string, signal: AbortSignal,
  ) => void
}

/**
 * Bind the tree's face to one set of bound Remote verbs.
 * @param remote - the listing and the mutating verbs, bound to one Remote face.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  remote: WorkspaceFilesBound,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = (tabId: TabId, path: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      void remote.list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
      })
    }
    /**
     * Apply one settled mutation: its failure becomes the tab's notice, and its
     * success clears the notice and runs the refresh that shows the change.
     * @param tabId - the tab being drawn.
     * @param signal - the tab record's lifetime.
     * @param result - the settled Remote result.
     * @param landed - what a successful mutation refreshes.
     */
    const settle = (
      tabId: TabId,
      signal: AbortSignal,
      result: RemoteResult<unknown>,
      landed: () => void,
    ): void => {
      // The record can end while the call is out; its bucket left with it, so
      // this settlement has nothing left to write.
      if (signal.aborted) return
      if (!result.ok) {
        actions.noticed(tabId, result.error)
        return
      }
      actions.noticed(tabId, null)
      landed()
    }
    return {
      start(tabId, root, signal) {
        actions.start(tabId, root)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        load(tabId, root, signal)
      },
      load,
      toggle(tabId, path, loaded, signal) {
        actions.toggled(tabId, path)
        if (!loaded) load(tabId, path, signal)
      },
      createEntry(tabId, parent, name, kind, signal) {
        if (signal.aborted) return
        const created = kind === 'directory'
          ? remote.createDirectory(sessionId, parent, name, signal)
          : remote.createFile(sessionId, parent, name, signal)
        void created.then((result) => {
          settle(tabId, signal, result, () => {
            actions.drafted(tabId, null)
            load(tabId, parent, signal)
          })
        })
      },
      removeEntry(tabId, path, recursive, signal) {
        if (signal.aborted) return
        void remote.remove(sessionId, path, { recursive }, signal).then((result) => {
          settle(tabId, signal, result, () => {
            actions.pruned(tabId, path)
            load(tabId, parentPath(path), signal)
          })
        })
      },
      pasteEntry(tabId, clipboard, destination, signal) {
        if (signal.aborted) return
        const toPath = childPath(destination, baseName(clipboard.path))
        const placed = clipboard.mode === 'copy'
          ? remote.copy(sessionId, clipboard.path, toPath, signal)
          : remote.move(sessionId, clipboard.path, toPath, signal)
        void placed.then((result) => {
          settle(tabId, signal, result, () => {
            const source = parentPath(clipboard.path)
            if (clipboard.mode === 'cut') {
              // A cut that landed has nothing left to paste, and the source
              // directory it left needs the same refresh as the destination.
              actions.clipboarded(tabId, null)
              actions.pruned(tabId, clipboard.path)
              if (source !== destination) load(tabId, source, signal)
            }
            load(tabId, destination, signal)
          })
        })
      },
    }
  }
}
