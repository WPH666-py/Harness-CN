/**
 * The way back out of a hidden panel, and out of the seat layout.
 *
 * One button in the conversation header's corner seat. While the panel is
 * collapsed it opens the panel; while the frame is showing the workstation or
 * the IDE it asks to leave that layout for the three-column desk instead,
 * because the seat carries the tree and the editor already and a panel toggle
 * there would open a column the reader cannot see.
 *
 * The leave gesture travels as a window event rather than an injected callback:
 * the seat belongs to another plugin's package, which this one may not import,
 * and the layout listens for the event at its own root.
 *
 * It lives in the conversation's own header rather than in the frame's right
 * column so that a collapsed Sidebar costs the conversation nothing — no rail,
 * no width, and the transcript's scrollbar stays at the column's edge. The
 * corner seat is its own, past the utilities' edge, so the button never joins
 * the utilities row; while the panel is shown this renders nothing, and the
 * seat collapses with it. It shares the panel's per-session store, which the
 * slot runtime allows because both seats are session-scoped.
 *
 * The glyph is the left sidebar's collapse icon mirrored: the same affordance,
 * on the other edge.
 */
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { Button, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createSidebarRightStore } from '../stores.ts'
import css from './ExpandButton.module.css'

/** The event the layout root listens for to put the desk back. */
export const LEAVE_SEAT_EVENT = 'dsh-leave-seat'

/** The button's props: the header corner seat, the shared store, and copy. */
export type ExpandButtonProps =
  & PropsRuntime<'conversation.session.header.corner'>
  & PropsStore<ReturnType<typeof createSidebarRightStore>>
  & PropsLocale<'sidebarRight'>
  & InjectFace<{ hooks: { shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> } }>

/** The expand control while the panel is collapsed; nothing while it is shown. */
export function ExpandButton({ sessionId, useStore, actions, t, useShortcuts, useServerMode, useWorkstation }: ExpandButtonProps): ReactNode {
  // A session with no surface yet is collapsed: the panel seat materializes the
  // surface on its own mount, and until then there is nothing expanded.
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'sidebar.right.toggle'))
  const expanded = useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)
  // The right column belongs to this machine's workspace. On a server page the
  // header keeps only the way back, so this control steps aside.
  const useServer = useServerMode ?? (selector => selector(false))
  const onServer = useServer(state => state)
  // Inside the seat the corner keeps its place but changes its job: a reader who
  // wants their navigation back asks for the three-column desk, which is the one
  // layout the stage button does not offer.
  const useSeat = useWorkstation ?? (selector => selector(false))
  const inSeat = useSeat(state => state)
  if (expanded || onServer) return null
  if (inSeat) {
    return (
      <Tooltip label={t('chrome.leaveSeat')} side="bottom" delayMs={500}>
        <Button
          size="sm"
          className={css.button}
          aria-label={t('chrome.leaveSeatAria')}
          data-sidebar-right-expand
          data-leave-seat
          onClick={() => { window.dispatchEvent(new CustomEvent(LEAVE_SEAT_EVENT)) }}
        >
          <IconPanelLeftOutlineRegular className={css.icon} />
        </Button>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={t('chrome.expand')} shortcutKeys={shortcut?.keys} side="bottom" delayMs={500}>
      <Button
        size="sm"
        className={css.button}
        aria-label={t('chrome.expandAria')}
        aria-keyshortcuts={shortcut?.aria}
        data-sidebar-right-expand
        onClick={() => { actions.setExpanded(sessionId, true) }}
      >
        <IconPanelLeftOutlineRegular className={css.icon} />
      </Button>
    </Tooltip>
  )
}
