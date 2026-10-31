/**
 * The workstation's asynchronous half: listing directories into the store and
 * paging file text into the viewer.
 *
 * The component never awaits anything. It calls `openDirectory`, `toggleDirectory`,
 * `openFile`, and `loadMore` for what it draws, and this face performs the Remote
 * call and writes the outcome through the store's own actions — the Slot-standard
 * `inject` shape, so the Session id is resolved by the framework and the write set
 * stays the store's.
 *
 * One directory has one listing in force: asking again retires the request still
 * in flight for it, whose settlement then writes nothing. The same holds for the
 * viewer, where one generation covers every page of every file. Cleanup rides the
 * owner's `signal`: a settlement after the abort writes nothing.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { linesOf } from './paths.ts'
import type { WorkstationActions } from './store.ts'

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's listing and read verbs, exactly as the Host's generated client
 * declares them.
 */
export type WorkspaceFilesRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read'>
}

/** The gestures the tree and the viewer perform, as the component calls them. */
export interface WorkstationFace {
  /** List one directory, when its level is not loaded yet. */
  readonly openDirectory: (path: string) => void
  /**
   * Open or close one directory's level.
   * @param path - workspace-relative directory path.
   * @param expanded - whether the tree currently draws it open.
   */
  readonly toggleDirectory: (path: string, expanded: boolean) => void
  /** Start the viewer on one file, reading its first page. */
  readonly openFile: (path: string) => void
  /**
   * Append the next page of the open file.
   * @param path - workspace-relative file path the viewer has open.
   * @param offset - line offset the page starts at.
   */
  readonly loadMore: (path: string, offset: number) => void
}

/** What `apply` hands the slot as its inject face. */
export interface WorkstationInject extends WorkstationFace {
  /** The Session on screen, as a hook source for the components. */
  readonly hooks: { readonly sessionId: { readonly getSnapshot: () => SessionId | undefined; readonly subscribe: (listener: () => void) => () => void } }
}

/** How the face reaches the Session on screen and the Remote namespace. */
export interface WorkstationFaceOptions {
  /** The Client Remote face carrying `workspaceFiles`. */
  readonly remote: WorkspaceFilesRemote
  /** The Session currently shown in the main column. */
  readonly sessionId: () => SessionId | undefined
  /** The owner's lifetime; settlements after it aborts write nothing. */
  readonly signal: AbortSignal
}

/**
 * Build the face over one Remote face and one Session source.
 *
 * The store instance is minted by the registration, so the actions arrive with
 * the inject factory rather than here.
 * @param options - the Remote namespace, the Session source, and the owner's signal.
 * @returns a factory the slot calls with the store's bound actions.
 */
export function workstationFace(
  options: WorkstationFaceOptions,
): (actions: WorkstationActions) => WorkstationFace {
  return (actions) => {
    /** One generation per directory path, so a newer listing retires the last. */
    const generations = new Map<string, number>()
    /** One generation for the viewer, covering every page of every file. */
    let pageGeneration = 0
    /** The Session the store currently holds levels for. */
    let bound: SessionId | undefined

    /**
     * Resolve the Session to call with, dropping a tree that belongs to another.
     * @returns the Session id, or `undefined` while none is selected.
     */
    const target = (): SessionId | undefined => {
      const session = options.sessionId()
      if (session === undefined) return undefined
      if (bound !== session) {
        bound = session
        generations.clear()
        pageGeneration += 1
        actions.reset()
      }
      return session
    }

    /**
     * List one directory into its level.
     * @param session - the Session whose workspace is listed.
     * @param path - workspace-relative directory path.
     */
    const list = (session: SessionId, path: string): void => {
      const generation = (generations.get(path) ?? 0) + 1
      generations.set(path, generation)
      actions.loading(path)
      void options.remote.workspaceFiles.list(session, path, options.signal).then((result) => {
        if (options.signal.aborted || generations.get(path) !== generation) return
        if (result.ok) {
          actions.loaded(path, { entries: result.value.entries, truncated: result.value.truncated })
        } else {
          actions.failed(path, result.error)
        }
      })
    }

    /**
     * Read one page of a file into the viewer.
     * @param session - the Session whose workspace holds the file.
     * @param path - workspace-relative file path.
     * @param offset - line offset the page starts at.
     * @param first - whether this is the file's first page, which opens the viewer.
     */
    const page = (session: SessionId, path: string, offset: number, first: boolean): void => {
      pageGeneration += 1
      const generation = pageGeneration
      if (first) actions.opened(path)
      else actions.paging()
      void options.remote.workspaceFiles.read(session, path, { offset }, options.signal).then((result) => {
        if (options.signal.aborted || generation !== pageGeneration) return
        if (!result.ok) {
          actions.pageFailed(result.error)
          return
        }
        actions.paged({
          lines: linesOf(result.value.text),
          offset: result.value.offset + result.value.lines,
          eof: result.value.eof,
        })
      })
    }

    return {
      openDirectory: (path) => {
        const session = target()
        if (session === undefined) return
        list(session, path)
      },
      toggleDirectory: (path, expanded) => {
        const session = target()
        if (session === undefined) return
        if (expanded) {
          actions.collapsed(path)
          return
        }
        actions.expanded(path)
        list(session, path)
      },
      openFile: (path) => {
        const session = target()
        if (session === undefined) return
        page(session, path, 0, true)
      },
      loadMore: (path, offset) => {
        const session = target()
        if (session === undefined) return
        page(session, path, offset, false)
      },
    }
  }
}
