/**
 * Browser half: register `files` as a right-Sidebar tab type, and the
 * Session-header control that shows it.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip title into
 * the keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 *
 * The file split is this package's layering: what the type IS
 * (`definition.tsx`), what it keeps (`store.ts`), how it lists (`face.ts`), what
 * it draws (`FilesBody.tsx`, `FilesTitle.tsx`, `FilesToggleAction.tsx`), what it
 * says (`locales.ts`), and this module, which only wires them together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { FILES_ID, FILES_KIND, filesDefinition } from './definition.tsx'
import { createList, filesFace } from './face.ts'
import { FilesBody } from './FilesBody.tsx'
import { FilesTitle } from './FilesTitle.tsx'
import { FilesToggleAction, type FilesToggleInjected } from './FilesToggleAction.tsx'
import { en, zh } from './locales.ts'
import { createFilesStore } from './store.ts'

export type { SidebarFilesKey } from './locales.ts'
export type { DirLevel, FilesState, FilesTabState, LevelState } from './store.ts'
export type { FilesInjected, ListWorkspaceDirectory, WorkspaceFilesListRemote } from './face.ts'
export type { FilesBodyProps } from './FilesBody.tsx'
export type { FilesToggleActionProps, FilesToggleInjected } from './FilesToggleAction.tsx'

/** This package's copy namespace. */
const NS = 'sidebarFiles'

/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its namespace, copy, and the right column the header control
 * opens the tree into.
 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the type, its dictionaries, its body, its chip
 * title, and the Session-header toggle.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), 'ui-sidebar-files: files type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-files: dictionaries')

  const store = createFilesStore()
  const inject = filesFace(createList(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject },
    FilesBody,
  )), 'ui-sidebar-files: files tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: FILES_ID },
    FilesTitle,
  )), 'ui-sidebar-files: files tab title')

  // The column's own control folds whatever pane it holds; this one is about
  // one pane: fold the tree away when it is the one showing, and open it
  // otherwise. `openTab` reveals the column in the same step, so a collapsed
  // column needs no second call.
  const toggleWorkspaceFiles = (): void => {
    const sidebar = ctx.sidebarRight
    if (sidebar.isExpanded() && sidebar.active()?.kind === FILES_KIND) sidebar.toggleExpanded()
    else sidebar.openTab(FILES_KIND)
  }
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workspace-files',
    locale: NS,
    inject: (): FilesToggleInjected => ({ toggleWorkspaceFiles }),
  }, FilesToggleAction)), 'ui-sidebar-files: header toggle')
}
