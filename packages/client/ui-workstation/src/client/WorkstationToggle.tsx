/**
 * The Conversation-header control that walks the frame through its three
 * presentations: the conversation layout, the workstation layout (tree, editor
 * and the Conversation side by side), and the full-screen IDE stage (the tree
 * and the editor alone).
 *
 * One click advances one stage and the button says where the click goes: the
 * label names the stage it leads to, and the pressed state reports whether the
 * frame has left the conversation at all.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseWorkstation } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './WorkstationToggle.module.css'

/** The one gesture the header control performs. */
export interface WorkstationToggleInjected {
  /** Advance the frame one presentation stage. */
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
  const { t, cyclePresentation, useWorkstation, useIde } = props
  const useMode = useWorkstation ?? useHiddenWorkstation
  const useStage = useIde ?? useHiddenWorkstation
  const active = useMode(state => state)
  const fullscreen = useStage(state => state)
  // The label names the stage the click reaches, so the button never asks the
  // reader to infer what comes next from a mode they cannot see yet.
  const label = fullscreen ? t('toggle.exit') : active ? t('toggle.fullscreen') : t('toggle.mode')
  const action = fullscreen ? t('toggle.disable') : active ? t('toggle.stage') : t('toggle.enable')
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
