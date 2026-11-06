/**
 * The Conversation-header control that switches the seat between its two
 * presentations: the workstation (tree, editor and the Conversation side by
 * side) and the full-screen IDE stage (the tree and the editor alone).
 *
 * The three-column desk is not one of the stages this button reaches: leaving
 * the seat entirely is the header corner's own gesture, so that the button's
 * label never has to describe a third destination. One click swaps the stage
 * and the label names the one the click leads to.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseWorkstation } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './WorkstationToggle.module.css'

/** The one gesture the header control performs. */
export interface WorkstationToggleInjected {
  /** Swap the seat between the workbench and the full-screen stage. */
  readonly cyclePresentation: () => void
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
 * @param props - the copy, the gesture, and the frame's presentation hooks.
 * @returns the header button.
 */
export function WorkstationToggle(props: WorkstationToggleProps): ReactNode {
  const { t, cyclePresentation, useWorkstation, useIde, useServerMode } = props
  const useMode = useWorkstation ?? useHiddenWorkstation
  const useStage = useIde ?? useHiddenWorkstation
  const useServer = useServerMode ?? useHiddenWorkstation
  const active = useMode(state => state)
  const fullscreen = useStage(state => state)
  const onServer = useServer(state => state)
  // The two stages describe this machine's desktop: on a server the frame is the
  // server's IDE page, and nothing here would mean anything there.
  if (onServer) return null
  // The label names the stage the click reaches, so the button never asks the
  // reader to infer what comes next from a mode they cannot see yet.
  const label = fullscreen ? t('toggle.workbench') : active ? t('toggle.fullscreen') : t('toggle.mode')
  const action = fullscreen ? t('toggle.workbenchAction') : active ? t('toggle.stage') : t('toggle.enable')
  return (
    <button
      type="button"
      className={css.trigger}
      aria-label={action}
      title={action}
      aria-pressed={active}
      data-workstation-toggle
      data-active={active || undefined}
      data-stage={fullscreen ? 'ide' : active ? 'workstation' : 'conversation'}
      onClick={() => { cyclePresentation() }}
    >
      {label}
    </button>
  )
}
