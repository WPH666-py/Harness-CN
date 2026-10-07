/**
 * The tree's asynchronous half against a scripted listing, and the Remote
 * adapter under it.
 *
 * The face's contract is what reaches the store and when: a level is `loading`
 * before the listing settles, `ready` or `failed` after, never written once the
 * owner's signal aborted or a newer listing of the level was asked for, and a
 * tab whose record is gone leaves no bucket behind. The mutations add the other
 * half: each gesture reaches its own Remote verb with the path it names, and
 * what a settled mutation writes — the notice, the clipboard, the level it
 * refreshes — is what the tree draws next. The adapter's contract is what it
 * keeps and what it drops: entries and the truncation flag reach the store, the
 * endpoint's workspace-relative path does not, and a failure passes through
 * untouched.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceDirectoryListing, WorkspaceFileMutation, WorkspaceFileRemoval,
} from '@deepseek-ai/dsh-api-workspace-files/types'
import { baseName, childPath, filesFace, parentPath } from '../src/client/face.ts'
import type { WorkspaceFilesMutationRemote } from '../src/client/face.ts'
import { createFilesStore } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import { scriptedFiles } from './scripted-list.client.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const SESSION = 's-1' as SessionId
const ROOT = '/work/app'
const TAB = 'tab-1' as TabId

const LEVEL: DirLevel = { entries: [{ name: 'src', type: 'directory' }], truncated: false }

const CREATED: WorkspaceFileMutation = { absolutePath: `${ROOT}/new.txt`, version: 'v1', path: 'new.txt' }
const REMOVED: WorkspaceFileRemoval = { sessionId: SESSION, path: 'src' }

function mount() {
  const instance = createFilesStore().create()
  const script = scriptedFiles()
  const face = filesFace(script.bound)(SESSION, instance.actions)
  return { ...script, face, instance, snapshot: () => instance.getSnapshot().byTab[TAB] }
}

/** A tree whose root has been listed, with `signal` live. */
async function mounted() {
  const hands = mount()
  const controller = new AbortController()
  hands.face.start(TAB, ROOT, controller.signal)
  await hands.settle({ ok: true, value: LEVEL })
  return { ...hands, controller, signal: controller.signal }
}

describe('filesFace', () => {
  it('start seeds the tab and lists the root with the session and the absolute root path', async () => {
    const { face, list, settle, snapshot } = mount()
    const controller = new AbortController()
    face.start(TAB, ROOT, controller.signal)
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, controller.signal)
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'loading' })
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('records a failed listing under its level', async () => {
    const { face, settle, snapshot } = mount()
    face.start(TAB, ROOT, new AbortController().signal)
    const error = new RemoteError('workspace-file/not-directory', 'not a directory', { path: ROOT, kind: 'file' })
    await settle({ ok: false, error })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'failed', failure: error })
  })

  it('toggle expands and lists a directory the first time, and only toggles afterwards', async () => {
    const { face, list, settle, snapshot } = mount()
    const signal = new AbortController().signal
    const child = `${ROOT}/src`
    face.start(TAB, ROOT, signal)
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, child, false, signal)
    expect(list).toHaveBeenLastCalledWith(SESSION, child, signal)
    expect(snapshot()!.expanded).toEqual([ROOT, child])
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, child, true, signal)
    expect(snapshot()!.expanded).toEqual([ROOT])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('abort forgets the bucket and a late settlement writes nothing', async () => {
    const { face, settle, snapshot } = mount()
    const controller = new AbortController()
    face.start(TAB, ROOT, controller.signal)
    controller.abort()
    expect(snapshot()).toBeUndefined()
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()).toBeUndefined()
  })

  it('makes no request for a record that already ended', () => {
    const { face, list } = mount()
    const controller = new AbortController()
    controller.abort()
    face.load(TAB, ROOT, controller.signal)
    expect(list).not.toHaveBeenCalled()
  })

  it('lets the latest listing of a level win, whichever settles first', async () => {
    const { face, list, settle, settleLatest, snapshot, outstanding } = mount()
    const signal = new AbortController().signal
    const older: DirLevel = { entries: [{ name: 'old.txt', type: 'file' }], truncated: false }
    face.start(TAB, ROOT, signal)
    // The reload gesture asks for the root again while the first listing is still out.
    face.load(TAB, ROOT, signal)
    expect(list).toHaveBeenCalledTimes(2)
    expect(outstanding()).toEqual([ROOT, ROOT])
    await settleLatest({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    // The retired listing lands afterwards and changes nothing.
    await settle({ ok: true, value: older })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    // A retired failure is dropped the same way.
    face.load(TAB, ROOT, signal)
    face.load(TAB, ROOT, signal)
    await settleLatest({ ok: true, value: LEVEL })
    await settle({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }) })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })
})

describe('filesFace mutations', () => {
  it('creates a file under the named directory and closes the name input the creation came from', async () => {
    const { face, instance, createFile, createDirectory, list, settleEntry, snapshot, signal } = await mounted()
    instance.actions.drafted(TAB, { parent: ROOT, kind: 'file' })
    face.createEntry(TAB, ROOT, 'new.txt', 'file', signal)
    expect(createFile).toHaveBeenCalledWith(SESSION, ROOT, 'new.txt', signal)
    expect(createDirectory).not.toHaveBeenCalled()
    // The input stays open until the creation lands, so a name the endpoint
    // refuses keeps what the reader typed.
    expect(snapshot()!.draft).toEqual({ parent: ROOT, kind: 'file' })
    list.mockClear()
    await settleEntry({ ok: true, value: CREATED })
    expect(snapshot()!.draft).toBeNull()
    // The directory is listed again, so the new row appears.
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, signal)
    expect(snapshot()!.notice).toBeNull()
  })

  it('creates a directory through its own verb and keeps the name input open when the name is taken', async () => {
    const { face, instance, createDirectory, list, settleEntry, snapshot, signal } = await mounted()
    const draft = { parent: ROOT, kind: 'directory' } as const
    instance.actions.drafted(TAB, draft)
    face.createEntry(TAB, ROOT, 'src', 'directory', signal)
    expect(createDirectory).toHaveBeenCalledWith(SESSION, ROOT, 'src', signal)
    list.mockClear()
    const error = new RemoteError('workspace-file/exists', 'already exists', { path: 'src' })
    await settleEntry({ ok: false, error })
    expect(snapshot()!.notice).toEqual(error)
    expect(snapshot()!.draft).toEqual(draft)
    // Nothing was created, so nothing is listed again either.
    expect(list).not.toHaveBeenCalled()
  })

  it('removes an entry recursively through remove and lists the directory it left', async () => {
    const { face, remove, list, settleRemoval, snapshot, signal } = await mounted()
    const path = `${ROOT}/src`
    face.removeEntry(TAB, path, true, signal)
    expect(remove).toHaveBeenCalledWith(SESSION, path, { recursive: true }, signal)
    list.mockClear()
    await settleRemoval({ ok: true, value: REMOVED })
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, signal)
    expect(snapshot()!.notice).toBeNull()
  })

  it('forgets a removed subtree instead of listing it again', async () => {
    const { face, instance, settleRemoval, signal } = await mounted()
    const path = `${ROOT}/src`
    instance.actions.toggled(TAB, path)
    instance.actions.loaded(TAB, path, LEVEL)
    instance.actions.selected(TAB, `${path}/deep.txt`)
    face.removeEntry(TAB, path, true, signal)
    await settleRemoval({ ok: true, value: REMOVED })
    const state = instance.getSnapshot().byTab[TAB]!
    expect(state.expanded).toEqual([ROOT])
    expect(state.levels[path]).toBeUndefined()
    expect(state.selected).toBeNull()
  })

  it('keeps the tree as it was when a removal is refused, and says why', async () => {
    const { face, list, settleRemoval, snapshot, signal } = await mounted()
    const path = `${ROOT}/src`
    list.mockClear()
    face.removeEntry(TAB, path, false, signal)
    const error = new RemoteError('workspace-file/not-empty', 'not empty', { path: 'src' })
    await settleRemoval({ ok: false, error })
    expect(snapshot()!.notice).toEqual(error)
    expect(list).not.toHaveBeenCalled()
  })

  it('copies a cut path under its own name and keeps the clipboard for another paste', async () => {
    const { face, instance, copy, move, list, settleEntry, snapshot, signal } = await mounted()
    const from = `${ROOT}/src`
    const destination = `${ROOT}/docs`
    instance.actions.clipboarded(TAB, { mode: 'copy', path: from })
    list.mockClear()
    face.pasteEntry(TAB, { mode: 'copy', path: from }, destination, signal)
    expect(copy).toHaveBeenCalledWith(SESSION, from, `${destination}/src`, signal)
    expect(move).not.toHaveBeenCalled()
    await settleEntry({ ok: true, value: CREATED })
    // A copy leaves the entry where it is, so it stays on the clipboard for
    // another paste.
    expect(snapshot()!.clipboard).toEqual({ mode: 'copy', path: from })
    expect(list).toHaveBeenCalledWith(SESSION, destination, signal)
    // The source is still there, so its own directory is not listed again.
    expect(list).not.toHaveBeenCalledWith(SESSION, ROOT, signal)
  })

  it('moves a cut path, releases the clipboard, and refreshes both directories it touched', async () => {
    const { face, move, list, settleEntry, snapshot, signal } = await mounted()
    const from = `${ROOT}/src`
    const destination = `${ROOT}/docs`
    list.mockClear()
    face.pasteEntry(TAB, { mode: 'cut', path: from }, destination, signal)
    expect(move).toHaveBeenCalledWith(SESSION, from, `${destination}/src`, signal)
    await settleEntry({ ok: true, value: CREATED })
    expect(snapshot()!.clipboard).toBeNull()
    // The directory it left loses a row, and the one it landed in gains one.
    expect(list.mock.calls.map(call => call[1])).toEqual([ROOT, destination])
  })

  it('refreshes one directory when a cut lands in the directory it came from', async () => {
    const { face, list, settleEntry, signal } = await mounted()
    const from = `${ROOT}/src`
    face.pasteEntry(TAB, { mode: 'cut', path: from }, ROOT, signal)
    list.mockClear()
    await settleEntry({ ok: true, value: CREATED })
    expect(list.mock.calls.map(call => call[1])).toEqual([ROOT])
  })

  it('keeps the clipboard when a paste is refused', async () => {
    const { face, instance, settleEntry, snapshot, signal } = await mounted()
    const clipboard = { mode: 'cut', path: `${ROOT}/src` } as const
    instance.actions.clipboarded(TAB, clipboard)
    face.pasteEntry(TAB, clipboard, ROOT, signal)
    const error = new RemoteError('workspace-file/exists', 'already exists', { path: 'src' })
    await settleEntry({ ok: false, error })
    expect(snapshot()!.notice).toEqual(error)
    expect(snapshot()!.clipboard).toEqual(clipboard)
  })

  it('makes no mutating request for a record that already ended', async () => {
    const { face, createFile, remove, copy, move, controller } = await mounted()
    controller.abort()
    face.createEntry(TAB, ROOT, 'a.txt', 'file', controller.signal)
    face.removeEntry(TAB, `${ROOT}/a.txt`, false, controller.signal)
    face.pasteEntry(TAB, { mode: 'copy', path: `${ROOT}/a.txt` }, ROOT, controller.signal)
    expect(createFile).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })

  it('writes nothing when a mutation settles after the record ended', async () => {
    const { face, instance, settleEntry, controller } = await mounted()
    const path = `${ROOT}/new.txt`
    face.createEntry(TAB, ROOT, 'new.txt', 'file', controller.signal)
    controller.abort()
    await settleEntry({ ok: true, value: { absolutePath: path, version: 'v1', path: 'new.txt' } })
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('clears the last notice when the next gesture lands', async () => {
    const { face, instance, settleEntry, snapshot, signal } = await mounted()
    instance.actions.noticed(TAB, new RemoteError('workspace-file/exists', 'taken', { path: 'src' }))
    face.createEntry(TAB, ROOT, 'src', 'directory', signal)
    await settleEntry({ ok: true, value: CREATED })
    expect(snapshot()!.notice).toBeNull()
  })
})

describe('createList', () => {
  it('passes the session, the absolute path, and the signal through, and keeps entries and truncation', async () => {
    const script = scriptedFiles()
    const listing: WorkspaceDirectoryListing = {
      path: 'src',
      entries: [{ name: 'a.ts', type: 'file', size: 3 }],
      truncated: true,
    }
    script.list.mockResolvedValue({ ok: true, value: listing })
    const signal = new AbortController().signal
    const result = await script.bound.list(SESSION, `${ROOT}/src`, signal)
    expect(script.list).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, signal)
    expect(result).toEqual({ ok: true, value: { entries: listing.entries, truncated: true } })
  })

  it('returns a failure as the endpoint reported it', async () => {
    const script = scriptedFiles()
    const error = new RemoteError('workspace-file/not-directory', 'file', { path: 'x', kind: 'file' })
    script.list.mockResolvedValue({ ok: false, error })
    const result = await script.bound.list(SESSION, `${ROOT}/x`, new AbortController().signal)
    expect(result).toEqual({ ok: false, error })
  })

  it('forwards each mutating verb to the live namespace method, with its own arguments', async () => {
    const script = scriptedFiles()
    const { bound, remote } = script
    const signal = new AbortController().signal
    void bound.createDirectory(SESSION, ROOT, 'd', signal)
    void bound.createFile(SESSION, ROOT, 'f', signal)
    void bound.remove(SESSION, `${ROOT}/d`, { recursive: true }, signal)
    void bound.copy(SESSION, `${ROOT}/d`, `${ROOT}/e`, signal)
    void bound.move(SESSION, `${ROOT}/e`, `${ROOT}/f`, signal)
    expect(script.createDirectory).toHaveBeenCalledWith(SESSION, ROOT, 'd', signal)
    expect(script.createFile).toHaveBeenCalledWith(SESSION, ROOT, 'f', signal)
    expect(script.remove).toHaveBeenCalledWith(SESSION, `${ROOT}/d`, { recursive: true }, signal)
    expect(script.copy).toHaveBeenCalledWith(SESSION, `${ROOT}/d`, `${ROOT}/e`, signal)
    expect(script.move).toHaveBeenCalledWith(SESSION, `${ROOT}/e`, `${ROOT}/f`, signal)
    // Reads the namespace at call time, so a remounted method is the one called.
    const remounted = vi.fn<WorkspaceFilesMutationRemote['workspaceFiles']['copy']>()
      .mockResolvedValue({ ok: true, value: CREATED })
    remote.workspaceFiles.copy = remounted
    void bound.copy(SESSION, `${ROOT}/d`, `${ROOT}/g`, signal)
    expect(remounted).toHaveBeenCalledTimes(1)
    expect(script.copy).toHaveBeenCalledTimes(1)
  })
})

describe('childPath', () => {
  it('joins with one slash whatever the parent ends in', () => {
    expect(childPath('/work/app', 'src')).toBe('/work/app/src')
    expect(childPath('/work/app/', 'src')).toBe('/work/app/src')
    expect(childPath('/', 'etc')).toBe('/etc')
    expect(childPath('C:\\work\\', 'src')).toBe('C:\\work/src')
  })
})

describe('parentPath', () => {
  it('names the directory one entry sits in', () => {
    expect(parentPath('/work/app/src')).toBe('/work/app')
    expect(parentPath('/work/app/src/a.ts')).toBe('/work/app/src')
    expect(parentPath('C:\\work/app/src')).toBe('C:\\work/app')
  })

  it('names the filesystem root for an entry directly under it', () => {
    expect(parentPath('/etc')).toBe('/')
  })
})

describe('baseName', () => {
  it('keeps the last segment, whatever separators the path mixes', () => {
    expect(baseName('/work/app/src')).toBe('src')
    expect(baseName('/work/app/src/a.ts')).toBe('a.ts')
    expect(baseName('C:\\work/app/src')).toBe('src')
  })
})
