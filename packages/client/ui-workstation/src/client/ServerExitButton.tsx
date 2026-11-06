/**
 * The one control the header keeps while the seat shows a server: the way back
 * to this machine.
 *
 * On a server the frame is the server's own IDE page, so every local-desktop
 * control beside it is noise. This button replaces them: it asks the server
 * manager to drop the current host, which returns the seat — and the frame — to
 * this machine's workspace on the next poll.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseWorkstation } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './ServerExitButton.module.css'

/** The one gesture the exit control performs. */
export interface ServerExitInjected {
  /** Drop the current host and return the frame to this machine. */
  readonly leaveServer: () => void
}

/** The control's composed props: the header seat's share, the copy, and the gesture. */
export type ServerExitButtonProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'workstation'>
  & ServerExitInjected

/** Presentation a frame without the seat reports: no server, no button. */
const useNoServer: UseWorkstation = selector => selector(false)

/**
 * Draw the exit control.
 * @param props - the copy, the gesture, and the frame's presentation hooks.
 * @returns the header button, or nothing while the seat is on this machine.
 */
export function ServerExitButton(props: ServerExitButtonProps): ReactNode {
  const { t, leaveServer, useServerMode } = props
  const useServer = useServerMode ?? useNoServer
  const onServer = useServer(state => state)
  if (!onServer) return null
  return (
    <button
      type="button"
      className={css.trigger}
      title={t('server.leave')}
      aria-label={t('server.leave')}
      data-server-exit
      onClick={() => { leaveServer() }}
    >
      {t('server.leave')}
    </button>
  )
}
