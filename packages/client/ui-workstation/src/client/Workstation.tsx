/**
 * The workstation seat: the tree beside the tabbed editor, filling the frame's
 * first column while the frame presents the IDE layout.
 *
 * The Session on screen travels in as a hook source, and its absence is a state
 * of its own — no Session, no workspace to list — rather than an error.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import { TreeSplitter } from './TreeSplitter.tsx'
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
  const {
    t: translate, useStore, useSessions, useSessionId, actions,
    openDirectory, toggleDirectory, openFile, focusTab, editTab, saveTab, closeTab,
  } = props
  const sessionId = useSessionId(state => state)
  // The listing endpoint takes a directory path and has no spelling for "the
  // workspace root", so the tree starts from the Session's own working
  // directory: the Session summary carries it, and it is the same directory the
  // Session's tools write into.
  const root = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const treeWidth = useStore(state => state.treeWidth)
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
        focusTab={focusTab}
        root={root}
        width={treeWidth}
      />
      <TreeSplitter width={treeWidth} onResize={(px: number) => { actions.setTreeWidth(px) }} />
      <FileViewer
        useStore={useStore}
        translate={translate}
        focusTab={focusTab}
        editTab={editTab}
        saveTab={saveTab}
        closeTab={closeTab}
      />
    </div>
  )
}
