/**
 * The file tree's view state: which directories are expanded, what each loaded
 * level contains, and what the reader is doing to those entries.
 *
 * The tree is not one resource. A directory listing per level, expanded lazily,
 * is state the type owns — so it lives in a Slot-standard exclusive store
 * (one instance per session), bucketed by tab id because two tabs of this kind
 * in one session expand independently. The reader's own working state — the
 * selected row, the clipboard, the open name input, and why the last gesture
 * failed — is per tab for the same reason.
 *
 * Writers run between `start` and `forget`: the owner's `signal` is what ends a
 * bucket's life, and the face stops dispatching once it aborts.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'

/**
 * One directory's contents, as one expanded level of the tree.
 *
 * The endpoint's listing also names the directory as a workspace-relative path;
 * the tree keys every level by absolute path instead, so the adapter drops it.
 */
export interface DirLevel {
  /** The directory's entries, in the endpoint's order. */
  readonly entries: readonly WorkspaceDirectoryEntry[]
  /** The listing hit the endpoint's entry cap, so entries are missing. */
  readonly truncated: boolean
}

/** What one directory level is doing right now. */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirLevel }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/**
 * One entry held for a later paste, and which verb the paste performs.
 *
 * The two modes differ in more than the Remote call: a landed `cut` releases
 * the clipboard and leaves the source gone, while a `copy` leaves the source
 * and stays on the clipboard for another paste.
 */
export interface FilesClipboard {
  /** `copy` leaves the source in place; `cut` moves it. */
  readonly mode: 'copy' | 'cut'
  /** Absolute path of the entry that was copied or cut. */
  readonly path: string
}

/** The inline name input one new entry is waiting for. */
export interface NewEntryDraft {
  /** Absolute path of the directory the entry is created in. */
  readonly parent: string
  /** Which entry the committed name produces. */
  readonly kind: 'file' | 'directory'
}

/**
 * One tab's tree: its root, the levels it has asked for, what is open, and what
 * the reader has in hand.
 *
 * Every path here is absolute: the root is the session's working directory as
 * the Host reports it, and a child is the parent joined with the entry name.
 */
export interface FilesTabState {
  /** Absolute path of the workspace root this tree is rooted at. */
  root: string
  /** Level state by absolute directory path; a path absent here was never asked for. */
  levels: Record<string, LevelState>
  /** Expanded absolute directory paths, root included. */
  expanded: string[]
  /** Absolute path of the selected row, `null` while nothing is selected. */
  selected: string | null
  /** The entry a paste places, `null` while the clipboard is empty. */
  clipboard: FilesClipboard | null
  /** The new entry still waiting for its name, `null` while no input is open. */
  draft: NewEntryDraft | null
  /** Why the last gesture failed, `null` while none has. */
  notice: RemoteFailure | null
}

/** Every tab's tree, keyed by tab id. */
export interface FilesState {
  byTab: Record<TabId, FilesTabState>
}

/**
 * One tab's bucket, which every writer after `start` relies on: the face only
 * dispatches while the record's signal is live, and `forget` runs on its abort.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's tree.
 */
function bucket(state: FilesState, tabId: TabId): FilesTabState {
  const tree = state.byTab[tabId]
  if (tree === undefined) throw new Error(`ui-sidebar-files: no tree for tab "${tabId}"`)
  return tree
}

/**
 * Whether one absolute path is `path` itself or lies under it.
 *
 * Child paths are joined with `/` whatever the platform's separators, so the
 * descendant test is one prefix and one separator.
 * @param candidate - absolute path to test.
 * @param path - absolute path of the entry that went away.
 * @returns whether the candidate belongs to the removed subtree.
 */
function within(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`)
}

/** The tree store's write set; every action names the tab it writes. */
type FilesActions = {
  start: (draft: FilesState, tabId: TabId, root: string) => void
  loading: (draft: FilesState, tabId: TabId, path: string) => void
  loaded: (draft: FilesState, tabId: TabId, path: string, level: DirLevel) => void
  failed: (draft: FilesState, tabId: TabId, path: string, failure: RemoteFailure) => void
  toggled: (draft: FilesState, tabId: TabId, path: string) => void
  reset: (draft: FilesState, tabId: TabId) => void
  forget: (draft: FilesState, tabId: TabId) => void
  selected: (draft: FilesState, tabId: TabId, path: string | null) => void
  clipboarded: (draft: FilesState, tabId: TabId, clipboard: FilesClipboard | null) => void
  drafted: (draft: FilesState, tabId: TabId, entry: NewEntryDraft | null) => void
  noticed: (draft: FilesState, tabId: TabId, failure: RemoteFailure | null) => void
  pruned: (draft: FilesState, tabId: TabId, path: string) => void
}

/**
 * Declare the file tree's store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createFilesStore(): EngineStoreHandle<FilesState, FilesActions> {
  return defineStore({
    init: (): FilesState => ({ byTab: {} }),
    actions: {
      /**
       * Seed one tab's tree at its workspace root, with the root expanded and
       * nothing in hand.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param root - absolute path of the workspace root.
       */
      start: (d, tabId: TabId, root: string) => {
        d.byTab[tabId] = {
          root, levels: {}, expanded: [root], selected: null, clipboard: null, draft: null, notice: null,
        }
      },
      /**
       * Mark one directory as being listed.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute directory path.
       */
      loading: (d, tabId: TabId, path: string) => {
        bucket(d, tabId).levels[path] = { kind: 'loading' }
      },
      /**
       * Record one directory's contents.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute directory path.
       * @param level - the listing to show under it.
       */
      loaded: (d, tabId: TabId, path: string, level: DirLevel) => {
        bucket(d, tabId).levels[path] = { kind: 'ready', level }
      },
      /**
       * Record why one directory could not be listed.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute directory path.
       * @param failure - the settled Remote failure.
       */
      failed: (d, tabId: TabId, path: string, failure: RemoteFailure) => {
        bucket(d, tabId).levels[path] = { kind: 'failed', failure }
      },
      /**
       * Open a collapsed directory, or collapse an open one.
       *
       * A collapsed level keeps what it loaded, so reopening it draws at once.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute directory path.
       */
      toggled: (d, tabId: TabId, path: string) => {
        const state = bucket(d, tabId)
        const at = state.expanded.indexOf(path)
        if (at >= 0) state.expanded.splice(at, 1)
        else state.expanded.push(path)
      },
      /**
       * Drop every loaded level, keeping what is expanded.
       *
       * This is the reload gesture's first half: the expanded set says which
       * levels to fetch again.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      reset: (d, tabId: TabId) => {
        bucket(d, tabId).levels = {}
      },
      /**
       * Forget one tab's tree, for a tab record that is gone.
       * @param d - draft state.
       * @param tabId - the tab that went away.
       */
      forget: (d, tabId: TabId) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
      /**
       * Select one row, or clear the selection with `null`.
       *
       * Selecting is the reader moving on to another entry, so it also drops
       * the last gesture's notice.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute path of the selected row.
       */
      selected: (d, tabId: TabId, path: string | null) => {
        const state = bucket(d, tabId)
        state.selected = path
        state.notice = null
      },
      /**
       * Put one entry on the clipboard, or clear it with `null`.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param clipboard - the entry a paste will place.
       */
      clipboarded: (d, tabId: TabId, clipboard: FilesClipboard | null) => {
        bucket(d, tabId).clipboard = clipboard
      },
      /**
       * Open the inline name input, or close it with `null`.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param entry - the directory and kind the next committed name creates.
       */
      drafted: (d, tabId: TabId, entry: NewEntryDraft | null) => {
        bucket(d, tabId).draft = entry
      },
      /**
       * Record why the last gesture failed, or clear it with `null`.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param failure - the settled Remote failure.
       */
      noticed: (d, tabId: TabId, failure: RemoteFailure | null) => {
        bucket(d, tabId).notice = failure
      },
      /**
       * Forget one entry that is gone: its level, every level under it, the
       * expanded entries that pointed at them, and a selection inside it.
       *
       * A later entry may reuse the name, and it must not draw the removed
       * subtree's listing or hold the reader's gesture against it.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param path - absolute path of the entry that went away.
       */
      pruned: (d, tabId: TabId, path: string) => {
        const state = bucket(d, tabId)
        state.levels = Object.fromEntries(Object.entries(state.levels).filter(([at]) => !within(at, path)))
        state.expanded = state.expanded.filter(at => !within(at, path))
        if (state.selected !== null && within(state.selected, path)) state.selected = null
      },
    },
  })
}
