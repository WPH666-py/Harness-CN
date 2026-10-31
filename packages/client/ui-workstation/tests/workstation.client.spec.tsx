/**
 * The seat's own spec: a real store instance, a scripted Remote, and the tree,
 * tab strip, editor, and preview drawing exactly what the face settled into the
 * store.
 *
 * The seat's contract is narrow on purpose — a level loads when the tree first
 * draws it, a file click opens a tab, the editor's buffer is what the close and
 * Ctrl+S gestures write — so these cases cover the promise without reaching for
 * a fake of the whole client runtime. The splitter is driven directly, because
 * the store owns the width it settles; the object-URL API is stubbed because
 * jsdom does not implement it.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryEntry, WorkspaceFileMutation } from '@deepseek-ai/dsh-api-workspace-files/types'
import { workstationFace } from '../src/client/face.ts'
import type { WorkspaceFileWrite, WorkspaceFilesHostRemote } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'
import { createWorkstationStore } from '../src/client/store.ts'
import { Workstation } from '../src/client/Workstation.tsx'
import type { WorkstationProps } from '../src/client/Workstation.tsx'

/** The Session the whole spec pretends is on screen. */
const SESSION = 'session-workstation' as SessionId

/** The working directory that Session reports, which the tree lists first. */
const ROOT = 'C:\\ws\\workstation'

/** The text file every read gesture opens, and the copy the write must carry. */
const README = `${ROOT}/README.md`

/** A second text file, so two tabs can be open at once. */
const NOTES = `${ROOT}/notes.txt`

/** An image file: the viewer reads its bytes instead of its text. */
const PIXEL = `${ROOT}/pixel.png`

/** The dictionary the seat's copy comes from; the component is asserted in it. */
const translate = makeTranslate(zh)

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

/** A promise a spec settles by hand, so it can observe the in-flight state. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** The Remote verbs the seat calls, scripted over one small tree. */
interface Scripted {
  readonly remote: WorkspaceFilesHostRemote
  readonly list: ReturnType<typeof vi.fn>
  readonly read: ReturnType<typeof vi.fn>
  readonly readBytes: ReturnType<typeof vi.fn>
  readonly write: ReturnType<typeof vi.fn>
}

/** A Remote face that answers one directory tree, its text files, and one image. */
function scripted(): Scripted {
  /** Each file's text; the read verb answers the whole file in one page. */
  const files: Record<string, string> = {
    [README]: 'alpha\nbeta',
    [NOTES]: 'one note',
    [`${ROOT}/src/index.ts`]: 'export {}',
  }
  /** Each directory answers with its own children, so no name repeats in the tree. */
  const levels: Record<string, WorkspaceDirectoryEntry[]> = {
    [ROOT]: [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 11 },
      { name: 'notes.txt', type: 'file', size: 8 },
      { name: 'pixel.png', type: 'file', size: 4 },
    ],
    [`${ROOT}/src`]: [{ name: 'index.ts', type: 'file', size: 9 }],
  }
  const list = vi.fn(async (_session: SessionId, path: string) => ({
    ok: true as const,
    value: { path, entries: levels[path] ?? [], truncated: false },
  }))
  const read = vi.fn(async (_session: SessionId, path: string) => {
    const text = files[path] ?? ''
    return {
      ok: true as const,
      value: {
        absolutePath: path,
        version: '1',
        path,
        size: text.length,
        offset: 1,
        text,
        lines: text.split('\n').length,
        eof: true,
      },
    }
  })
  const readBytes = vi.fn(async (_session: SessionId, path: string) => ({
    ok: true as const,
    value: {
      absolutePath: path,
      version: '1',
      path,
      offset: 0,
      bytes: 4,
      data: new Uint8Array([137, 80, 78, 71]),
      eof: true,
    },
  }))
  const write = vi.fn<WorkspaceFileWrite>(async (_session, path) => ({
    ok: true,
    value: { absolutePath: path, version: '2', path },
  }))
  return {
    remote: { workspaceFiles: { list, read, readBytes, write } } as WorkspaceFilesHostRemote,
    list,
    read,
    readBytes,
    write,
  }
}

/** Mount the seat over a fresh store instance and the scripted Remote. */
function mountSeat(cwd: string | null = ROOT) {
  const directory = cwd ?? undefined
  const instance = createWorkstationStore().create()
  const controller = new AbortController()
  const { remote, list, read, readBytes, write } = scripted()
  const face = workstationFace({ remote, sessionId: () => (directory === undefined ? undefined : SESSION), signal: controller.signal })(instance.actions)
  const props = {
    useStore: hookOf(instance),
    actions: instance.actions,
    useSessions: hookOf(sessionsOf(directory)),
    useSessionId: hookOf({ getSnapshot: () => (directory === undefined ? undefined : SESSION), subscribe: () => () => {} }),
    t: translate,
    ...face,
  } as unknown as WorkstationProps
  return { ...render(<Workstation {...props} />), instance, list, read, readBytes, write }
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

/** Every open tab's focus button, in strip order. */
function tabsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-workstation-tab]')]
}

/** One tab's focus button, by path. */
function tabOf(container: HTMLElement, path: string): HTMLElement {
  const button = tabsOf(container).find(node => node.dataset.workstationTab === path)
  if (button === undefined) throw new Error(`missing tab for ${path}`)
  return button
}

/** One tab's close button, by path. */
function closeOf(container: HTMLElement, path: string): HTMLElement {
  const button = [...container.querySelectorAll<HTMLElement>('[data-workstation-tab-close]')]
    .find(node => node.dataset.workstationTabClose === path)
  if (button === undefined) throw new Error(`missing close button for ${path}`)
  return button
}

/** The active tab's textarea. */
function editorOf(container: HTMLElement): HTMLTextAreaElement {
  const area = container.querySelector<HTMLTextAreaElement>('[data-workstation-editor]')
  if (area === null) throw new Error('missing workstation editor')
  return area
}

/** The image preview's container. */
function previewOf(container: HTMLElement): HTMLElement {
  const preview = container.querySelector<HTMLElement>('[data-workstation-preview]')
  if (preview === null) throw new Error('missing workstation preview')
  return preview
}

/**
 * Open one tree row and wait for the active tab's editor.
 * @param handle - the mounted seat.
 * @param name - the row's title, which is the entry's basename.
 * @returns the editor, once the read has settled.
 */
async function openEditor(
  handle: ReturnType<typeof mountSeat>,
  name: string,
): Promise<HTMLTextAreaElement> {
  await waitFor(() => { expect(handle.getByTitle(name)).toBeTruthy() })
  fireEvent.click(handle.getByTitle(name))
  return waitFor(() => editorOf(handle.container))
}

/** Object-URL stubs jsdom lacks, captured so the image spec can assert the revoke. */
const objectUrls = {
  create: vi.fn(() => 'blob:workstation'),
  revoke: vi.fn(),
}

const restoreProperties: (() => void)[] = []

/** Replace one prototype property, remembering how to put it back. */
function stubProperty(target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  restoreProperties.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, descriptor)
  })
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
}

beforeEach(() => {
  // jsdom has no pointer capture: each element retains the actual pointer id.
  const captured = new WeakMap<Element, number>()
  const methods: [string, (this: Element, id: number) => unknown][] = [
    ['setPointerCapture', function (this: Element, id: number) { captured.set(this, id) }],
    ['releasePointerCapture', function (this: Element) { captured.delete(this) }],
    ['hasPointerCapture', function (this: Element, id: number) { return captured.get(this) === id }],
  ]
  for (const [key, value] of methods) stubProperty(Element.prototype, key, value)
  // jsdom has no object-URL implementation either: the preview's blob URL is scripted.
  objectUrls.create.mockClear()
  objectUrls.revoke.mockClear()
  stubProperty(URL, 'createObjectURL', objectUrls.create)
  stubProperty(URL, 'revokeObjectURL', objectUrls.revoke)
})

afterEach(() => {
  cleanup()
  for (const restore of restoreProperties.splice(0).reverse()) restore()
})

describe('Workstation', () => {
  it('lists the root level and opens a clicked file in an editor', async () => {
    const handle = mountSeat()
    const { container, getByTitle, getByRole, instance, list } = handle

    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    expect(getByRole('tree')).toBeTruthy()

    const area = await openEditor(handle, 'README.md')
    expect(area.value).toBe('alpha\nbeta')
    expect(instance.getSnapshot().activePath).toBe(README)
    expect(tabsOf(container)).toHaveLength(1)
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

  it('opens one tab per file and focuses the clicked tab', async () => {
    const handle = mountSeat()
    const { container, instance } = handle

    await openEditor(handle, 'README.md')
    await openEditor(handle, 'notes.txt')
    expect(tabsOf(container).map(node => node.dataset.workstationTab)).toEqual([README, NOTES])
    expect(instance.getSnapshot().activePath).toBe(NOTES)

    fireEvent.click(tabOf(container, README))
    expect(instance.getSnapshot().activePath).toBe(README)
    expect(editorOf(container).value).toBe('alpha\nbeta')

    fireEvent.click(tabOf(container, NOTES))
    expect(instance.getSnapshot().activePath).toBe(NOTES)
    expect(editorOf(container).value).toBe('one note')
  })

  it('marks a tab dirty while its buffer differs from the saved copy', async () => {
    const handle = mountSeat()
    const { container, getByText, instance } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.change(area, { target: { value: 'alpha\nbeta!' } })

    expect(instance.getSnapshot().tabs[0]).toMatchObject({ text: 'alpha\nbeta!', dirty: true })
    expect(getByText(zh['tab.unsaved'])).toBeTruthy()
    expect(closeOf(container, README).getAttribute('aria-label')).toBe(zh['tab.closeSave'])
  })

  it('indents two spaces when Tab is pressed in the editor', async () => {
    const handle = mountSeat()
    const { instance } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.keyDown(area, { key: 'Tab' })

    expect(instance.getSnapshot().tabs[0]?.text).toBe('  alpha\nbeta')
  })

  it('saves the active tab on Ctrl+S and clears the dirty flag', async () => {
    const handle = mountSeat()
    const { instance, write } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.change(area, { target: { value: 'alpha\nbeta!' } })
    fireEvent.keyDown(area, { key: 's', ctrlKey: true })

    await waitFor(() => { expect(write).toHaveBeenCalledTimes(1) })
    expect(write).toHaveBeenCalledWith(SESSION, README, 'alpha\nbeta!', expect.any(AbortSignal))
    await waitFor(() => { expect(instance.getSnapshot().tabs[0]?.dirty).toBe(false) })
    expect(instance.getSnapshot().tabs[0]?.saved).toBe('alpha\nbeta!')
  })

  it('writes a dirty tab before closing it', async () => {
    const handle = mountSeat()
    const { container, instance, write } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.change(area, { target: { value: 'alpha\nbeta!' } })
    const gate = deferred<RemoteResult<WorkspaceFileMutation>>()
    write.mockReturnValueOnce(gate.promise)

    fireEvent.click(closeOf(container, README))
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(SESSION, README, 'alpha\nbeta!', expect.any(AbortSignal))
    expect(tabsOf(container)).toHaveLength(1)

    await act(async () => {
      gate.resolve({ ok: true, value: { absolutePath: README, version: '2', path: README } })
    })
    await waitFor(() => { expect(tabsOf(container)).toHaveLength(0) })
    expect(instance.getSnapshot().tabs).toEqual([])
  })

  it('closes a clean tab without writing it', async () => {
    const handle = mountSeat()
    const { container, getByText, write } = handle

    await openEditor(handle, 'notes.txt')
    fireEvent.click(closeOf(container, NOTES))

    await waitFor(() => { expect(tabsOf(container)).toHaveLength(0) })
    expect(write).not.toHaveBeenCalled()
    expect(getByText(zh['viewer.empty'])).toBeTruthy()
  })

  it('keeps a refusing tab open and reports the save failure', async () => {
    const handle = mountSeat()
    const { container, instance, write } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.change(area, { target: { value: 'changed' } })
    write.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('workspace-file/not-found', 'disk full', { path: README }),
    })

    fireEvent.click(closeOf(container, README))
    await waitFor(() => { expect(instance.getSnapshot().tabs[0]?.failure).toBe('disk full') })

    expect(tabsOf(container)).toHaveLength(1)
    expect(instance.getSnapshot().tabs[0]?.dirty).toBe(true)
    const alert = handle.getByRole('alert')
    expect(alert.getAttribute('data-workstation-tab-status')).not.toBeNull()
    expect(alert.textContent).toBe(translate('tab.saveFailed', { message: 'disk full' }))
  })

  it('reports a read the Host refuses and does not offer an editor', async () => {
    const handle = mountSeat()
    const { container, getByTitle, instance, read } = handle

    read.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('workspace-file/not-text', 'not text', { path: README }),
    })
    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    fireEvent.click(getByTitle('README.md'))

    await waitFor(() => { expect(instance.getSnapshot().tabs[0]?.failure).toBe('not text') })
    expect(tabsOf(container)).toHaveLength(1)
    const alert = handle.getByRole('alert')
    expect(alert.textContent).toBe(translate('viewer.failed', { message: 'not text' }))
    expect(container.querySelector('[data-workstation-editor]')).toBeNull()
  })

  it('previews an image from its bytes and releases the blob URL on close', async () => {
    const handle = mountSeat()
    const { container, getByTitle, readBytes } = handle

    await waitFor(() => { expect(getByTitle('pixel.png')).toBeTruthy() })
    fireEvent.click(getByTitle('pixel.png'))
    await waitFor(() => {
      expect(readBytes).toHaveBeenCalledWith(SESSION, PIXEL, {}, expect.any(AbortSignal))
    })

    const preview = await waitFor(() => previewOf(container))
    const image = await waitFor(() => {
      const drawn = preview.querySelector('img')
      expect(drawn).toBeTruthy()
      return drawn as HTMLImageElement
    })
    expect(image.getAttribute('src')).toBe('blob:workstation')
    expect(image.getAttribute('alt')).toBe(translate('preview.image'))
    expect(handle.getByText(translate('preview.size', { size: '4 B' }))).toBeTruthy()

    fireEvent.click(closeOf(container, PIXEL))
    await waitFor(() => { expect(tabsOf(container)).toHaveLength(0) })
    await waitFor(() => { expect(objectUrls.revoke).toHaveBeenCalledWith('blob:workstation') })
  })
})
