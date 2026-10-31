/**
 * The workstation's asynchronous half: listing directories into the tree,
 * loading a file into its tab, and writing an edited buffer back.
 *
 * The component never awaits anything. It calls `openDirectory`, `toggleDirectory`,
 * `openFile`, `focusTab`, `editTab`, `saveTab`, and `closeTab` for what it draws,
 * and this face performs the Remote call and writes the outcome through the
 * store's own actions — the Slot-standard `inject` shape, so the Session id is
 * resolved by the framework and the write set stays the store's.
 *
 * One directory has one listing in force: asking again retires the request still
 * in flight for it, whose settlement then writes nothing. The same holds for one
 * tab's read and write, where one generation per path retires the last request.
 * Cleanup rides the owner's `signal`: a settlement after the abort writes nothing.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileMutation } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { imageMediaType } from './paths.ts'
import type { TabImage, WorkstationActions } from './store.ts'

/**
 * Write one file's complete text back to the Host.
 *
 * The generated Client Remote does not carry this verb yet; declaring it here
 * lets the package compile against a Host that has it and against one that does
 * not, because the call is the only place the shape is needed.
 */
export type WorkspaceFileWrite = (
  sessionId: SessionId,
  path: string,
  text: string,
  signal?: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileMutation>>

/** The `workspaceFiles` verbs the Host's generated client declares today. */
export type WorkspaceFilesHostRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read' | 'readBytes'>
}

/**
 * The slice of the Client Remote face this package calls: the listing, page-read,
 * and byte-read verbs, plus the write verb declared structurally above.
 */
export type WorkspaceFilesRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read' | 'readBytes'> & {
    readonly write: WorkspaceFileWrite
  }
}

/** The gestures the tree and the tabs perform, as the component calls them. */
export interface WorkstationFace {
  /** List one directory, when its level is not loaded yet. */
  readonly openDirectory: (path: string) => void
  /**
   * Open or close one directory's level.
   * @param path - absolute directory path.
   * @param expanded - whether the tree currently draws it open.
   */
  readonly toggleDirectory: (path: string, expanded: boolean) => void
  /** Open one file in its own tab, reading it when the tab is new. */
  readonly openFile: (path: string) => void
  /**
   * Focus an already open tab.
   * @param path - absolute file path.
   */
  readonly focusTab: (path: string) => void
  /**
   * Replace one tab's buffer from the editor.
   * @param path - absolute file path.
   * @param text - the editor's whole buffer.
   */
  readonly editTab: (path: string, text: string) => void
  /**
   * Write one tab's buffer to the Host.
   * @param path - absolute file path.
   * @param text - the buffer to save.
   */
  readonly saveTab: (path: string, text: string) => void
  /**
   * Close one tab, saving the buffer first when it is dirty.
   * @param path - absolute file path.
   * @param text - the buffer to save when dirty.
   * @param dirty - whether the buffer differs from the Host's copy.
   */
  readonly closeTab: (path: string, text: string, dirty: boolean) => void
}

/** What `apply` hands the slot as its inject face. */
export interface WorkstationInject extends WorkstationFace {
  /** The Session on screen, as a hook source for the components. */
  readonly hooks: { readonly sessionId: { readonly getSnapshot: () => SessionId | undefined; readonly subscribe: (listener: () => void) => () => void } }
}

/** How the face reaches the Session on screen and the Remote namespace. */
export interface WorkstationFaceOptions {
  /** The Client Remote face carrying `workspaceFiles`. */
  readonly remote: WorkspaceFilesHostRemote
  /** The Session currently shown in the main column. */
  readonly sessionId: () => SessionId | undefined
  /** The owner's lifetime; settlements after it aborts write nothing. */
  readonly signal: AbortSignal
}

/** What one tab's load settled into. */
type Loaded =
  | { readonly state: 'text'; readonly text: string }
  | { readonly state: 'image'; readonly image: TabImage }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'retired' }

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
    // The Host's generated client has no write verb yet, while the editing
    // face needs one. This is the deliberate downcast to the editing surface:
    // a Host without the verb makes the call throw, which `persist` reports as
    // a save failure instead of losing the buffer.
    const remote = options.remote as WorkspaceFilesRemote
    /** One generation per directory path, so a newer listing retires the last. */
    const generations = new Map<string, number>()
    /** One generation per tab read, so a newer read of a path retires the last. */
    const reads = new Map<string, number>()
    /** One generation per tab write, so an older settlement cannot win. */
    const writes = new Map<string, number>()
    /** Monotonic across clears, so a re-used path never re-uses a generation. */
    let sequence = 0
    /** The Session the store currently holds levels and tabs for. */
    let bound: SessionId | undefined

    /**
     * Resolve the Session to call with, dropping a tree and tabs that belong to another.
     * @returns the Session id, or `undefined` while none is selected.
     */
    const target = (): SessionId | undefined => {
      const session = options.sessionId()
      if (session === undefined) return undefined
      if (bound !== session) {
        bound = session
        generations.clear()
        reads.clear()
        writes.clear()
        actions.reset()
      }
      return session
    }

    /**
     * List one directory into its level.
     * @param session - the Session whose workspace is listed.
     * @param path - absolute directory path.
     */
    const list = (session: SessionId, path: string): void => {
      const generation = (sequence += 1)
      generations.set(path, generation)
      actions.loading(path)
      void remote.workspaceFiles.list(session, path, options.signal).then((result) => {
        if (options.signal.aborted || generations.get(path) !== generation) return
        if (result.ok) {
          actions.loaded(path, { entries: result.value.entries, truncated: result.value.truncated })
        } else {
          actions.failed(path, result.error)
        }
      })
    }

    /**
     * Read one file's whole text, page by page, or its bytes when it is an image.
     * @param session - the Session whose workspace holds the file.
     * @param path - absolute file path.
     * @param retired - whether a newer gesture has taken this path over.
     * @returns the load's outcome, or `retired` when the walk should stop.
     */
    const load = async (session: SessionId, path: string, retired: () => boolean): Promise<Loaded> => {
      if (imageMediaType(path) !== null) {
        const result = await remote.workspaceFiles.readBytes(session, path, {}, options.signal)
        if (retired()) return { state: 'retired' }
        if (!result.ok) return { state: 'failed', message: result.error.message }
        return {
          state: 'image',
          image: { bytes: result.value.data, size: result.value.bytes ?? result.value.data.byteLength },
        }
      }
      // An editor needs the complete file: a half-loaded buffer would save a
      // truncated file, so every page is read before the tab becomes editable.
      const pages: string[] = []
      let offset: number | undefined
      for (;;) {
        const result = await remote.workspaceFiles.read(
          session,
          path,
          offset === undefined ? {} : { offset },
          options.signal,
        )
        if (retired()) return { state: 'retired' }
        if (!result.ok) return { state: 'failed', message: result.error.message }
        pages.push(result.value.text)
        if (result.value.eof) break
        offset = result.value.offset + result.value.lines
      }
      return { state: 'text', text: pages.join('\n') }
    }

    /**
     * Write one tab's buffer to the Host.
     * @param session - the Session whose workspace holds the file.
     * @param path - absolute file path.
     * @param text - the buffer to write.
     * @returns `true` when the Host accepted the write.
     */
    const persist = async (session: SessionId, path: string, text: string): Promise<boolean> => {
      const generation = (sequence += 1)
      writes.set(path, generation)
      let message: string | null = null
      try {
        const result = await remote.workspaceFiles.write(session, path, text, options.signal)
        if (!result.ok) message = result.error.message
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause)
      }
      if (options.signal.aborted || writes.get(path) !== generation) return false
      if (message !== null) {
        actions.tabFailed(path, message, 'save')
        return false
      }
      actions.tabSaved(path, text)
      return true
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
        const generation = (sequence += 1)
        reads.set(path, generation)
        actions.tabOpened(path)
        const retired = (): boolean => options.signal.aborted || reads.get(path) !== generation
        void load(session, path, retired).then((loaded) => {
          if (retired() || loaded.state === 'retired') return
          if (loaded.state === 'failed') {
            actions.tabFailed(path, loaded.message, 'read')
            return
          }
          if (loaded.state === 'image') actions.tabImageLoaded(path, loaded.image)
          else actions.tabLoaded(path, loaded.text)
        })
      },
      focusTab: (path) => {
        actions.tabFocused(path)
      },
      editTab: (path, text) => {
        actions.tabEdited(path, text)
      },
      saveTab: (path, text) => {
        const session = target()
        if (session === undefined) return
        void persist(session, path, text)
      },
      closeTab: (path, text, dirty) => {
        // Closing a dirty tab is the user's save gesture: write first and only
        // then drop the tab, so a refused write leaves the work in place.
        const session = target()
        if (session === undefined || !dirty) {
          actions.tabClosed(path)
          return
        }
        void persist(session, path, text).then((saved) => {
          if (saved) actions.tabClosed(path)
        })
      },
    }
  }
}
