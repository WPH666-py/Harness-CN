/**
 * Browser half: the workstation seat in the frame's first column, and the
 * Conversation-header toggle that swaps the frame into it.
 *
 * The split is this package's layering: what the seat keeps (`store.ts`), how it
 * fetches (`face.ts`), what it draws (`Workstation.tsx` and its two panes), what
 * it says (`locales.ts`), and this module, which only wires them together.
 *
 * The store is declared `scope: 'root'` because the seat describes the frame's
 * presentation rather than one Session's content; the Session on screen still
 * travels in, as the hook source the seat reads to decide whether there is a
 * workspace to list at all.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { workstationFace } from './face.ts'
import type { WorkstationInject } from './face.ts'
import { en, zh } from './locales.ts'
import { HOST_USED_EVENT, REMOTE_FILES, leaveRemoteHost, startRemoteHosts } from './remote.ts'
import { ServerExitButton, type ServerExitInjected } from './ServerExitButton.tsx'
import { createWorkstationStore } from './store.ts'
import { Workstation } from './Workstation.tsx'
import { WorkstationToggle, type WorkstationToggleInjected } from './WorkstationToggle.tsx'

export type { WorkstationKey } from './locales.ts'
export type {
  DirectoryLevel, LevelState, TabFailureKind, TabImage, TabState,
  WorkstationActionMap, WorkstationState,
} from './store.ts'
export type { WorkstationFace, WorkstationInject, WorkspaceFilesRemote } from './face.ts'
export type { FileTreeProps } from './FileTree.tsx'
export type { FileViewerProps } from './FileViewer.tsx'
export type { WorkstationProps } from './Workstation.tsx'
export type { WorkstationToggleInjected, WorkstationToggleProps } from './WorkstationToggle.tsx'

/** This package's copy namespace. */
const NS = 'workstation'

/**
 * Required browser services: the slot registry, copy, the frame's own
 * presentation service, the Session on screen, and the Remote namespace the
 * tree lists with.
 */
export const inject = ['slots', 'locale', 'layout', 'uiSession', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the dictionaries, the seat, and the header toggle.
 * @param ctx - client root context carrying the registry, the frame, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workstation: dictionaries')

  // The face outlives every listing it starts and dies with the plugin: one
  // controller covers the seat's whole lifetime, so a settlement after the seat
  // goes away writes nothing.
  const controller = new AbortController()
  ctx.effect(() => () => { controller.abort() }, 'ui-workstation: face lifetime')

  // The Session on screen. Both readers — the hook the seat renders with, and
  // the source the face calls with — read the same stable binding source, so
  // they can never disagree about which workspace is open.
  const current = ctx.uiSession.adapter.current
  const sessionId: HostObservable<SessionId | undefined> = {
    getSnapshot: () => current.getSnapshot().key as SessionId | undefined,
    subscribe: listener => current.subscribe(() => { listener() }),
  }

  // ## which server the seat is looking at
  //
  // The server manager owns that answer, so the seat polls it instead of keeping
  // a second copy of the choice: a window that switches hosts or clears the
  // current one moves the tree on the next poll. The poller lives exactly as long
  // as this plugin, and the face reads the same snapshot the seat renders from, so
  // a listing is never attributed to a host other than the one it was asked for.
  const hosts = startRemoteHosts()
  ctx.effect(() => () => { hosts.dispose() }, 'ui-workstation: remote host polling')

  // Pressing 使用 in the server manager makes a host current; the tree then shows
  // that machine, but the frame is still wherever the click came from. Following
  // the switch here is what makes the surface match the host within one poll, and
  // the seat's 回到对话 pill is the way back. Only a *change* of host moves the
  // frame, so someone who returns to the conversation is not dragged out again by
  // a host that merely stays current.
  // A server page is the seat layout, not the full-screen one: the header it carries is the
  // only place the way out lives, and the full-screen stage collapses that header with the
  // conversation.
  ctx.effect(() => {
    let previous = hosts.getSnapshot().currentHostId
    ctx.layout.setServerMode(previous !== null)
    return hosts.subscribe(() => {
      const current = hosts.getSnapshot().currentHostId
      ctx.layout.setServerMode(current !== null)
      if (current !== null && current !== previous) ctx.layout.setStage?.('workstation')
      previous = current
    })
  }, 'ui-workstation: follow the current host')

  // The host list in the remote panel activates a host through the same route as 「使用」, and
  // announces it here: picking a server has to show that server's files even when it was
  // already the current one, which the observable above deliberately ignores.
  ctx.effect(() => {
    if (typeof window === 'undefined') return () => {}
    const open = (): void => { ctx.layout.setStage?.('workstation') }
    window.addEventListener(HOST_USED_EVENT, open)
    return () => { window.removeEventListener(HOST_USED_EVENT, open) }
  }, 'ui-workstation: open the server page when a host is picked')

  const face = workstationFace({
    remote: ctx.remote,
    remoteFiles: REMOTE_FILES,
    sessionId: () => current.getSnapshot().key as SessionId | undefined,
    remoteHostId: () => hosts.getSnapshot().currentHostId,
    signal: controller.signal,
  })

  const store = createWorkstationStore()
  ctx.effect(() => ctx.slots.inject('shell.workstation', () => ctx.slots.register(
    {
      name: 'shell.workstation',
      locale: NS,
      store,
      inject: (actions): WorkstationInject => ({
        hooks: { sessionId, remoteHosts: hosts },
        // The full-screen stage folds the Conversation — and with it the
        // header that carries the stage control — away, so the seat owns the
        // way back and lands on the conversation layout in one click.
        leaveIde: () => { ctx.layout.setWorkstation(false) },
        ...face(actions),
      }),
    },
    Workstation,
  )), 'ui-workstation: workstation seat')

  // The toggle sits beside the folder control, in the row the Conversation
  // header owns, and walks the frame through conversation → workstation → IDE.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workstation',
    locale: NS,
    inject: (): WorkstationToggleInjected => ({ cyclePresentation: () => { ctx.layout.cyclePresentation() } }),
  }, WorkstationToggle)), 'ui-workstation: header toggle')

  // The header's one server-page control. It shares the row with the toggle, and
  // the two never show together: the stages are this desktop's, leaving is the
  // server's.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'server-exit',
    locale: NS,
    inject: (): ServerExitInjected => ({
      leaveServer: () => {
        void leaveRemoteHost().then((failure) => {
          if (failure !== null) console.error('ui-workstation: leaving the server failed:', failure.message)
        })
      },
    }),
  }, ServerExitButton)), 'ui-workstation: server exit')
}
