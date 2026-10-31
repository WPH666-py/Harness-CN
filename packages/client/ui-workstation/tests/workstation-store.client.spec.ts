/**
 * The seat store's width preference: the contract default, the drag clamp, and
 * the guarantee that a drag touches nothing else in the store.
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

  it('leaves the loaded tree and the viewer alone', () => {
    const store = seat()
    const before = store.getSnapshot()
    store.actions.setTreeWidth(320)
    expect(store.getSnapshot().treeWidth).toBe(320)
    expect(store.getSnapshot().levels).toBe(before.levels)
    expect(store.getSnapshot().expanded).toBe(before.expanded)
    expect(store.getSnapshot().viewer).toEqual(before.viewer)
  })
})
