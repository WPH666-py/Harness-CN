/**
 * The workstation seat: the tree beside the tabbed editor, filling the frame's
 * first column while the frame presents the IDE layout.
 *
 * The Session on screen travels in as a hook source, and its absence is a state
 * of its own — no Session, no workspace to list — rather than an error. A current
 * remote host replaces both halves of that sentence: the tree lists that machine
 * from its own root, and the seat stays usable with no Session at all, because
 * the files it shows do not belong to any Session's workspace.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import { TreeSplitter } from './TreeSplitter.tsx'
import type { WorkstationInject } from './face.ts'
import { REMOTE_ROOT } from './remote.ts'
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
    t: translate, useStore, useSessions, useSessionId, useRemoteHosts, useIde, useDrawer, toggleAi,
    leaveServer,
    actions, openDirectory, toggleDirectory, openFile, focusTab, editTab, saveTab, closeTab, searchFiles,
  } = props
  const sessionId = useSessionId(state => state)
  // The listing endpoint takes a directory path and has no spelling for "the
  // workspace root", so the tree starts from the Session's own working
  // directory: the Session summary carries it, and it is the same directory the
  // Session's tools write into.
  const sessionRoot = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const hosts = useRemoteHosts(state => state)
  const remoteHostId = hosts.currentHostId
  const remoteHostName = remoteHostId === null
    ? null
    : hosts.hosts.find(host => host.hostId === remoteHostId)?.displayName ?? null
  const remote = useStore(state => state.remoteHostId !== null)
  const remoteRoot = useStore(state => state.remoteRoot)
  const treeWidth = useStore(state => state.treeWidth)
  // A host without the stage reports a constant false, which is also what the
  // conversation layout means here: no stage control, no floating way back.
  const fullscreen = useIde === undefined ? false : useIde(state => state)
  // The drawer handle only exists in the full-screen stage, and a host without
  // the stage reports a constant false — which is exactly "no handle".
  const drawerOpen = useDrawer === undefined ? false : useDrawer(state => state)

  // The poller owns "which host is current"; the store owns the tree that host
  // draws. Handing the answer over here keeps the store's write set the only
  // way a level or a tab appears.
  useEffect(() => {
    actions.remoteHost(remoteHostId, remoteHostName, REMOTE_ROOT)
  }, [actions, remoteHostId, remoteHostName])

  const root = remote ? remoteRoot : sessionRoot
  // The header carries the way off a server page, but the header belongs to an open session: with
  // no session — a fresh chat, a plugin page — and in the full-screen stage whose drawer is closed,
  // nothing on screen would say how to get back. Those are the two cases the seat covers itself; the
  // rest of the time the header's single control is the only one, which is what the desktop wants.
  const seatExit = remote && (sessionId === undefined || (fullscreen && !drawerOpen))
  if (sessionId === undefined && !remote) {
    return <div className={css.status} data-workstation-state="no-session">{translate('session.none')}</div>
  }
  return (
    <div className={css.root} data-workstation-root data-fullscreen={fullscreen || undefined} data-ai-open={drawerOpen || undefined}>
      <FileTree
        useStore={useStore}
        translate={translate}
        actions={actions}
        openDirectory={openDirectory}
        toggleDirectory={toggleDirectory}
        openFile={openFile}
        focusTab={focusTab}
        searchFiles={searchFiles}
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
      {fullscreen
        ? (
          <button
            type="button"
            className={css.aiHandle}
            data-ai-handle
            data-open={drawerOpen || undefined}
            title={drawerOpen ? translate('ai.hide') : translate('ai.show')}
            aria-label={drawerOpen ? translate('ai.hide') : translate('ai.show')}
            aria-expanded={drawerOpen}
            onClick={() => { toggleAi() }}
          >
            {translate('ai.handle')}
          </button>
        )
        : null}
      {seatExit
        ? (
          <button
            type="button"
            className={css.leaveStage}
            data-server-leave
            title={translate('server.leave')}
            aria-label={translate('server.leave')}
            onClick={() => { leaveServer() }}
          >
            {translate('server.leave')}
          </button>
        )
        : null}
    </div>
  )
}
