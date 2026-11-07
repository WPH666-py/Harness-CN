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
import { REMOTE_HOSTS_EMPTY } from '../src/client/remote.ts'
import type { RemoteDirectory, RemoteFiles, RemoteHostsView } from '../src/client/remote.ts'
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

/** The refusal the text read answers for a file whose bytes are not UTF-8. */
function notText(path: string) {
  return { ok: false, error: new RemoteError('workspace-file/not-text', 'not text', { path }) }
}

/** A whole-file byte read, as the Host answers one after refusing the text read. */
function wholeBytes(path: string, data: Uint8Array<ArrayBuffer>) {
  return {
    ok: true,
    value: { absolutePath: path, version: '1', path, offset: 0, bytes: data.byteLength, data, eof: true },
  }
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

/** The host every remote case browses. */
const HOST = 'host-1'

/** That host's display name, which the tree header shows instead of 工作区. */
const HOST_NAME = 'builder'

/** The one file the server tree offers, whose name a search also matches. */
const SERVER_FILE = '/etc/nginx.conf'

/** The Remote calls the seat makes against a host, scripted over one small server tree. */
interface RemoteScripted {
  readonly files: RemoteFiles
  readonly list: ReturnType<typeof vi.fn>
  readonly read: ReturnType<typeof vi.fn>
  readonly write: ReturnType<typeof vi.fn>
  readonly search: ReturnType<typeof vi.fn>
}

/**
 * A host reachable through the plugin's routes: a root with one directory, one
 * text file, and a search that finds it.
 * @returns the calls, and the `RemoteFiles` bundle the face receives.
 */
function remoteScripted(): RemoteScripted {
  const levels: Record<string, RemoteDirectory['entries']> = {
    '/': [{ name: 'etc', path: '/etc', type: 'directory', size: 4096 }],
    '/etc': [{ name: 'nginx.conf', path: SERVER_FILE, type: 'file', size: 12 }],
  }
  const list = vi.fn(async (_hostId: string, path: string) => ({
    ok: true as const,
    value: { path, entries: levels[path] ?? [], truncated: false },
  }))
  const read = vi.fn(async (_hostId: string, path: string) => ({
    ok: true as const,
    value: { path, text: 'worker_processes 1;', version: 'v1', size: 19 },
  }))
  const write = vi.fn(async (_hostId: string, _path: string) => ({
    ok: true as const,
    value: { version: 'v2' },
  }))
  const search = vi.fn(async (_hostId: string, _query: string, _root: string) => ({
    ok: true as const,
    value: { results: [{ path: SERVER_FILE, name: 'nginx.conf' }], truncated: false },
  }))
  return { files: { list, read, write, search }, list, read, write, search }
}

/** Mount the seat over a fresh store instance and the scripted Remote. */
function mountSeat(cwd: string | null = ROOT, options: { readonly hosts?: RemoteHostsView } = {}) {
  const directory = cwd ?? undefined
  const instance = createWorkstationStore().create()
  const controller = new AbortController()
  const { remote, list, read, readBytes, write } = scripted()
  const remoteFiles = remoteScripted()
  const hosts = options.hosts ?? REMOTE_HOSTS_EMPTY
  const face = workstationFace({
    remote,
    remoteFiles: remoteFiles.files,
    sessionId: () => (directory === undefined ? undefined : SESSION),
    remoteHostId: () => hosts.currentHostId,
    signal: controller.signal,
  })(instance.actions)
  const props = {
    useStore: hookOf(instance),
    actions: instance.actions,
    useSessions: hookOf(sessionsOf(directory)),
    useSessionId: hookOf({ getSnapshot: () => (directory === undefined ? undefined : SESSION), subscribe: () => () => {} }),
    useRemoteHosts: hookOf({ getSnapshot: () => hosts, subscribe: () => () => {} }),
    t: translate,
    ...face,
  } as unknown as WorkstationProps
  return { ...render(<Workstation {...props} />), instance, list, read, readBytes, write, remote: remoteFiles }
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

/** The gutter's number column. */
function gutterOf(container: HTMLElement): HTMLElement {
  const numbers = container.querySelector<HTMLElement>('[data-workstation-line-numbers]')
  if (numbers === null) throw new Error('missing line numbers')
  return numbers
}

/** The band drawn behind the line holding the caret. */
function bandOf(container: HTMLElement): HTMLElement {
  const band = container.querySelector<HTMLElement>('[data-workstation-current-line]')
  if (band === null) throw new Error('missing current-line band')
  return band
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

  it('numbers every line beside a horizontally scrolling editor', async () => {
    const handle = mountSeat()
    const { container } = handle

    const area = await openEditor(handle, 'README.md')
    const gutter = gutterOf(container)

    expect(gutter.textContent).toBe('1\n2')
    expect(gutter.style.width).toBe('1ch')
    expect(area.getAttribute('wrap')).toBe('off')
  })

  it('widens the gutter once the file reaches a second digit', async () => {
    const handle = mountSeat()
    const { container } = handle

    const area = await openEditor(handle, 'README.md')
    fireEvent.change(area, { target: { value: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11' } })

    expect(gutterOf(container).textContent).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11')
    expect(gutterOf(container).style.width).toBe('2ch')
  })

  it('moves the caret band to the line the caret sits on', async () => {
    const handle = mountSeat()
    const { container } = handle

    const area = await openEditor(handle, 'README.md')
    expect(bandOf(container).dataset.workstationCurrentLine).toBe('1')

    area.setSelectionRange(8, 8)
    fireEvent.keyUp(area, { key: 'ArrowDown' })
    expect(bandOf(container).dataset.workstationCurrentLine).toBe('2')

    area.setSelectionRange(0, 0)
    fireEvent.click(area)
    expect(bandOf(container).dataset.workstationCurrentLine).toBe('1')
  })

  it('keeps the gutter on the scrolled line and pins it horizontally', async () => {
    const handle = mountSeat()
    const { container } = handle

    const area = await openEditor(handle, 'README.md')
    stubProperty(area, 'scrollTop', 38)
    fireEvent.scroll(area)

    expect(gutterOf(container).style.transform).toBe('translateY(-38px)')
    expect(bandOf(container).style.top).toBe('-38px')
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
      error: new RemoteError('workspace-file/not-found', 'not text', { path: README }),
    })
    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    fireEvent.click(getByTitle('README.md'))

    await waitFor(() => { expect(instance.getSnapshot().tabs[0]?.failure).toBe('not text') })
    expect(tabsOf(container)).toHaveLength(1)
    const alert = handle.getByRole('alert')
    expect(alert.textContent).toBe(translate('viewer.failed', { message: 'not text' }))
    expect(container.querySelector('[data-workstation-editor]')).toBeNull()
  })

  it('opens a file the text verb refuses as GB18030 text, read-only', async () => {
    const handle = mountSeat()
    const { container, getByTitle, instance, read, readBytes, write } = handle

    read.mockResolvedValueOnce(notText(README))
    // 中文 in GB18030, the encoding the text verb refuses as not UTF-8.
    readBytes.mockResolvedValueOnce(wholeBytes(README, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])))
    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    fireEvent.click(getByTitle('README.md'))

    const area = await waitFor(() => editorOf(container))
    expect(readBytes).toHaveBeenCalledWith(SESSION, README, {}, expect.any(AbortSignal))
    expect(area.value).toBe('中文')
    expect(area.readOnly).toBe(true)
    expect(instance.getSnapshot().tabs[0]).toMatchObject({ kind: 'text', encoding: 'gb18030', failure: null })
    expect(handle.getByText(translate('viewer.readOnly', { encoding: 'GB18030' }))).toBeTruthy()

    fireEvent.keyDown(area, { key: 's', ctrlKey: true })
    expect(write).not.toHaveBeenCalled()
  })

  it('draws a binary placeholder with the file size instead of an editor', async () => {
    const handle = mountSeat()
    const { container, getByTitle, instance, read, readBytes, write } = handle

    read.mockResolvedValueOnce(notText(README))
    // Four bytes of PNG signature: no encoding in the chain accepts them.
    readBytes.mockResolvedValueOnce({
      ok: true,
      value: {
        absolutePath: README,
        version: '1',
        path: README,
        offset: 0,
        bytes: 1024,
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0xff]),
        eof: true,
      },
    })
    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    fireEvent.click(getByTitle('README.md'))

    const placeholder = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-workstation-binary]')
      expect(node).toBeTruthy()
      if (node === null) throw new Error('missing binary placeholder')
      return node
    })
    expect(placeholder.textContent).toBe(translate('viewer.binary', { size: '1.0 KB' }))
    expect(instance.getSnapshot().tabs[0]).toMatchObject({ kind: 'binary', size: 1024, failure: null })
    expect(container.querySelector('[data-workstation-editor]')).toBeNull()

    fireEvent.click(closeOf(container, README))
    await waitFor(() => { expect(tabsOf(container)).toHaveLength(0) })
    expect(write).not.toHaveBeenCalled()
  })

  it('reports the byte read when the fallback after not-text fails too', async () => {
    const handle = mountSeat()
    const { container, getByTitle, instance, read, readBytes } = handle

    read.mockResolvedValueOnce(notText(README))
    readBytes.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('workspace-file/not-found', 'gone', { path: README }),
    })
    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    fireEvent.click(getByTitle('README.md'))

    await waitFor(() => { expect(instance.getSnapshot().tabs[0]?.failure).toBe('gone') })
    expect(handle.getByRole('alert').textContent).toBe(translate('viewer.failed', { message: 'gone' }))
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

  it('browses the current server instead of the workspace, even with no Session', async () => {
    const handle = mountSeat(null, { hosts: { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] } })
    const { container, remote, list } = handle

    const row = await waitFor(() => {
      const node = container.querySelector('[data-workstation-path="/etc"]')
      expect(node).toBeTruthy()
      return node as Element
    })
    expect(row.textContent).toContain('etc')
    expect(remote.list).toHaveBeenCalledWith(HOST, '/')
    expect(list).not.toHaveBeenCalled()
    expect(container.querySelector('[data-workstation-state="no-session"]')).toBeNull()
    expect(treeColumn(container).textContent).toContain(HOST_NAME)
  })

  it('searches the server from the tree header and clears back to the tree', async () => {
    const handle = mountSeat(null, { hosts: { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] } })
    const { container, remote } = handle

    const toggle = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-workstation-search-toggle]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(toggle)
    const input = container.querySelector<HTMLInputElement>('[data-workstation-search-input]')
    expect(input).toBeTruthy()
    fireEvent.change(input as HTMLInputElement, { target: { value: 'nginx' } })

    await waitFor(() => { expect(remote.search).toHaveBeenCalledWith(HOST, 'nginx', '/') }, { timeout: 2_000 })
    const hit = await waitFor(() => {
      const node = container.querySelector('[data-workstation-search-result="/etc/nginx.conf"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(hit)
    await waitFor(() => { expect(tabsOf(container)[0]?.getAttribute('data-workstation-tab')).toBe(SERVER_FILE) })

    fireEvent.keyDown(input as HTMLInputElement, { key: 'Escape' })
    await waitFor(() => { expect(container.querySelector('[data-workstation-search-result]')).toBeNull() })
    expect(container.querySelector('[data-workstation-path="/etc"]')).toBeTruthy()
    expect(container.querySelector('[data-workstation-search-input]')).toBeNull()
  })

  it('names the server when a file cannot be read from it', async () => {
    const handle = mountSeat(null, { hosts: { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] } })
    const { container, remote } = handle
    remote.read.mockResolvedValueOnce({ ok: false, failure: { code: 'SSH_SFTP_FAILED', message: 'permission denied' } })

    const directory = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-workstation-path="/etc"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(directory)
    fireEvent.click(await waitFor(() => handle.getByTitle('nginx.conf')))

    await waitFor(() => { expect(handle.getByRole('alert').textContent).toBe(translate('viewer.remoteFailed', { message: 'permission denied' })) })
    expect(container.querySelector('[data-workstation-editor]')).toBeNull()
  })

  it('saves a server file with the version the read reported', async () => {
    const handle = mountSeat(null, { hosts: { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] } })
    const { container, remote } = handle

    const directory = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-workstation-path="/etc"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(directory)
    fireEvent.click(await waitFor(() => handle.getByTitle('nginx.conf')))
    const area = await waitFor(() => editorOf(container))
    fireEvent.change(area, { target: { value: 'worker_processes 2;' } })
    fireEvent.keyDown(area, { key: 's', ctrlKey: true })

    await waitFor(() => { expect(remote.write).toHaveBeenCalledWith(HOST, SERVER_FILE, 'worker_processes 2;', 'v1') })
    await waitFor(() => { expect(handle.instance.getSnapshot().tabs[0]?.version).toBe('v2') })
    expect(handle.instance.getSnapshot().tabs[0]?.dirty).toBe(false)
  })

  it('carries its own way off a server page that has no session to hang the header on', async () => {
    const hosts = { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] }
    const { container, getByText } = mountSeat(null, { hosts })
    await waitFor(() => { expect(container.querySelector('[data-server-leave]')).toBeTruthy() })
    expect(getByText('退出服务器页面')).toBeTruthy()
  })

  it('leaves the exit to the header while a session is open', async () => {
    const hosts = { currentHostId: HOST, hosts: [{ hostId: HOST, displayName: HOST_NAME }] }
    const { container } = mountSeat(ROOT, { hosts })
    await waitFor(() => { expect(container.querySelector('[data-workstation-tree]')).toBeTruthy() })
    expect(container.querySelector('[data-server-leave]')).toBeNull()
  })
})
