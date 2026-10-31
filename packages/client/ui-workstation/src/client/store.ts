/**
 * The workstation's view state: the directory levels the tree has asked for,
 * which of those directories are open, and the page of text the viewer shows.
 *
 * One instance per application, not one per Session: the seat is declared
 * `scope: 'root'` because it describes the frame's presentation rather than a
 * Session's content, so the level cache is keyed by the absolute directory path
 * the listing endpoint was asked with. That path starts at the Session's own
 * working directory, which its summary carries; nothing here is workspace
 * relative.
 *
 * The component writes nothing itself: it calls the injected face, which
 * performs a Remote call and settles into these actions.
 */
import { defineStore, type BoundActions, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { FIRST_LINE } from './paths.ts'

/**
 * One directory's contents, as one level of the tree draws them.
 *
 * The endpoint also echoes the directory's own path; the
 * tree already has the key it asked with, so it keeps the entries and the
 * truncation flag only.
 */
export interface DirectoryLevel {
  /** The directory's entries, in the endpoint's order. */
  readonly entries: readonly WorkspaceDirectoryEntry[]
  /** The listing hit the endpoint's entry cap, so entries are missing. */
  readonly truncated: boolean
}

/** What one directory level is doing right now. */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirectoryLevel }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/**
 * The open file and the pages of it read so far.
 *
 * `offset` is the next page's line offset, which is exactly how many lines the
 * endpoint has already handed over: the first page asks for 0, and each "load
 * more" asks for the count it has, so the arithmetic never depends on how the
 * text was split for display.
 */
export interface ViewerState {
  /** Absolute path of the open file, `null` while none is open. */
  path: string | null
  /** Lines read so far, in file order. */
  lines: string[]
  /** First line of the next page; line windows are 1-based. */
  offset: number
  /** The endpoint said the file ends in what has been read. */
  eof: boolean
  /** A page is in flight. */
  loading: boolean
  /** Why the last page failed, `null` while none has. */
  failure: RemoteFailure | null
}

/** Everything the workstation draws, in one store instance. */
export interface WorkstationState {
  /** Level state by absolute directory path; an absent path was never asked for. */
  levels: Record<string, LevelState>
  /** Open directory paths; the root level draws open without being listed here. */
  expanded: string[]
  /** The open file and the pages of it read so far. */
  viewer: ViewerState
}

/** One page of a file, as the viewer appends it. */
export interface FilePage {
  /** The lines this page added. */
  readonly lines: readonly string[]
  /** First line of the following page. */
  readonly offset: number
  /** The file ends within this page. */
  readonly eof: boolean
}

/** The workstation store's write set. */
export type WorkstationActionMap = {
  /** Drop every loaded level and forget the open file, keeping what is expanded. */
  reset: (draft: WorkstationState) => void
  /** Mark one directory as being listed. */
  loading: (draft: WorkstationState, path: string) => void
  /** Record one directory's contents. */
  loaded: (draft: WorkstationState, path: string, level: DirectoryLevel) => void
  /** Record why one directory could not be listed. */
  failed: (draft: WorkstationState, path: string, failure: RemoteFailure) => void
  /** Open one directory's level in the tree. */
  expanded: (draft: WorkstationState, path: string) => void
  /** Close one directory's level in the tree. */
  collapsed: (draft: WorkstationState, path: string) => void
  /** Start the viewer on one file, discarding whatever it showed before. */
  opened: (draft: WorkstationState, path: string) => void
  /** Mark the open file as reading its next page. */
  paging: (draft: WorkstationState) => void
  /** Append one page to the open file. */
  paged: (draft: WorkstationState, page: FilePage) => void
  /** Record why the open file's last page failed. */
  pageFailed: (draft: WorkstationState, failure: RemoteFailure) => void
}

/** The handle a registration declares and a component reads. */
export type WorkstationStoreHandle = EngineStoreHandle<WorkstationState, WorkstationActionMap>

/** The store instance's actions, as the injected face writes them. */
export type WorkstationActions = BoundActions<WorkstationStoreHandle>

/**
 * One expanded directory below the root.
 * @param state - the draft.
 * @param path - absolute directory path to open.
 */
function expand(state: WorkstationState, path: string): void {
  if (!state.expanded.includes(path)) state.expanded.push(path)
}

/**
 * Declare the workstation's store.
 *
 * A factory rather than a shared handle: the registration owns the instance, so
 * the store's lifetime is the seat's.
 * @returns the store handle to declare on the registration.
 */
export function createWorkstationStore(): WorkstationStoreHandle {
  return defineStore({
    init: (): WorkstationState => ({
      levels: {},
      expanded: [],
      viewer: { path: null, lines: [], offset: FIRST_LINE, eof: true, loading: false, failure: null },
    }),
    actions: {
      /**
       * Drop every loaded level and close the viewer's file.
       *
       * The Session changed, and the same path names a
       * different directory in a different workspace: keeping what was loaded
       * would draw another Session's tree.
       * @param d - draft state.
       */
      reset: (d) => {
        d.levels = {}
        d.viewer = { path: null, lines: [], offset: FIRST_LINE, eof: true, loading: false, failure: null }
      },
      /**
       * Mark one directory as being listed.
       * @param d - draft state.
       * @param path - absolute directory path.
       */
      loading: (d, path: string) => {
        d.levels[path] = { kind: 'loading' }
      },
      /**
       * Record one directory's contents.
       * @param d - draft state.
       * @param path - absolute directory path.
       * @param level - the listing to draw under it.
       */
      loaded: (d, path: string, level: DirectoryLevel) => {
        d.levels[path] = { kind: 'ready', level }
      },
      /**
       * Record why one directory could not be listed.
       * @param d - draft state.
       * @param path - absolute directory path.
       * @param failure - the settled Remote failure.
       */
      failed: (d, path: string, failure: RemoteFailure) => {
        d.levels[path] = { kind: 'failed', failure }
      },
      /**
       * Open one directory's level, keeping what it loaded before.
       * @param d - draft state.
       * @param path - absolute directory path.
       */
      expanded: (d, path: string) => {
        expand(d, path)
      },
      /**
       * Close one directory's level.
       *
       * A closed level keeps its listing, so reopening it draws at once.
       * @param d - draft state.
       * @param path - absolute directory path.
       */
      collapsed: (d, path: string) => {
        d.expanded = d.expanded.filter(at => at !== path)
      },
      /**
       * Start the viewer on one file.
       *
       * The page in flight for the previous file is retired by the face's own
       * generation, not by this action, so clearing here is enough.
       * @param d - draft state.
       * @param path - absolute file path.
       */
      opened: (d, path: string) => {
        d.viewer = { path, lines: [], offset: FIRST_LINE, eof: false, loading: true, failure: null }
      },
      /**
       * Mark the open file as reading its next page.
       * @param d - draft state.
       */
      paging: (d) => {
        d.viewer.loading = true
        d.viewer.failure = null
      },
      /**
       * Append one page to the open file.
       * @param d - draft state.
       * @param page - the page the endpoint returned.
       */
      paged: (d, page: FilePage) => {
        d.viewer.lines.push(...page.lines)
        d.viewer.offset = page.offset
        d.viewer.eof = page.eof
        d.viewer.loading = false
        d.viewer.failure = null
      },
      /**
       * Record why the open file's last page failed.
       * @param d - draft state.
       * @param failure - the settled Remote failure.
       */
      pageFailed: (d, failure: RemoteFailure) => {
        d.viewer.loading = false
        d.viewer.failure = failure
      },
    },
  })
}
