/**
 * The seat store's own unit spec: the width preference, the tab contract, and
 * the guarantees that keep a tab's buffer honest.
 *
 * These cases run without a renderer, so they pin the state machine the viewer
 * and the face both rely on: the drag clamp, one tab per path, the derived dirty
 * flag, the eight-tab cap that never evicts an edit, and reset dropping what
 * belonged to the previous Session.
 */
import { describe, expect, it } from 'vitest'
import { createWorkstationStore } from '../src/client/store.ts'

/** A fresh store instance for one assertion. */
function seat(): ReturnType<ReturnType<typeof createWorkstationStore>['create']> {
  return createWorkstationStore().create()
}

describe('workstation store tree width', () => {
  it('starts at the contract default', () => {
    expect(seat().getSnapshot().treeWidth).toBe(260)
  })

  it('rounds a drag width and clamps it into the pane range', () => {
    const store = seat()
    store.actions.setTreeWidth(300.4)
    expect(store.getSnapshot().treeWidth).toBe(300)
    store.actions.setTreeWidth(10)
    expect(store.getSnapshot().treeWidth).toBe(180)
    store.actions.setTreeWidth(9999)
    expect(store.getSnapshot().treeWidth).toBe(520)
  })

  it('leaves the tree and the tabs alone', () => {
    const store = seat()
    store.actions.expanded('/ws/src')
    store.actions.tabOpened('/ws/README.md')
    store.actions.tabLoaded('/ws/README.md', 'alpha')
    const before = store.getSnapshot()
    store.actions.setTreeWidth(320)
    const after = store.getSnapshot()
    expect(after.treeWidth).toBe(320)
    expect(after.levels).toBe(before.levels)
    expect(after.expanded).toBe(before.expanded)
    expect(after.tabs).toBe(before.tabs)
    expect(after.activePath).toBe(before.activePath)
  })
})

describe('workstation store tabs', () => {
  it('opens one tab per path and focuses the opened one', () => {
    const store = seat()
    store.actions.tabOpened('/ws/README.md')
    const opened = store.getSnapshot()
    expect(opened.tabs.map(tab => tab.path)).toEqual(['/ws/README.md'])
    expect(opened.activePath).toBe('/ws/README.md')
    expect(opened.tabs[0]).toMatchObject({ kind: 'text', loading: true, dirty: false, failure: null })
  })

  it('focuses an existing tab instead of opening the path twice', () => {
    const store = seat()
    store.actions.tabOpened('/ws/a.ts')
    store.actions.tabOpened('/ws/b.ts')
    store.actions.tabOpened('/ws/a.ts')
    expect(store.getSnapshot().tabs.map(tab => tab.path)).toEqual(['/ws/a.ts', '/ws/b.ts'])
    expect(store.getSnapshot().activePath).toBe('/ws/a.ts')
  })

  it('classifies an image path as an image tab and keeps its bytes', () => {
    const store = seat()
    store.actions.tabOpened('/ws/pixel.png')
    expect(store.getSnapshot().tabs[0]?.kind).toBe('image')
    store.actions.tabImageLoaded('/ws/pixel.png', { bytes: new Uint8Array([1, 2, 3, 4]), size: 4 })
    expect(store.getSnapshot().tabs[0]).toMatchObject({ loading: false, failure: null, image: { size: 4 } })
  })

  it('marks the buffer dirty until the Host has the same text', () => {
    const store = seat()
    store.actions.tabOpened('/ws/a.ts')
    store.actions.tabLoaded('/ws/a.ts', 'alpha')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ text: 'alpha', saved: 'alpha', dirty: false, loading: false })
    store.actions.tabEdited('/ws/a.ts', 'alpha!')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ text: 'alpha!', dirty: true })
    store.actions.tabSaved('/ws/a.ts', 'alpha!')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ saved: 'alpha!', dirty: false, failure: null })
  })

  it('keeps a tab dirty when the buffer changed while the write was in flight', () => {
    const store = seat()
    store.actions.tabOpened('/ws/a.ts')
    store.actions.tabLoaded('/ws/a.ts', 'one')
    store.actions.tabEdited('/ws/a.ts', 'two')
    store.actions.tabSaved('/ws/a.ts', 'one')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ text: 'two', saved: 'one', dirty: true })
  })

  it('reports why a save failed and leaves the buffer editable', () => {
    const store = seat()
    store.actions.tabOpened('/ws/a.ts')
    store.actions.tabLoaded('/ws/a.ts', 'one')
    store.actions.tabEdited('/ws/a.ts', 'two')
    store.actions.tabFailed('/ws/a.ts', 'disk full', 'save')
    expect(store.getSnapshot().tabs[0]).toMatchObject({
      text: 'two',
      dirty: true,
      loading: false,
      failure: 'disk full',
      failedOn: 'save',
    })
  })

  it('closes a tab and focuses its neighbour', () => {
    const store = seat()
    store.actions.tabOpened('/ws/a.ts')
    store.actions.tabOpened('/ws/b.ts')
    store.actions.tabOpened('/ws/c.ts')
    store.actions.tabFocused('/ws/a.ts')
    expect(store.getSnapshot().activePath).toBe('/ws/a.ts')
    store.actions.tabClosed('/ws/a.ts')
    expect(store.getSnapshot().tabs.map(tab => tab.path)).toEqual(['/ws/b.ts', '/ws/c.ts'])
    expect(store.getSnapshot().activePath).toBe('/ws/b.ts')
    store.actions.tabClosed('/ws/b.ts')
    expect(store.getSnapshot().activePath).toBe('/ws/c.ts')
    store.actions.tabClosed('/ws/c.ts')
    expect(store.getSnapshot().activePath).toBeNull()
    expect(store.getSnapshot().tabs).toEqual([])
  })

  it('closes the oldest clean tab once the cap is reached', () => {
    const store = seat()
    for (let at = 0; at < 9; at += 1) store.actions.tabOpened(`/ws/${at}.ts`)
    expect(store.getSnapshot().tabs.map(tab => tab.path)).toEqual([
      '/ws/1.ts', '/ws/2.ts', '/ws/3.ts', '/ws/4.ts', '/ws/5.ts', '/ws/6.ts', '/ws/7.ts', '/ws/8.ts',
    ])
    expect(store.getSnapshot().activePath).toBe('/ws/8.ts')
  })

  it('keeps every dirty tab rather than discarding an edit', () => {
    const store = seat()
    for (let at = 0; at < 8; at += 1) {
      store.actions.tabOpened(`/ws/${at}.ts`)
      store.actions.tabLoaded(`/ws/${at}.ts`, 'saved')
      store.actions.tabEdited(`/ws/${at}.ts`, 'edited')
    }
    store.actions.tabOpened('/ws/last.ts')
    expect(store.getSnapshot().tabs).toHaveLength(9)
    expect(store.getSnapshot().tabs[0]?.dirty).toBe(true)
  })

  it('drops every tab on reset but keeps what the tree had open', () => {
    const store = seat()
    store.actions.expanded('/ws/src')
    store.actions.tabOpened('/ws/a.ts')
    store.actions.reset()
    const state = store.getSnapshot()
    expect(state.tabs).toEqual([])
    expect(state.activePath).toBeNull()
    expect(state.levels).toEqual({})
    expect(state.expanded).toEqual(['/ws/src'])
  })
})
