/**
 * The seat's own spec: a real store instance, a scripted Remote, and the tree
 * and viewer drawing exactly what the face settled into the store.
 *
 * The seat's contract is narrow on purpose — a level loads when the tree first
 * draws it, a file click fills the viewer, and no Session means no request at
 * all — so these cases cover the promise without reaching for a fake of the
 * whole client runtime. The splitter is driven directly, because the store owns
 * the width it settles.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { workstationFace } from '../src/client/face.ts'
import type { WorkspaceFilesRemote } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'
import { createWorkstationStore } from '../src/client/store.ts'
import { Workstation } from '../src/client/Workstation.tsx'
import type { WorkstationProps } from '../src/client/Workstation.tsx'

/** The Session the whole spec pretends is on screen. */
const SESSION = 'session-workstation' as SessionId

/** The working directory that Session reports, which the tree lists first. */
const ROOT = 'C:\\ws\\workstation'

/**
 * The Session list the seat reads the working directory out of.
 * @param cwd - the Session's working directory, `undefined` for no Session at all.
 * @returns a snapshot source shaped like the framework-provided hook's instance.
 */
function sessionsOf(cwd: string | undefined): { getSnapshot(): unknown; subscribe(listener: () => void): () => void } {
  /** Built once: a fresh object per read would make `useSyncExternalStore` loop. */
  const state = {
    ids: cwd === undefined ? [] : [SESSION],
    byId: cwd === undefined ? {} : { [SESSION]: { sessionId: SESSION, cwd } },
    phase: 'ready',
    projectionsBySession: {},
  }
  return { getSnapshot: () => state, subscribe: () => () => {} }
}

/** One view of a store instance, shaped like the framework-provided hook. */
function hookOf<T>(
  instance: { getSnapshot(): T; subscribe(listener: () => void): () => void },
): <S>(select: (state: T) => S) => S {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

/** A Remote face that answers the root listing and one text file. */
function scripted(): { remote: WorkspaceFilesRemote; list: ReturnType<typeof vi.fn> } {
  /** Each directory answers with its own children, so no name repeats in the tree. */
  const levels: Record<string, WorkspaceDirectoryEntry[]> = {
    [ROOT]: [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 11 },
    ],
    [`${ROOT}/src`]: [{ name: 'index.ts', type: 'file', size: 4 }],
  }
  const list = vi.fn(async (_session: SessionId, path: string) => ({
    ok: true as const,
    value: { path, entries: levels[path] ?? [], truncated: false },
  }))
  const read = vi.fn(async (_session: SessionId, path: string, range: { offset?: number }) => ({
    ok: true as const,
    value: {
      path,
      size: 11,
      mtime: 0,
      offset: range.offset ?? 0,
      text: 'alpha\nbeta',
      lines: 2,
      eof: true,
    },
  }))
  return {
    remote: { workspaceFiles: { list, read } } as unknown as WorkspaceFilesRemote,
    list,
  }
}

/** Mount the seat over a fresh store instance and the scripted Remote. */
function mountSeat(cwd: string | null = ROOT) {
  const directory = cwd ?? undefined
  const instance = createWorkstationStore().create()
  const controller = new AbortController()
  const { remote, list } = scripted()
  const face = workstationFace({ remote, sessionId: () => (directory === undefined ? undefined : SESSION), signal: controller.signal })(instance.actions)
  const props = {
    useStore: hookOf(instance),
    actions: instance.actions,
    useSessions: hookOf(sessionsOf(directory)),
    useSessionId: hookOf({ getSnapshot: () => (directory === undefined ? undefined : SESSION), subscribe: () => () => {} }),
    t: makeTranslate(zh),
    ...face,
  } as unknown as WorkstationProps
  return { ...render(<Workstation {...props} />), instance, list }
}

/** Dispatch one pointer event; jsdom types no pointer capture, stubbed below. */
function pointer(handle: Element, type: string, clientX: number, pointerId = 1, button = 0): void {
  act(() => { handle.dispatchEvent(new PointerEvent(type, { pointerId, clientX, button, bubbles: true })) })
}

/** The splitter between the panes. */
function splitter(container: HTMLElement): Element {
  const handle = container.querySelector('[data-workstation-resizer]')
  if (handle === null) throw new Error('missing workstation resizer')
  return handle
}

/** The drawn tree column. */
function treeColumn(container: HTMLElement): HTMLElement {
  const tree = container.querySelector<HTMLElement>('[data-workstation-tree]')
  if (tree === null) throw new Error('missing workstation tree')
  return tree
}

const restoreProperties: (() => void)[] = []

beforeEach(() => {
  // jsdom has no pointer capture: each element retains the actual pointer id.
  const captured = new WeakMap<Element, number>()
  const methods: [string, (this: Element, id: number) => unknown][] = [
    ['setPointerCapture', function (this: Element, id: number) { captured.set(this, id) }],
    ['releasePointerCapture', function (this: Element) { captured.delete(this) }],
    ['hasPointerCapture', function (this: Element, id: number) { return captured.get(this) === id }],
  ]
  for (const [key, value] of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, key)
    restoreProperties.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, key)
      else Object.defineProperty(Element.prototype, key, descriptor)
    })
    Object.defineProperty(Element.prototype, key, { configurable: true, writable: true, value })
  }
})

afterEach(() => {
  cleanup()
  for (const restore of restoreProperties.splice(0).reverse()) restore()
})

describe('Workstation', () => {
  it('lists the root level and fills the viewer with a clicked file', async () => {
    const { getByTitle, getByRole, instance, list } = mountSeat()

    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    expect(getByRole('tree')).toBeTruthy()

    fireEvent.click(getByTitle('README.md'))

    await waitFor(() => { expect(instance.getSnapshot().viewer.lines).toEqual(['alpha', 'beta']) })
    expect(instance.getSnapshot().viewer.path).toBe(`${ROOT}/README.md`)
    expect(instance.getSnapshot().viewer.eof).toBe(true)
  })

  it('asks for nothing while no Session is selected', () => {
    const { getByText, list } = mountSeat(null)

    expect(getByText(zh['session.none'])).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
  })

  it('draws the tree at the stored width beside the splitter and the viewer', () => {
    const { container, instance } = mountSeat()

    expect(treeColumn(container).style.width).toBe('260px')
    expect(splitter(container).getAttribute('role')).toBe('separator')
    expect(instance.getSnapshot().treeWidth).toBe(260)
  })

  it('resizes the tree through the splitter and clamps the reported width', () => {
    const { container, instance } = mountSeat()
    const handle = splitter(container)

    pointer(handle, 'pointerdown', 260)
    pointer(handle, 'pointermove', 360)
    pointer(handle, 'pointerup', 360)
    expect(instance.getSnapshot().treeWidth).toBe(360)
    expect(treeColumn(container).style.width).toBe('360px')

    pointer(handle, 'pointerdown', 360)
    pointer(handle, 'pointermove', -2000)
    pointer(handle, 'pointerup', -2000)
    expect(instance.getSnapshot().treeWidth).toBe(180)
    expect(treeColumn(container).style.width).toBe('180px')

    pointer(handle, 'pointerdown', 180)
    pointer(handle, 'pointermove', 5000)
    pointer(handle, 'pointerup', 5000)
    expect(instance.getSnapshot().treeWidth).toBe(520)
    expect(treeColumn(container).style.width).toBe('520px')
  })
})
