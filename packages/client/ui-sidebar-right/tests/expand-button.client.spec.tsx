// @vitest-environment jsdom
/**
 * The way back into a hidden panel: the header's corner button exists exactly
 * while the panel is collapsed, asks for it to expand, and renders nothing
 * while the panel is shown.
 */
import { describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { ExpandButton } from '../src/client/shell/ExpandButton.tsx'
import type { ExpandButtonProps } from '../src/client/shell/ExpandButton.tsx'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 's-test' as SessionId
const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SESSION, useSession: unused, useProjection: unused, useConversation: unused,
  useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  ...allowAllAccess,
  inputActions: { captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/** Mount the button over its real store and an empty shortcut catalog. */
function mountButton(shortcuts: readonly ShortcutCatalogEntry[] = [], inSeat = false) {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const props: ExpandButtonProps = {
    ...standard,
    useShortcuts: <T,>(selector: (entries: readonly ShortcutCatalogEntry[]) => T): T => selector(shortcuts),
    // The seat's own stage hook: a plain selector over a fixed answer.
    useWorkstation: <S,>(selector: (state: boolean) => S): S => selector(inSeat),
    sessionId: SESSION,
    useStore: hookOf(instance),
    actions: instance.actions,
    // Copy is the dictionary's contract; the key stands in for the translation.
    t: (key: string) => key,
  }
  const view = render(<ExpandButton {...props} />)
  const control = (): HTMLElement | null => view.container.querySelector('[data-sidebar-right-expand]')
  return { instance, view, control }
}

describe('ExpandButton', () => {
  it('advertises the configured expand binding', async () => {
    const { control, view } = mountButton([{ id: 'sidebar.right.toggle' as never, label: 'Toggle', aliases: [],
      binding: null, keys: ['Ctrl', 'B'], aria: 'Control+B', modified: true, conflicts: [], issue: null }])
    expect(control()?.getAttribute('aria-keyshortcuts')).toBe('Control+B')
    fireEvent.mouseEnter(control()!)
    const tooltip = await view.findByRole('tooltip')
    expect(tooltip.textContent).toContain('chrome.expand')
    expect(Array.from(tooltip.querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'B'])
    cleanup()
  })
  it('offers the way in while the session has no surface yet, and asks the panel to expand', () => {
    const { instance, view, control } = mountButton()
    const button = control()
    if (button === null) throw new Error('expected the expand control')
    expect(button.getAttribute('aria-label')).toBe('chrome.expandAria')
    fireEvent.click(button)
    expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(true)
    // Shown: the seat is empty, so the header lays out without it.
    expect(view.container.childElementCount).toBe(0)
    cleanup()
  })

  it('comes back when the panel collapses again', () => {
    const { instance, control } = mountButton()
    act(() => { instance.actions.setExpanded(SESSION, true) })
    expect(control()).toBeNull()
    act(() => { instance.actions.setExpanded(SESSION, false) })
    expect(control()).not.toBeNull()
    cleanup()
  })

  it('asks to leave the seat instead of opening a hidden column while the seat is laid out', () => {
    const asked: string[] = []
    const listen = (event: Event): void => { asked.push(event.type) }
    window.addEventListener('dsh-leave-seat', listen)
    const { instance, view, control } = mountButton([], true)
    const button = control()
    if (button === null) throw new Error('expected the corner control inside the seat')
    expect(button.getAttribute('aria-label')).toBe('chrome.leaveSeatAria')
    expect(button.hasAttribute('data-leave-seat')).toBe(true)
    fireEvent.click(button)
    window.removeEventListener('dsh-leave-seat', listen)
    expect(asked).toEqual(['dsh-leave-seat'])
    // The column's own store is untouched: this click was not about the panel.
    expect(instance.getSnapshot().bySession[SESSION]).toBeUndefined()
    expect(view.container.querySelector('[data-sidebar-right-expand]')).not.toBeNull()
    cleanup()
  })
})
