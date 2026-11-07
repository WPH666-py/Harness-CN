/**
 * The workstation's asynchronous half: listing directories into the tree,
 * loading a file into its tab, and writing an edited buffer back.
 *
 * The component never awaits anything. It calls `openDirectory`, `toggleDirectory`,
 * `openFile`, `focusTab`, `editTab`, `saveTab`, `closeTab`, and `searchFiles` for
 * what it draws, and this face performs the call and writes the outcome through
 * the store's own actions — the Slot-standard `inject` shape, so the Session id is
 * resolved by the framework and the write set stays the store's.
 *
 * One directory has one listing in force: asking again retires the request still
 * in flight for it, whose settlement then writes nothing. The same holds for one
 * tab's read and write, where one generation per path retires the last request.
 * Cleanup rides the owner's `signal`: a settlement after the abort writes nothing.
 *
 * A current remote host takes the whole seat over: every path then names a file
 * on that machine, so the listing, the read, the write, and the search go to the
 * plugin's routes instead of the workspace Remote. The local branch is untouched
 * while no host is current, which is the state a seat that never ran the SSH
 * plugin stays in.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryEntry, WorkspaceFileMutation } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { decodeFile } from './encoding.ts'
import type { FileEncoding } from './encoding.ts'
import { imageMediaType } from './paths.ts'
import type { RemoteFiles, RemoteHostsView } from './remote.ts'
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
   * @param version - the remote version the tab read, `null` for a local file.
   */
  readonly saveTab: (path: string, text: string, version: string | null) => void
  /**
   * Close one tab, saving the buffer first when it is dirty.
   * @param path - absolute file path.
   * @param text - the buffer to save when dirty.
   * @param dirty - whether the buffer differs from the Host's copy.
   * @param version - the remote version the tab read, `null` for a local file.
   */
  readonly closeTab: (path: string, text: string, dirty: boolean, version: string | null) => void
  /**
   * Search the current host for files whose name contains a query.
   *
   * Only a remote host has this: the workspace Remote has no search verb, so a
   * local seat draws no search control at all.
   * @param query - text a file name must contain.
   * @param root - the absolute host path the tree hangs from.
   */
  readonly searchFiles: (query: string, root: string) => void
}

/** What `apply` hands the slot as its inject face. */
export interface WorkstationInject extends WorkstationFace {
  /**
   * Leave the seat and go back to the three-column desk.
   *
   * The full-screen stage hides the Conversation, and the Conversation header is where the stage
   * control lives, so the seat needs its own way out; the desk layout is the one place where every
   * control is visible again.
   */
  readonly leaveSeat: () => void
  /**
   * Show or hide the Conversation column beside the editor.
   *
   * The two stages of the seat differ by exactly this column, and the header that carries the stage
   * control is inside it, so the gesture has to live in the seat to be available in both.
   */
  readonly toggleAi: () => void
  /**
   * Stop working on the current host, so the seat shows this machine again.
   *
   * A server page keeps its own header control, but that header only exists
   * while a Conversation with content is open; a fresh session would otherwise
   * strand the user on the server.
   */
  readonly leaveServer: () => void
  /** The Session on screen, as a hook source for the components. */
  readonly hooks: {
    readonly sessionId: {
      readonly getSnapshot: () => SessionId | undefined
      readonly subscribe: (listener: () => void) => () => void
    }
    /** The host the server manager made current, as a hook source for the components. */
    readonly remoteHosts: {
      readonly getSnapshot: () => RemoteHostsView
      readonly subscribe: (listener: () => void) => () => void
    }
  }
}

/** How the face reaches the Session on screen, the Remote namespace, and a remote host. */
export interface WorkstationFaceOptions {
  /** The Client Remote face carrying `workspaceFiles`. */
  readonly remote: WorkspaceFilesHostRemote
  /** The same-origin calls that browse a remote host. */
  readonly remoteFiles: RemoteFiles
  /** The Session currently shown in the main column. */
  readonly sessionId: () => SessionId | undefined
  /** The host the tree follows, `null` while it browses the local workspace. */
  readonly remoteHostId: () => string | null
  /** The owner's lifetime; settlements after it aborts write nothing. */
  readonly signal: AbortSignal
}

/** What one tab's load settled into. */
type Loaded =
  | {
    readonly state: 'text'
    readonly text: string
    readonly encoding: FileEncoding
    /** The host's content version at the read; `null` for a local file. */
    readonly version: string | null
  }
  | { readonly state: 'image'; readonly image: TabImage }
  | { readonly state: 'binary'; readonly size: number }
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
    /** The host the store currently holds levels and tabs for. */
    let boundHost: string | null = null
    /** One generation per search, so a newer query retires the last. */
    let searchGeneration = 0

    /**
     * The host the tree follows, as of this gesture.
     *
     * A host change retires the generations of the previous one: a listing that
     * answers after the switch would otherwise write entries for a machine the
     * tree no longer shows.
     * @returns the host id, or `null` while the local workspace is on screen.
     */
    const host = (): string | null => {
      const current = options.remoteHostId()
      if (current !== boundHost) {
        boundHost = current
        generations.clear()
        reads.clear()
        writes.clear()
      }
      return current
    }

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
     * List one directory of the current host into its level.
     *
     * The rows are the same name/type pairs the local listing answers with, so
     * the tree draws both with one component; the absolute path is rebuilt from
     * the parent they were listed under, so the tree, the reader and the writer
     * all speak one path vocabulary.
     * @param hostId - the host to list.
     * @param path - absolute host directory path.
     */
    const listRemote = (hostId: string, path: string): void => {
      const generation = (sequence += 1)
      generations.set(path, generation)
      actions.remoteLoading(path)
      void options.remoteFiles.list(hostId, path).then((answer) => {
        if (options.signal.aborted || generations.get(path) !== generation) return
        // A listing that answers after the server manager switched hosts
        // describes a machine the tree no longer shows.
        if (options.remoteHostId() !== hostId) return
        if (!answer.ok) {
          actions.remoteFailed(path, answer.failure.message)
          return
        }
        const entries: WorkspaceDirectoryEntry[] = answer.value.entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          ...(entry.size === null ? {} : { size: entry.size }),
        }))
        actions.remoteLoaded(path, { entries, truncated: answer.value.truncated })
      })
    }

    /**
     * Read one file: its whole text page by page, or its bytes when it is an
     * image or when the text verb refuses it as not UTF-8.
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
        if (!result.ok) {
          // The text verb refuses anything that is not valid UTF-8. The bytes
          // still decide what the tab can show, so a refusal for that reason is
          // not the tab's failure — only a failed byte read is.
          if (result.error.code !== 'workspace-file/not-text') {
            return { state: 'failed', message: result.error.message }
          }
          const bytes = await remote.workspaceFiles.readBytes(session, path, {}, options.signal)
          if (retired()) return { state: 'retired' }
          if (!bytes.ok) return { state: 'failed', message: bytes.error.message }
          const decoded = decodeFile(bytes.value.data)
          if (decoded.kind === 'binary') {
            return { state: 'binary', size: bytes.value.bytes ?? bytes.value.data.byteLength }
          }
          return { state: 'text', text: decoded.text, encoding: decoded.encoding, version: null }
        }
        pages.push(result.value.text)
        if (result.value.eof) break
        offset = result.value.offset + result.value.lines
      }
      return { state: 'text', text: pages.join('\n'), encoding: 'utf-8', version: null }
    }

    /**
     * Read one file from the current host.
     *
     * The route answers the whole file as UTF-8 text, so a tab is readable in one
     * call; the decode chain still runs over those bytes to strip a BOM and to
     * answer "binary" for content the editor cannot show.
     * @param hostId - the host holding the file.
     * @param path - absolute host file path.
     * @param retired - whether a newer gesture has taken this path over.
     * @returns the load's outcome, or `retired` when the gesture was replaced.
     */
    const loadRemote = async (hostId: string, path: string, retired: () => boolean): Promise<Loaded> => {
      const answer = await options.remoteFiles.read(hostId, path)
      if (retired()) return { state: 'retired' }
      if (!answer.ok) return { state: 'failed', message: answer.failure.message }
      if (imageMediaType(path) !== null) return { state: 'binary', size: answer.value.size }
      const decoded = decodeFile(new TextEncoder().encode(answer.value.text))
      if (decoded.kind === 'binary') return { state: 'binary', size: answer.value.size }
      return { state: 'text', text: decoded.text, encoding: decoded.encoding, version: answer.value.version }
    }

    /**
     * Start one read and report whether it is still the current one.
     * @param path - absolute file path.
     * @returns the retirement check for that read.
     */
    const beginRead = (path: string): (() => boolean) => {
      const generation = (sequence += 1)
      reads.set(path, generation)
      return () => options.signal.aborted || reads.get(path) !== generation
    }

    /**
     * Apply one read's outcome to its tab.
     * @param path - absolute file path.
     * @param loading - the read's promise.
     * @param retired - whether the read has been replaced.
     */
    const settleTab = (path: string, loading: Promise<Loaded>, retired: () => boolean): void => {
      void loading.then((loaded) => {
        if (retired() || loaded.state === 'retired') return
        if (loaded.state === 'failed') {
          actions.tabFailed(path, loaded.message, 'read')
          return
        }
        if (loaded.state === 'image') actions.tabImageLoaded(path, loaded.image)
        else if (loaded.state === 'binary') actions.tabBinaryLoaded(path, loaded.size)
        else actions.tabLoaded(path, loaded.text, loaded.encoding, loaded.version)
      })
    }

    /**
     * Write one buffer into the local workspace.
     * @param session - the Session whose workspace holds the file.
     * @param path - absolute file path.
     * @param text - the buffer to write.
     * @returns the write's outcome, with no version because local files have none.
     */
    const writeLocal = (session: SessionId, path: string, text: string) =>
      remote.workspaceFiles.write(session, path, text, options.signal).then((result) => result.ok
        ? { ok: true as const, version: null }
        : { ok: false as const, message: result.error.message })

    /**
     * Write one buffer to the current host.
     * @param hostId - the host holding the file.
     * @param path - absolute host file path.
     * @param text - the buffer to write.
     * @param version - the version the tab read, so a changed file is refused.
     * @returns the write's outcome, carrying the version the host now reports.
     */
    const writeRemote = (hostId: string, path: string, text: string, version: string | null) =>
      options.remoteFiles.write(hostId, path, text, version).then((answer) => answer.ok
        ? { ok: true as const, version: answer.value.version }
        : { ok: false as const, message: answer.failure.message })

    /**
     * Write one tab's buffer and settle the tab.
     * @param path - absolute file path.
     * @param text - the buffer to write.
     * @param write - performs the write and answers whether the Host accepted it.
     * @returns `true` when the Host accepted the write.
     */
    const persist = async (
      path: string,
      text: string,
      write: () => Promise<
        { readonly ok: true; readonly version: string | null } | { readonly ok: false; readonly message: string }
      >,
    ): Promise<boolean> => {
      const generation = (sequence += 1)
      writes.set(path, generation)
      let outcome: { readonly ok: true; readonly version: string | null }
        | { readonly ok: false; readonly message: string }
      try {
        outcome = await write()
      } catch (cause) {
        outcome = { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
      if (options.signal.aborted || writes.get(path) !== generation) return false
      if (!outcome.ok) {
        actions.tabFailed(path, outcome.message, 'save')
        return false
      }
      actions.tabSaved(path, text, outcome.version)
      return true
    }

    return {
      openDirectory: (path) => {
        const hostId = host()
        if (hostId !== null) {
          listRemote(hostId, path)
          return
        }
        const session = target()
        if (session === undefined) return
        list(session, path)
      },
      toggleDirectory: (path, expanded) => {
        if (expanded) {
          actions.collapsed(path)
          return
        }
        actions.expanded(path)
        const hostId = host()
        if (hostId !== null) {
          listRemote(hostId, path)
          return
        }
        const session = target()
        if (session === undefined) return
        list(session, path)
      },
      openFile: (path) => {
        const hostId = host()
        if (hostId !== null) {
          const retired = beginRead(path)
          actions.tabOpened(path, true)
          settleTab(path, loadRemote(hostId, path, retired), retired)
          return
        }
        const session = target()
        if (session === undefined) return
        const retired = beginRead(path)
        actions.tabOpened(path, false)
        settleTab(path, load(session, path, retired), retired)
      },
      focusTab: (path) => {
        actions.tabFocused(path)
      },
      editTab: (path, text) => {
        actions.tabEdited(path, text)
      },
      saveTab: (path, text, version) => {
        const hostId = host()
        if (hostId !== null) {
          void persist(path, text, () => writeRemote(hostId, path, text, version))
          return
        }
        const session = target()
        if (session === undefined) return
        void persist(path, text, () => writeLocal(session, path, text))
      },
      closeTab: (path, text, dirty, version) => {
        // Closing a dirty tab is the user's save gesture: write first and only
        // then drop the tab, so a refused write leaves the work in place.
        if (!dirty) {
          actions.tabClosed(path)
          return
        }
        const hostId = host()
        if (hostId !== null) {
          void persist(path, text, () => writeRemote(hostId, path, text, version)).then((saved) => {
            if (saved) actions.tabClosed(path)
          })
          return
        }
        const session = target()
        if (session === undefined) {
          actions.tabClosed(path)
          return
        }
        void persist(path, text, () => writeLocal(session, path, text)).then((saved) => {
          if (saved) actions.tabClosed(path)
        })
      },
      searchFiles: (query, root) => {
        const hostId = host()
        if (hostId === null) return
        const generation = (searchGeneration += 1)
        actions.searchStarted(query)
        void options.remoteFiles.search(hostId, query, root).then((answer) => {
          if (options.signal.aborted || generation !== searchGeneration) return
          if (!answer.ok) {
            actions.searchFailed(query, answer.failure.message)
            return
          }
          actions.searchLoaded(query, answer.value.results, answer.value.truncated)
        })
      },
    }
  }
}
