/**
 * The Conversation-header control that swaps the frame into the workstation
 * layout and back.
 *
 * One click toggles: the Button carries the pressed state, and the title says
 * what the click will do rather than what the mode is.
 */
import type { ReactNode } from 'react'
import { IconCodeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseWorkstation } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './WorkstationToggle.module.css'

/** The one gesture the header control performs. */
export interface WorkstationToggleInjected {
  /** Swap the frame into the workstation layout, or back out of it. */
  readonly toggleWorkstation: () => void
}

/** The control's composed props: the header seat's share, the copy, and the gesture. */
export type WorkstationToggleProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'workstation'>
  & WorkstationToggleInjected

/** Presentation a frame without the seat reports: permanently hidden. */
const useHiddenWorkstation: UseWorkstation = selector => selector(false)

/**
 * Draw the toggle.
 * @param props - the copy, the gesture, and the frame's workstation hook.
 * @returns the header button.
 */
export function WorkstationToggle(props: WorkstationToggleProps): ReactNode {
  const { t, toggleWorkstation, useWorkstation } = props
  const useMode = useWorkstation ?? useHiddenWorkstation
  const active = useMode(state => state)
  const label = t('toggle.label')
  return (
    <button
      type="button"
      className={css.trigger}
      aria-label={label}
      aria-pressed={active}
      title={active ? t('toggle.disable') : t('toggle.enable')}
      data-workstation-toggle
      data-active={active || undefined}
      onClick={() => { toggleWorkstation() }}
    >
      <IconCodeOutlineMedium />
    </button>
  )
}
