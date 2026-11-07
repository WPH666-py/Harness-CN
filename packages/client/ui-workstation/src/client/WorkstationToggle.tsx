/**
 * The Conversation-header control that names the frame's arrangement and swaps
 * it for another: the three-column desk, the IDE stage with the Conversation
 * pulled in as a drawer, or the IDE stage with it pushed out.
 *
 * It is a menu rather than a cycling button because there are three
 * destinations and a one-click cycle can only ever reach the next one: from the
 * full-screen stage a cycle cannot reach the desk without passing through the
 * drawer stage. The menu lists the other two, so any of the three is one click
 * away from any other — which is what "switch between them freely" means.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Presentation, UseWorkstation } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './WorkstationToggle.module.css'

/** The one gesture the header control performs. */
export interface WorkstationToggleInjected {
  /** Show one of the three arrangements. */
  readonly present: (presentation: Presentation) => void
}

/** The control's composed props: the header seat's share, the copy, and the gesture. */
export type WorkstationToggleProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'workstation'>
  & WorkstationToggleInjected

/** Presentation a frame without the seat reports: permanently hidden. */
const useHiddenWorkstation: UseWorkstation = selector => selector(false)

/** The three arrangements, in the order the menu lists them. */
const PRESENTATIONS: readonly Presentation[] = ['desk', 'ide-three', 'ide-full']

/** Copy key of each arrangement, named literally so the dictionary stays type-checked. */
function labelOf(presentation: Presentation): 'present.desk' | 'present.ideThree' | 'present.ideFull' {
  if (presentation === 'desk') return 'present.desk'
  return presentation === 'ide-three' ? 'present.ideThree' : 'present.ideFull'
}

/**
 * Draw the presentation menu.
 * @param props - the copy, the gesture, and the frame's presentation hooks.
 * @returns the header control.
 */
export function WorkstationToggle(props: WorkstationToggleProps): ReactNode {
  const { t, present, useWorkstation, useIde, useDrawer, useServerMode } = props
  const useMode = useWorkstation ?? useHiddenWorkstation
  const useStage = useIde ?? useHiddenWorkstation
  const useOpenDrawer = useDrawer ?? useHiddenWorkstation
  const useServer = useServerMode ?? useHiddenWorkstation
  const seat = useMode(state => state)
  const ide = useStage(state => state)
  const drawer = useOpenDrawer(state => state)
  const onServer = useServer(state => state)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // A menu left open over the arrangement it just changed hides the change.
  useEffect(() => {
    if (!open) return () => {}
    const close = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  // The IDE arrangements describe this machine's desktop: on a server the frame is the server's
  // own page, and naming an arrangement there would promise something that page cannot show.
  if (onServer) return null

  const current: Presentation = ide ? (drawer ? 'ide-three' : 'ide-full') : seat ? 'ide-three' : 'desk'
  return (
    <div className={css.root} ref={root} data-presentation-menu-root>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('present.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('present.menu')}
        data-workstation-toggle
        data-stage={current}
        data-active={(current !== 'desk') || undefined}
        onClick={() => { setOpen(value => !value) }}
      >
        {t(labelOf(current))}
        <span className={css.caret} aria-hidden="true">▾</span>
      </button>
      {open
        ? (
          <div className={css.menu} role="menu" data-presentation-menu>
            {PRESENTATIONS.filter(item => item !== current).map(item => (
              <button
                key={item}
                type="button"
                role="menuitem"
                className={css.item}
                data-presentation={item}
                onClick={() => {
                  present(item)
                  setOpen(false)
                }}
              >
                {t(labelOf(item))}
              </button>
            ))}
          </div>
        )
        : null}
    </div>
  )
}
