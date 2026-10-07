/**
 * The tree's write set, one tab at a time.
 *
 * Two facts here are load-bearing for the body: a collapsed level keeps what it
 * loaded (reopening draws at once), and `reset` clears levels while keeping the
 * expanded set, which is what lets the reload gesture know which levels to ask
 * for again. The reader's own state is load-bearing for the file operations:
 * the selection is what a gesture acts on, the clipboard is what a paste
 * places, the draft is the name input, and `pruned` is what keeps a removed
 * subtree from being drawn or acted on again.
 */
import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createFilesStore } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const ROOT = '/work/app'
const TAB = 'tab-1' as TabId

const LEVEL: DirLevel = {
  entries: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 12 }],
  truncated: false,
}

/** What one freshly started tab holds, before anything else is written. */
const FRESH = {
  root: ROOT,
  levels: {},
  expanded: [ROOT],
  selected: null,
  clipboard: null,
  draft: null,
  notice: null,
}

describe('createFilesStore', () => {
  it('mints an independent instance per call', () => {
    const first = createFilesStore().create()
    const second = createFilesStore().create()
    first.actions.start(TAB, ROOT)
    expect(second.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('seeds a tab at its root with the root expanded, nothing loaded, and nothing in hand', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    expect(getSnapshot().byTab[TAB]).toEqual(FRESH)
  })

  it('walks one level through loading, ready, and failed', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.loading(TAB, ROOT)
    expect(getSnapshot().byTab[TAB]!.levels[ROOT]).toEqual({ kind: 'loading' })
    actions.loaded(TAB, ROOT, LEVEL)
    expect(getSnapshot().byTab[TAB]!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    const failure = new RemoteError('workspace-file/not-found', 'gone', { path: ROOT })
    actions.failed(TAB, ROOT, failure)
    expect(getSnapshot().byTab[TAB]!.levels[ROOT]).toEqual({ kind: 'failed', failure })
  })

  it('toggles a directory in and out of the expanded set without touching its level', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const child = `${ROOT}/src`
    actions.start(TAB, ROOT)
    actions.loaded(TAB, child, LEVEL)
    actions.toggled(TAB, child)
    expect(getSnapshot().byTab[TAB]!.expanded).toEqual([ROOT, child])
    actions.toggled(TAB, child)
    expect(getSnapshot().byTab[TAB]!.expanded).toEqual([ROOT])
    // Collapsing keeps the listing, so reopening draws without another fetch.
    expect(getSnapshot().byTab[TAB]!.levels[child]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('reset drops every level and keeps the expanded set', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const child = `${ROOT}/src`
    actions.start(TAB, ROOT)
    actions.loaded(TAB, ROOT, LEVEL)
    actions.toggled(TAB, child)
    actions.loaded(TAB, child, LEVEL)
    actions.reset(TAB)
    expect(getSnapshot().byTab[TAB]).toEqual({ ...FRESH, expanded: [ROOT, child] })
  })

  it('refuses to write a level for a tab that was never started', () => {
    const { actions } = createFilesStore().create()
    expect(() => { actions.loading('tab-nowhere' as TabId, ROOT) }).toThrow('no tree for tab "tab-nowhere"')
  })

  it('forget removes exactly the tab that went away', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.start('tab-2' as TabId, ROOT)
    actions.forget(TAB)
    expect(Object.keys(getSnapshot().byTab)).toEqual(['tab-2'])
  })

  it('selects one row at a time, and clears the selection with null', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.selected(TAB, `${ROOT}/src`)
    expect(getSnapshot().byTab[TAB]!.selected).toBe(`${ROOT}/src`)
    actions.selected(TAB, `${ROOT}/README.md`)
    expect(getSnapshot().byTab[TAB]!.selected).toBe(`${ROOT}/README.md`)
    actions.selected(TAB, null)
    expect(getSnapshot().byTab[TAB]!.selected).toBeNull()
  })

  it('drops the last notice when the reader selects another row', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.noticed(TAB, new RemoteError('workspace-file/exists', 'taken', { path: 'src' }))
    actions.selected(TAB, `${ROOT}/src`)
    expect(getSnapshot().byTab[TAB]!.notice).toBeNull()
  })

  it('holds one clipboard entry, and releases it with null', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.clipboarded(TAB, { mode: 'cut', path: `${ROOT}/src` })
    expect(getSnapshot().byTab[TAB]!.clipboard).toEqual({ mode: 'cut', path: `${ROOT}/src` })
    actions.clipboarded(TAB, { mode: 'copy', path: `${ROOT}/README.md` })
    expect(getSnapshot().byTab[TAB]!.clipboard).toEqual({ mode: 'copy', path: `${ROOT}/README.md` })
    actions.clipboarded(TAB, null)
    expect(getSnapshot().byTab[TAB]!.clipboard).toBeNull()
  })

  it('opens one name input, and closes it with null', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.drafted(TAB, { parent: ROOT, kind: 'directory' })
    expect(getSnapshot().byTab[TAB]!.draft).toEqual({ parent: ROOT, kind: 'directory' })
    actions.drafted(TAB, null)
    expect(getSnapshot().byTab[TAB]!.draft).toBeNull()
  })

  it('holds the last gesture failure until something replaces it', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const failure = new RemoteError('workspace-file/not-empty', 'not empty', { path: 'src' })
    actions.start(TAB, ROOT)
    actions.noticed(TAB, failure)
    expect(getSnapshot().byTab[TAB]!.notice).toBe(failure)
    actions.noticed(TAB, null)
    expect(getSnapshot().byTab[TAB]!.notice).toBeNull()
  })

  it('prunes a removed subtree: its level, everything under it, and the selection inside it', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const gone = `${ROOT}/src`
    const deep = `${gone}/deep`
    const kept = `${ROOT}/docs`
    actions.start(TAB, ROOT)
    actions.loaded(TAB, ROOT, LEVEL)
    actions.loaded(TAB, gone, LEVEL)
    actions.loaded(TAB, deep, LEVEL)
    actions.loaded(TAB, kept, LEVEL)
    actions.toggled(TAB, gone)
    actions.toggled(TAB, deep)
    actions.toggled(TAB, kept)
    actions.selected(TAB, `${deep}/a.ts`)
    actions.pruned(TAB, gone)
    const state = getSnapshot().byTab[TAB]!
    expect(Object.keys(state.levels).sort()).toEqual([kept, ROOT].sort())
    expect(state.expanded).toEqual([ROOT, kept])
    expect(state.selected).toBeNull()
  })

  it('keeps a selection outside the removed subtree', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(TAB, ROOT)
    actions.selected(TAB, `${ROOT}/docs`)
    actions.pruned(TAB, `${ROOT}/src`)
    expect(getSnapshot().byTab[TAB]!.selected).toBe(`${ROOT}/docs`)
  })

  it('keeps a path that merely starts with the removed path\'s letters', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const sibling = `${ROOT}/src-old`
    actions.start(TAB, ROOT)
    actions.loaded(TAB, sibling, LEVEL)
    actions.toggled(TAB, sibling)
    actions.selected(TAB, sibling)
    actions.pruned(TAB, `${ROOT}/src`)
    const state = getSnapshot().byTab[TAB]!
    expect(state.levels[sibling]).toEqual({ kind: 'ready', level: LEVEL })
    expect(state.expanded).toEqual([ROOT, sibling])
    expect(state.selected).toBe(sibling)
  })
})
