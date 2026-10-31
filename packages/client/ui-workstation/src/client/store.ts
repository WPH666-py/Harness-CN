/**
 * The workstation's view state: the directory levels the tree has asked for,
 * which of those directories are open, and the tabs the editor holds.
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
import { imageMediaType } from './paths.ts'

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

/** Which operation a tab's failure line reports. */
export type TabFailureKind = 'read' | 'save'

/** Decoded bytes of an image tab, and the size the viewer header shows. */
export interface TabImage {
  /** The complete file, as the read-bytes verb decoded it. */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** File size in bytes at the read. */
  readonly size: number
}

/**
 * One open file, the buffer the editor shows, and the last read or save.
 *
 * `saved` is the Host's copy as of the last successful read or write, so the
 * dirty flag is derived rather than maintained: every edit recomputes it, and a
 * settlement can never claim a buffer is saved while it differs from `saved`.
 * Image tabs keep an empty buffer and carry their bytes in `image`.
 */
export interface TabState {
  /** Absolute path of the file. */
  path: string
  /** Whether the tab edits text or previews an image. */
  kind: 'text' | 'image'
  /** The editor's buffer; empty while the first read is in flight. */
  text: string
  /** The buffer as last read or saved; the dirty flag compares against it. */
  saved: string
  /** The buffer holds edits the Host has not confirmed. */
  dirty: boolean
  /** The first read is in flight. */
  loading: boolean
  /** Why the last read or save failed, `null` while none has. */
  failure: string | null
  /** Which operation produced `failure`. */
  failedOn: TabFailureKind | null
  /** Decoded bytes of an image tab; `null` for text tabs and while loading. */
  image: TabImage | null
}

/** Tree column width before any user drag. */
const TREE_WIDTH_DEFAULT = 260
/** Tree drag clamp floor: a directory name beside its disclosure glyph. */
const TREE_WIDTH_MIN = 180
/** Tree drag clamp ceiling: beyond it the viewer loses its readable share. */
const TREE_WIDTH_MAX = 520
/** Open tabs beyond this close the oldest clean one. */
const TAB_LIMIT = 8

/** Everything the workstation draws, in one store instance. */
export interface WorkstationState {
  /** Level state by absolute directory path; an absent path was never asked for. */
  levels: Record<string, LevelState>
  /** Open directory paths; the root level draws open without being listed here. */
  expanded: string[]
  /** Open files, in the order their tabs were opened. */
  tabs: TabState[]
  /** Path of the focused tab, `null` while none is open. */
  activePath: string | null
  /** Drawn width of the tree column in px; the viewer takes the rest of the seat. */
  treeWidth: number
}

/** The workstation store's write set. */
export type WorkstationActionMap = {
  /** Drop every loaded level and close every tab, keeping what is expanded. */
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
  /** Add one file's tab, or focus it when it is already open. */
  tabOpened: (draft: WorkstationState, path: string) => void
  /** Focus an already open tab. */
  tabFocused: (draft: WorkstationState, path: string) => void
  /** Replace one tab's buffer from the editor. */
  tabEdited: (draft: WorkstationState, path: string, text: string) => void
  /** Record the text the endpoint read for one tab. */
  tabLoaded: (draft: WorkstationState, path: string, text: string) => void
  /** Record the bytes the endpoint read for one image tab. */
  tabImageLoaded: (draft: WorkstationState, path: string, image: TabImage) => void
  /** Record why one tab's last read or save failed. */
  tabFailed: (draft: WorkstationState, path: string, message: string, failedOn: TabFailureKind) => void
  /** Record one tab's buffer as saved on the Host. */
  tabSaved: (draft: WorkstationState, path: string, text: string) => void
  /** Remove one tab, focusing its neighbour when it was the active one. */
  tabClosed: (draft: WorkstationState, path: string) => void
  /** Save the tree column's drag width, clamped into its contract range. */
  setTreeWidth: (draft: WorkstationState, px: number) => void
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
 * The tab holding one path, when it is open.
 * @param state - the draft.
 * @param path - absolute file path.
 * @returns the tab, or `undefined`.
 */
function tabOf(state: WorkstationState, path: string): TabState | undefined {
  return state.tabs.find(tab => tab.path === path)
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
      tabs: [],
      activePath: null,
      treeWidth: TREE_WIDTH_DEFAULT,
    }),
    actions: {
      /**
       * Drop every loaded level and close every tab.
       *
       * The Session changed, and the same path names a
       * different directory in a different workspace: keeping what was loaded
       * would draw another Session's tree.
       * @param d - draft state.
       */
      reset: (d) => {
        d.levels = {}
        d.tabs = []
        d.activePath = null
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
       * Add one file's tab, or focus it when it is already open.
       *
       * The tab is added empty and loading: the face reads the file and settles
       * it. A tab beyond the limit closes the oldest clean tab, so edits are
       * never discarded to make room; when every tab is dirty the limit yields,
       * because the alternative is dropping work the user still sees.
       * @param d - draft state.
       * @param path - absolute file path.
       */
      tabOpened: (d, path: string) => {
        if (tabOf(d, path) !== undefined) {
          d.activePath = path
          return
        }
        d.tabs.push({
          path,
          kind: imageMediaType(path) === null ? 'text' : 'image',
          text: '',
          saved: '',
          dirty: false,
          loading: true,
          failure: null,
          failedOn: null,
          image: null,
        })
        d.activePath = path
        if (d.tabs.length <= TAB_LIMIT) return
        const victim = d.tabs.find(tab => tab.path !== path && !tab.dirty)
        if (victim !== undefined) d.tabs.splice(d.tabs.indexOf(victim), 1)
      },
      /**
       * Focus an already open tab.
       * @param d - draft state.
       * @param path - absolute file path.
       */
      tabFocused: (d, path: string) => {
        if (tabOf(d, path) !== undefined) d.activePath = path
      },
      /**
       * Replace one tab's buffer from the editor.
       *
       * The dirty flag is derived here so every writer — typing, a save
       * settlement, a read settlement — agrees on what "unsaved" means.
       * @param d - draft state.
       * @param path - absolute file path.
       * @param text - the editor's whole buffer.
       */
      tabEdited: (d, path: string, text: string) => {
        const tab = tabOf(d, path)
        if (tab === undefined) return
        tab.text = text
        tab.dirty = text !== tab.saved
      },
      /**
       * Record the text the endpoint read for one tab.
       * @param d - draft state.
       * @param path - absolute file path.
       * @param text - the complete file text.
       */
      tabLoaded: (d, path: string, text: string) => {
        const tab = tabOf(d, path)
        if (tab === undefined) return
        tab.text = text
        tab.saved = text
        tab.dirty = false
        tab.loading = false
        tab.failure = null
        tab.failedOn = null
      },
      /**
       * Record the bytes the endpoint read for one image tab.
       * @param d - draft state.
       * @param path - absolute file path.
       * @param image - the decoded file and its size.
       */
      tabImageLoaded: (d, path: string, image: TabImage) => {
        const tab = tabOf(d, path)
        if (tab === undefined) return
        tab.image = image
        tab.loading = false
        tab.failure = null
        tab.failedOn = null
      },
      /**
       * Record why one tab's last read or save failed.
       *
       * A failed save leaves the tab open and dirty: the buffer is still the
       * user's, and the failure line says why the Host does not have it.
       * @param d - draft state.
       * @param path - absolute file path.
       * @param message - the endpoint's message.
       * @param failedOn - which operation failed.
       */
      tabFailed: (d, path: string, message: string, failedOn: TabFailureKind) => {
        const tab = tabOf(d, path)
        if (tab === undefined) return
        tab.loading = false
        tab.failure = message
        tab.failedOn = failedOn
      },
      /**
       * Record one tab's buffer as saved on the Host.
       *
       * `saved` moves to the text that was written, and the dirty flag is
       * recomputed against the buffer, so edits typed while the write was in
       * flight keep the tab dirty.
       * @param d - draft state.
       * @param path - absolute file path.
       * @param text - the text the Host accepted.
       */
      tabSaved: (d, path: string, text: string) => {
        const tab = tabOf(d, path)
        if (tab === undefined) return
        tab.saved = text
        tab.dirty = tab.text !== text
        tab.failure = null
        tab.failedOn = null
      },
      /**
       * Remove one tab.
       *
       * Closing the active tab focuses the next one, or the previous one when
       * the closed tab was last, so the viewer always shows something while a
       * tab remains.
       * @param d - draft state.
       * @param path - absolute file path.
       */
      tabClosed: (d, path: string) => {
        const at = d.tabs.findIndex(tab => tab.path === path)
        if (at < 0) return
        d.tabs.splice(at, 1)
        if (d.activePath !== path) return
        d.activePath = d.tabs[at]?.path ?? d.tabs[at - 1]?.path ?? null
      },
      /**
       * Save the tree column's drag width.
       *
       * The viewer is what remains of the seat, so only the tree's own range is
       * clamped here; the frame owns how much room the seat itself gets.
       * @param d - draft state.
       * @param px - requested width in px.
       */
      setTreeWidth: (d, px: number) => {
        d.treeWidth = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(px)))
      },
    },
  })
}
