/**
 * The workstation seat: the tree beside the viewer, filling the frame's first
 * column while the frame presents the IDE layout.
 *
 * The Session on screen travels in as a hook source, and its absence is a state
 * of its own — no Session, no workspace to list — rather than an error.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import type { WorkstationInject } from './face.ts'
import { createWorkstationStore } from './store.ts'
import css from './Workstation.module.css'

/** The seat's composed props: the frame's runtime share, the store, the face, and the copy. */
export type WorkstationProps =
  & PropsRuntime<'shell.workstation'>
  & PropsStore<ReturnType<typeof createWorkstationStore>>
  & SlotInjectFace<WorkstationInject>
  & PropsLocale<'workstation'>

/**
 * Draw the tree and the viewer side by side.
 * @param props - the store, the injected face, and the copy.
 * @returns the seat's content.
 */
export function Workstation(props: WorkstationProps): ReactNode {
  const { t: translate, useStore, useSessionId, openDirectory, toggleDirectory, openFile, loadMore } = props
  const sessionId = useSessionId(state => state)
  if (sessionId === undefined) {
    return <div className={css.status} data-workstation-state="no-session">{translate('session.none')}</div>
  }
  return (
    <div className={css.root} data-workstation-root>
      <FileTree
        useStore={useStore}
        translate={translate}
        openDirectory={openDirectory}
        toggleDirectory={toggleDirectory}
        openFile={openFile}
      />
      <FileViewer useStore={useStore} translate={translate} loadMore={loadMore} />
    </div>
  )
}
