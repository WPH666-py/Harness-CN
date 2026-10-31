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
import { createWorkstationStore } from './store.ts'
import { Workstation } from './Workstation.tsx'
import { WorkstationToggle, type WorkstationToggleInjected } from './WorkstationToggle.tsx'

export type { WorkstationKey } from './locales.ts'
export type {
  DirectoryLevel, FilePage, LevelState, ViewerState, WorkstationActionMap, WorkstationState,
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
  const face = workstationFace({
    remote: ctx.remote,
    sessionId: () => current.getSnapshot().key as SessionId | undefined,
    signal: controller.signal,
  })

  const store = createWorkstationStore()
  ctx.effect(() => ctx.slots.inject('shell.workstation', () => ctx.slots.register(
    {
      name: 'shell.workstation',
      locale: NS,
      store,
      inject: (actions): WorkstationInject => ({ hooks: { sessionId }, ...face(actions) }),
    },
    Workstation,
  )), 'ui-workstation: workstation seat')

  // The toggle sits beside the folder control, in the row the Conversation
  // header owns, and flips the frame's presentation in one click.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workstation',
    locale: NS,
    inject: (): WorkstationToggleInjected => ({ toggleWorkstation: () => { ctx.layout.toggleWorkstation() } }),
  }, WorkstationToggle)), 'ui-workstation: header toggle')
}
