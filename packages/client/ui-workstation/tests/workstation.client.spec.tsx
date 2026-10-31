/**
 * The seat's own spec: a real store instance, a scripted Remote, and the tree
 * and viewer drawing exactly what the face settled into the store.
 *
 * The seat's contract is narrow on purpose — a level loads when the tree first
 * draws it, a file click fills the viewer, and no Session means no request at
 * all — so these three cases cover the promise without reaching for a fake of
 * the whole client runtime.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
    '': [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 11 },
    ],
    src: [{ name: 'index.ts', type: 'file', size: 4 }],
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

afterEach(cleanup)

describe('Workstation', () => {
  it('lists the root level and fills the viewer with a clicked file', async () => {
    const store = createWorkstationStore()
    const instance = store.create()
    const controller = new AbortController()
    const { remote, list } = scripted()
    const face = workstationFace({ remote, sessionId: () => SESSION, signal: controller.signal })(instance.actions)
    const props = {
      useStore: hookOf(instance),
      useSessionId: hookOf({ getSnapshot: () => SESSION, subscribe: () => () => {} }),
      t: makeTranslate(zh),
      ...face,
    } as unknown as WorkstationProps

    const { getByTitle, getByRole } = render(<Workstation {...props} />)

    await waitFor(() => { expect(getByTitle('README.md')).toBeTruthy() })
    expect(list).toHaveBeenCalledWith(SESSION, '', controller.signal)
    expect(getByRole('tree')).toBeTruthy()

    fireEvent.click(getByTitle('README.md'))

    await waitFor(() => { expect(instance.getSnapshot().viewer.lines).toEqual(['alpha', 'beta']) })
    expect(instance.getSnapshot().viewer.path).toBe('README.md')
    expect(instance.getSnapshot().viewer.eof).toBe(true)
  })

  it('asks for nothing while no Session is selected', () => {
    const store = createWorkstationStore()
    const instance = store.create()
    const controller = new AbortController()
    const { remote, list } = scripted()
    const face = workstationFace({ remote, sessionId: () => undefined, signal: controller.signal })(instance.actions)
    const props = {
      useStore: hookOf(instance),
      useSessionId: hookOf({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      t: makeTranslate(zh),
      ...face,
    } as unknown as WorkstationProps

    const { getByText } = render(<Workstation {...props} />)

    expect(getByText(zh['session.none'])).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
  })
})
