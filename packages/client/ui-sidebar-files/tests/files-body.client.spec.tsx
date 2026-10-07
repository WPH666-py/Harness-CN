// @vitest-environment jsdom
/**
 * The body against a scripted listing.
 *
 * What is asserted is the reader's contract: the root lists itself on mount,
 * rows come out directories-first, a directory click asks for exactly that
 * level, a file click opens exactly that session-scoped `file:` address through
 * the owner, an `other` entry is shown but not clickable, the tree says when it
 * was cut or could not be read, and reload asks again for the expanded levels
 * only. The file operations add the other half: a row is selectable and stays
 * selected, the header's controls and the row's own menu reach the Remote verb
 * each gesture names, the name input commits and cancels where the reader says
 * so, a removal waits for the confirmation the reader gives in the UI, and a
 * refused gesture says why instead of doing nothing. The pure helpers the rows
 * are built from are checked on their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileMutation } from '@deepseek-ai/dsh-api-workspace-files/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { destinationOf, failureLine, gestureLine, orderEntries } from '../src/client/FilesBody.tsx'
import type { DirLevel, FilesTabState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import { mountBody, ROOT, SESSION, TAB } from './mount.client.tsx'

const ROOT_LEVEL: DirLevel = {
  entries: [
    { name: 'README.md', type: 'file', size: 12 },
    { name: 'src', type: 'directory' },
    { name: '.env', type: 'file', size: 2 },
    { name: 'pipe', type: 'other' },
  ],
  truncated: false,
}

/** What a create-like gesture answers: the entry it produced. */
const CREATED: WorkspaceFileMutation = { absolutePath: `${ROOT}/notes.txt`, version: 'v1', path: 'notes.txt' }

const EMPTY: DirLevel = { entries: [], truncated: false }

afterEach(() => { cleanup() })

/** Row labels in document order. */
function names(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-files-entry]')].map(li => li.getAttribute('data-files-path')!)
}

/** The button of one entry's row. */
function row(view: RenderResult, path: string): HTMLElement {
  const found = view.container.querySelector<HTMLElement>(`[data-files-path="${path}"] > button`)
  if (found === null) throw new Error(`no row at ${path}`)
  return found
}

/** Absolute paths of the rows the tree currently marks as selected. */
function selectedPaths(view: RenderResult): string[] {
  return [...view.container.querySelectorAll<HTMLElement>('[data-files-entry] > button[data-files-selected]')]
    .map(button => button.parentElement!.getAttribute('data-files-path')!)
}

/** Right-click one row, where the pointer asked for the menu. */
function contextMenu(view: RenderResult, path: string): void {
  fireEvent.contextMenu(row(view, path), { clientX: 40, clientY: 80 })
}

/** The context menu's rows, in display order; the menu portals out of the view. */
function menuLabels(view: RenderResult): string[] {
  return [...view.baseElement.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent ?? '')
}

/** Click one row of the open context menu by its label. */
function pickMenuItem(view: RenderResult, label: string): void {
  const item = [...view.baseElement.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(candidate => candidate.textContent === label)
  if (item === undefined) throw new Error(`no menu item labelled ${label}`)
  fireEvent.click(item)
}

/** Click the one control carrying a label — the confirmation's own buttons. */
function pickButton(view: RenderResult, label: string): void {
  const button = [...view.baseElement.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  fireEvent.click(button)
}

/** The open name input, if the tree is waiting for one. */
function draftInput(view: RenderResult, kind: 'file' | 'directory'): HTMLInputElement {
  const input = view.container.querySelector<HTMLInputElement>(`[data-files-draft="${kind}"] input`)
  if (input === null) throw new Error(`no ${kind} name input`)
  return input
}

describe('FilesBody', () => {
  it('says so when the session has no workspace directory, and asks for nothing', () => {
    const { view, script } = mountBody(null)
    expect(view.container.querySelector('[data-files-state="no-workspace"]')?.textContent).toBe(zh.noWorkspace)
    expect(script.list).not.toHaveBeenCalled()
  })

  it('lists the root on mount, heads it with its path split at the last segment, and draws directories first with dotfiles kept', async () => {
    const { view, script } = mountBody()
    expect(script.list).toHaveBeenCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    expect(view.container.querySelector('[data-files-row="loading"]')).not.toBeNull()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(view.container.querySelector('[data-files-state="tree"]')?.getAttribute('data-files-root')).toBe(ROOT)
    const path = view.container.querySelector('[data-files-path]')
    expect(path?.getAttribute('title')).toBe(ROOT)
    expect([...path?.querySelectorAll('span > span') ?? []].map(span => span.textContent)).toEqual(['/work/', 'app'])
    expect(names(view.container)).toEqual([`${ROOT}/src`, `${ROOT}/.env`, `${ROOT}/pipe`, `${ROOT}/README.md`])
    const envIcon = view.container.querySelector(`[data-files-path="${ROOT}/.env"] svg`)?.innerHTML
    const readmeIcon = view.container.querySelector(`[data-files-path="${ROOT}/README.md"] svg`)?.innerHTML
    expect(envIcon).not.toBe(readmeIcon)
  })

  it('heads a separator-only root by the root itself, since it has no final segment', async () => {
    const { view, script } = mountBody('/')
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const path = view.container.querySelector('[data-files-path]')
    expect([...path?.querySelectorAll('span > span') ?? []].map(span => span.textContent)).toEqual(['/'])
    expect(names(view.container)).toEqual(['/src', '/.env', '/pipe', '/README.md'])
  })

  it('marks the root path clipped while its text is wider than its box, re-reading on resize', async () => {
    class FakeResizeObserver implements ResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.latest = this
      }

      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    let boxWidth = 300
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => boxWidth })
    try {
      const { view, script } = mountBody()
      await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
      const path = view.container.querySelector<HTMLElement>('[data-files-path]')
      const text = path?.firstElementChild
      expect(path?.hasAttribute('data-files-path-clipped')).toBe(false)
      const observer = FakeResizeObserver.latest
      if (observer === undefined) throw new Error('expected the path to observe its size')
      expect(observer.observe).toHaveBeenCalledWith(path)
      expect(observer.observe).toHaveBeenCalledWith(text)

      boxWidth = 120
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-files-path-clipped')).toBe(true)

      boxWidth = 300
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-files-path-clipped')).toBe(false)
      view.unmount()
      expect(observer.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      for (const [name, descriptor] of [['offsetWidth', offsetWidth], ['clientWidth', clientWidth]] as const) {
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })

  it('a directory click lists that level once and marks it expanded; a second click collapses without asking again', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const dir = view.container.querySelector(`[data-files-path="${ROOT}/src"] > button`)!
    act(() => { fireEvent.click(dir) })
    expect(script.list).toHaveBeenLastCalledWith(SESSION, `${ROOT}/src`, expect.any(AbortSignal))
    expect(dir.getAttribute('aria-expanded')).toBe('true')
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'a.ts', type: 'file' }], truncated: false } }))
    expect(names(view.container)).toContain(`${ROOT}/src/a.ts`)
    act(() => { fireEvent.click(dir) })
    expect(dir.getAttribute('aria-expanded')).toBe('false')
    expect(names(view.container)).not.toContain(`${ROOT}/src/a.ts`)
    act(() => { fireEvent.click(dir) })
    expect(names(view.container)).toContain(`${ROOT}/src/a.ts`)
    expect(script.list).toHaveBeenCalledTimes(2)
  })

  it('a file click opens its session-scoped file: address through the owner; an other entry offers no button', async () => {
    const { view, script, tabActions } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    fireEvent.click(view.container.querySelector(`[data-files-path="${ROOT}/README.md"] > button`)!)
    // Every row sits under the tree's root, so the address is the path relative to it.
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, ROOT, `${ROOT}/README.md`))
    expect(tabActions.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s-test/README.md')
    const other = view.container.querySelector(`[data-files-path="${ROOT}/pipe"]`)!
    expect(other.querySelector('button')).toBeNull()
    expect(other.querySelector('[aria-disabled="true"]')?.getAttribute('title')).toBe(zh['entry.other'])
  })

  it('marks a cut listing and an empty one', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'd', type: 'directory' }], truncated: true } }))
    expect(view.container.querySelector('[data-files-row="truncated"]')?.textContent).toBe(zh.truncated)
    act(() => { fireEvent.click(view.container.querySelector(`[data-files-path="${ROOT}/d"] > button`)!) })
    await act(() => script.settle({ ok: true, value: { entries: [], truncated: false } }))
    expect(view.container.querySelector('[data-files-row="empty"]')?.textContent).toBe(zh.empty)
  })

  it('shows a failed level under its directory with the failure code', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({
      ok: false,
      error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }),
    }))
    const failed = view.container.querySelector('[data-files-row="failed"]')
    expect(failed?.getAttribute('data-files-code')).toBe('workspace-file/not-found')
    expect(failed?.textContent).toBe(zh['error.notFound'])
  })

  it('reload resets every level and lists the expanded ones again', async () => {
    const { view, script, controller, instance } = mountBody()
    const child = `${ROOT}/src`
    const collapsed = `${ROOT}/docs`
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(view.container.querySelector(`[data-files-path="${child}"] > button`)!) })
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    // A level listed earlier and since collapsed is dropped, not re-fetched.
    act(() => { instance.actions.loaded(TAB, collapsed, ROOT_LEVEL) })
    script.list.mockClear()

    act(() => { fireEvent.click(view.container.querySelector('[data-files-reload]')!) })
    expect(script.list.mock.calls.map(call => call[1])).toEqual([ROOT, child])
    expect(script.list).toHaveBeenCalledWith(SESSION, ROOT, controller.signal)
    const state = instance.getSnapshot().byTab[TAB]!
    expect(state.expanded).toEqual([ROOT, child])
    expect(state.levels).toEqual({ [ROOT]: { kind: 'loading' }, [child]: { kind: 'loading' } })
    expect(view.container.querySelector('[data-files-reload]')?.getAttribute('aria-label')).toBe(zh.reload)
  })

  it('an aborted record is forgotten and not seeded again while the body is still mounted', async () => {
    const { view, script, controller, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { controller.abort() })
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(view.container.querySelector('[data-files-state="tree"]')).toBeNull()
    expect(script.list).toHaveBeenCalledTimes(1)
  })
})

describe('FilesBody selection', () => {
  it('marks the row the reader is on and moves the mark to the next one', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(selectedPaths(view)).toEqual([])
    act(() => { fireEvent.click(row(view, `${ROOT}/README.md`)) })
    expect(selectedPaths(view)).toEqual([`${ROOT}/README.md`])
    act(() => { fireEvent.click(row(view, `${ROOT}/src`)) })
    expect(selectedPaths(view)).toEqual([`${ROOT}/src`])
  })

  it('keeps the selection while the tree is listed again', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(row(view, `${ROOT}/README.md`)) })
    act(() => { fireEvent.click(view.container.querySelector('[data-files-reload]')!) })
    expect(selectedPaths(view)).toEqual([])
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(selectedPaths(view)).toEqual([`${ROOT}/README.md`])
  })

  it('offers no selection on an entry it cannot open', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const other = view.container.querySelector(`[data-files-path="${ROOT}/pipe"]`)!
    expect(other.querySelector('button')).toBeNull()
    expect(selectedPaths(view)).toEqual([])
  })
})

describe('FilesBody new entries', () => {
  it('creates a file named in the inline input under the root, and closes the input when it lands', async () => {
    const { view, script, controller } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-file]')!) })
    const input = draftInput(view, 'file')
    expect(input.placeholder).toBe(zh['draft.nameFile'])
    // The input sits at the root's own level, not inside any entry.
    expect(view.container.querySelector('[data-files-draft]')?.closest('[data-files-entry]')).toBeNull()
    fireEvent.change(input, { target: { value: 'notes.txt' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(script.createFile).toHaveBeenCalledWith(SESSION, ROOT, 'notes.txt', controller.signal)
    // The input stays until the creation lands, so a refused name keeps its text.
    expect(draftInput(view, 'file').value).toBe('notes.txt')
    await act(() => script.settleEntry({ ok: true, value: CREATED }))
    expect(view.container.querySelector('[data-files-draft]')).toBeNull()
    // The directory is listed again, so the new row appears.
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, controller.signal)
  })

  it('creates a folder under the selected directory, opening it first when it was collapsed', async () => {
    const { view, script, controller } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(row(view, `${ROOT}/src`)) })
    await act(() => script.settle({ ok: true, value: EMPTY }))
    act(() => { fireEvent.click(row(view, `${ROOT}/src`)) })
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-folder]')!) })
    const input = draftInput(view, 'directory')
    expect(input.placeholder).toBe(zh['draft.nameFolder'])
    expect(view.container.querySelector('[data-files-draft]')?.closest('[data-files-entry]'))
      .toBe(view.container.querySelector(`[data-files-path="${ROOT}/src"]`))
    fireEvent.change(input, { target: { value: 'lib' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(script.createDirectory).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, 'lib', controller.signal)
    expect(script.createFile).not.toHaveBeenCalled()
  })

  it('cancels the input on Escape and on focus leaving, asking the Host for nothing', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-file]')!) })
    act(() => { fireEvent.keyDown(draftInput(view, 'file'), { key: 'Escape' }) })
    expect(view.container.querySelector('[data-files-draft]')).toBeNull()
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-folder]')!) })
    act(() => { fireEvent.blur(draftInput(view, 'directory')) })
    expect(view.container.querySelector('[data-files-draft]')).toBeNull()
    expect(script.createFile).not.toHaveBeenCalled()
    expect(script.createDirectory).not.toHaveBeenCalled()
  })

  it('keeps the input open when Enter names nothing', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-file]')!) })
    const input = draftInput(view, 'file')
    fireEvent.change(input, { target: { value: '   ' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(script.createFile).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-files-draft]')).not.toBeNull()
    // A key the input does not own leaves it alone too.
    act(() => { fireEvent.keyDown(draftInput(view, 'file'), { key: 'a' }) })
    expect(view.container.querySelector('[data-files-draft]')).not.toBeNull()
  })

  it('says why a name was refused and keeps what the reader typed', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(view.container.querySelector('[data-files-new-file]')!) })
    const input = draftInput(view, 'file')
    fireEvent.change(input, { target: { value: 'src' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await act(() => script.settleEntry({
      ok: false,
      error: new RemoteError('workspace-file/exists', 'already exists', { path: 'src' }),
    }))
    const notice = view.container.querySelector('[data-files-notice]')
    expect(notice?.getAttribute('data-files-code')).toBe('workspace-file/exists')
    expect(notice?.textContent).toBe(zh['gesture.exists'])
    expect(draftInput(view, 'file').value).toBe('src')
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
  })
})

describe('FilesBody paste', () => {
  it('offers paste only while a clipboard holds something', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const paste = view.container.querySelector<HTMLButtonElement>('[data-files-paste]')!
    expect(paste.disabled).toBe(true)
    act(() => { instance.actions.clipboarded(TAB, { mode: 'copy', path: `${ROOT}/README.md` }) })
    expect(paste.disabled).toBe(false)
    act(() => { instance.actions.clipboarded(TAB, null) })
    expect(paste.disabled).toBe(true)
  })

  it('pastes into the selected directory under the name the entry already has', async () => {
    const { view, script, instance, controller } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(row(view, `${ROOT}/src`)) })
    act(() => { instance.actions.clipboarded(TAB, { mode: 'copy', path: `${ROOT}/README.md` }) })
    act(() => { fireEvent.click(view.container.querySelector('[data-files-paste]')!) })
    expect(script.copy).toHaveBeenCalledWith(SESSION, `${ROOT}/README.md`, `${ROOT}/src/README.md`, controller.signal)
  })

  it('pastes into the root when the selection is a file', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(row(view, `${ROOT}/.env`)) })
    act(() => { instance.actions.clipboarded(TAB, { mode: 'copy', path: `${ROOT}/src/a.ts` }) })
    act(() => { fireEvent.click(view.container.querySelector('[data-files-paste]')!) })
    expect(script.copy).toHaveBeenCalledWith(SESSION, `${ROOT}/src/a.ts`, `${ROOT}/a.ts`, expect.any(AbortSignal))
  })

  it('moves a cut entry and releases the clipboard once it lands', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(row(view, `${ROOT}/src`)) })
    act(() => { instance.actions.clipboarded(TAB, { mode: 'cut', path: `${ROOT}/README.md` }) })
    act(() => { fireEvent.click(view.container.querySelector('[data-files-paste]')!) })
    expect(script.move).toHaveBeenCalledWith(SESSION, `${ROOT}/README.md`, `${ROOT}/src/README.md`, expect.any(AbortSignal))
    await act(() => script.settleEntry({ ok: true, value: CREATED }))
    expect(view.container.querySelector<HTMLButtonElement>('[data-files-paste]')!.disabled).toBe(true)
  })
})

describe('FilesBody context menu', () => {
  it('offers the operations one right-clicked row allows, and pastes only into a directory', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/README.md`)
    expect(menuLabels(view)).toEqual([zh['menu.open'], zh['menu.copy'], zh['menu.cut'], zh['menu.delete']])
    contextMenu(view, `${ROOT}/src`)
    expect(menuLabels(view)).toEqual([
      zh['menu.open'], zh['menu.copy'], zh['menu.cut'], zh['menu.paste'], zh['menu.delete'],
    ])
    // Paste stays visible but out of reach until something is on the clipboard.
    const paste = [...view.baseElement.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.textContent === zh['menu.paste'])!
    expect(paste.disabled).toBe(true)
    act(() => { instance.actions.clipboarded(TAB, { mode: 'copy', path: `${ROOT}/README.md` }) })
    expect([...view.baseElement.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.textContent === zh['menu.paste'])!.disabled).toBe(false)
  })

  it('opens the entry the menu was asked about, whichever kind it is', async () => {
    const { view, script, tabActions } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/README.md`)
    act(() => { pickMenuItem(view, zh['menu.open']) })
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, ROOT, `${ROOT}/README.md`))
    expect(view.baseElement.querySelector('[role="menu"]')).toBeNull()
    contextMenu(view, `${ROOT}/src`)
    act(() => { pickMenuItem(view, zh['menu.open']) })
    expect(script.list).toHaveBeenLastCalledWith(SESSION, `${ROOT}/src`, expect.any(AbortSignal))
  })

  it('picks an entry up with copy or cut, and pastes into the row the menu belongs to', async () => {
    const { view, script, instance } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/README.md`)
    act(() => { pickMenuItem(view, zh['menu.copy']) })
    expect(instance.getSnapshot().byTab[TAB]!.clipboard).toEqual({ mode: 'copy', path: `${ROOT}/README.md` })
    contextMenu(view, `${ROOT}/README.md`)
    act(() => { pickMenuItem(view, zh['menu.cut']) })
    expect(instance.getSnapshot().byTab[TAB]!.clipboard).toEqual({ mode: 'cut', path: `${ROOT}/README.md` })
    contextMenu(view, `${ROOT}/src`)
    act(() => { pickMenuItem(view, zh['menu.paste']) })
    expect(script.move).toHaveBeenCalledWith(SESSION, `${ROOT}/README.md`, `${ROOT}/src/README.md`, expect.any(AbortSignal))
  })

  it('waits for the reader to confirm a removal before it calls the Host', async () => {
    const { view, script, controller } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/src`)
    act(() => { pickMenuItem(view, zh['menu.delete']) })
    expect(script.remove).not.toHaveBeenCalled()
    expect(view.baseElement.querySelector('[role="dialog"]')?.textContent).toContain('src')
    act(() => { pickButton(view, zh['confirm.action']) })
    expect(script.remove).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, { recursive: true }, controller.signal)
    expect(view.baseElement.querySelector('[role="dialog"]')).toBeNull()
  })

  it('removes a file without asking the Host to recurse', async () => {
    const { view, script, controller } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/README.md`)
    act(() => { pickMenuItem(view, zh['menu.delete']) })
    act(() => { pickButton(view, zh['confirm.action']) })
    expect(script.remove).toHaveBeenCalledWith(SESSION, `${ROOT}/README.md`, { recursive: false }, controller.signal)
  })

  it('drops the confirmation without calling the Host when the reader cancels it', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/src`)
    act(() => { pickMenuItem(view, zh['menu.delete']) })
    act(() => { pickButton(view, zh['cancel']) })
    expect(script.remove).not.toHaveBeenCalled()
    expect(view.baseElement.querySelector('[role="dialog"]')).toBeNull()
  })

  it('says why a refused gesture did not land, and stops saying it once the reader moves on', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    contextMenu(view, `${ROOT}/src`)
    act(() => { pickMenuItem(view, zh['menu.delete']) })
    act(() => { pickButton(view, zh['confirm.action']) })
    await act(() => script.settleRemoval({
      ok: false,
      error: new RemoteError('workspace-file/not-empty', 'not empty', { path: 'src' }),
    }))
    const notice = view.container.querySelector('[data-files-notice]')
    expect(notice?.getAttribute('data-files-code')).toBe('workspace-file/not-empty')
    expect(notice?.textContent).toBe(zh['gesture.notEmpty'])
    act(() => { fireEvent.click(row(view, `${ROOT}/README.md`)) })
    expect(view.container.querySelector('[data-files-notice]')).toBeNull()
  })
})

describe('destinationOf', () => {
  /** A tree holding one listed root with a directory and a file in it. */
  function tree(overrides: Partial<FilesTabState> = {}): FilesTabState {
    return {
      root: ROOT,
      levels: { [ROOT]: { kind: 'ready', level: ROOT_LEVEL } },
      expanded: [ROOT],
      selected: null,
      clipboard: null,
      draft: null,
      notice: null,
      ...overrides,
    }
  }

  it('falls back to the root with nothing selected, with a file selected, and with an entry it cannot open', () => {
    expect(destinationOf(tree())).toBe(ROOT)
    expect(destinationOf(tree({ selected: `${ROOT}/README.md` }))).toBe(ROOT)
    expect(destinationOf(tree({ selected: `${ROOT}/pipe` }))).toBe(ROOT)
  })

  it('lands in the selected directory', () => {
    expect(destinationOf(tree({ selected: `${ROOT}/src` }))).toBe(`${ROOT}/src`)
  })

  it('falls back to the root for a selection whose own level is not listed', () => {
    expect(destinationOf(tree({ levels: {}, selected: `${ROOT}/src` }))).toBe(ROOT)
    expect(destinationOf(tree({
      levels: { [ROOT]: { kind: 'loading' } },
      selected: `${ROOT}/src`,
    }))).toBe(ROOT)
  })

  it('falls back to the root for a selection the listed level no longer holds', () => {
    const stale = tree({ selected: `${ROOT}/gone` })
    expect(destinationOf(stale)).toBe(ROOT)
  })
})

describe('gestureLine', () => {
  const t = makeTranslate(zh)

  it('names each refusal the tree knows how to act on', () => {
    expect(gestureLine(t, new RemoteError('workspace-file/exists', 'x', { path: 'p' }))).toBe(zh['gesture.exists'])
    expect(gestureLine(t, new RemoteError('workspace-file/not-empty', 'x', { path: 'p' }))).toBe(zh['gesture.notEmpty'])
    expect(gestureLine(t, new RemoteError('workspace-file/not-found', 'x', { path: 'p' }))).toBe(zh['gesture.gone'])
  })

  it('carries an unclassified failure\'s own message', () => {
    const failure = { code: 'remote/transport', message: 'socket closed' } as unknown as RemoteFailure
    expect(gestureLine(t, failure)).toBe('操作失败：socket closed')
  })
})

describe('orderEntries', () => {
  it('puts directories first and orders each group by name, numbers included', () => {
    const ordered = orderEntries([
      { name: 'file10.txt', type: 'file' },
      { name: 'zeta', type: 'directory' },
      { name: 'file2.txt', type: 'file' },
      { name: '.env', type: 'file' },
      { name: 'Alpha', type: 'directory' },
      { name: 'sock', type: 'other' },
    ])
    expect(ordered.map(entry => entry.name)).toEqual(['Alpha', 'zeta', '.env', 'file2.txt', 'file10.txt', 'sock'])
  })

  it('leaves the endpoint\'s array untouched', () => {
    const entries = [{ name: 'b', type: 'file' as const }, { name: 'a', type: 'file' as const }]
    orderEntries(entries)
    expect(entries.map(entry => entry.name)).toEqual(['b', 'a'])
  })
})

describe('failureLine', () => {
  const t = makeTranslate(zh)

  it('names each directory failure', () => {
    expect(failureLine(t, new RemoteError('workspace-file/not-found', 'x', { path: 'p' }))).toBe(zh['error.notFound'])
    expect(failureLine(t, new RemoteError('workspace-file/outside-workspace', 'x', { path: 'p' })))
      .toBe(zh['error.outsideWorkspace'])
    expect(failureLine(t, new RemoteError('workspace-file/not-directory', 'x', { path: 'p', kind: 'file' })))
      .toBe(zh['error.notDirectory'])
  })

  it('carries an unclassified failure\'s own message', () => {
    const failure = { code: 'remote/transport', message: 'socket closed' } as unknown as RemoteFailure
    expect(failureLine(t, failure)).toBe('读取失败：socket closed')
  })
})
