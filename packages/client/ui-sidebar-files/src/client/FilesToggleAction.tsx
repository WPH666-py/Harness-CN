/**
 * Session-header entry point for the file tree's tab.
 *
 * The right column already carries a control that collapses and expands
 * whatever pane it holds. This one is about a specific pane: it opens the
 * workspace file tree and folds the column away again, so the tree is one
 * gesture from any Session instead of a tab the reader has to find in the
 * column's guide first.
 *
 * The button holds no state of its own because the column's own store is not
 * this package's to read; the gesture is decided when it is performed, from the
 * service's answer at that moment.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import css from './FilesToggleAction.module.css'

/** Full props for the Session-header workspace-files toggle. */
export type FilesToggleActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'sidebarFiles'>
  & FilesToggleInjected

/**
 * What the header control asks the right Sidebar to do.
 *
 * The decision — fold the column away, or open the tree in it — belongs to the
 * package that owns the tab type, so the component receives one gesture and
 * performs none of the reasoning.
 */
export interface FilesToggleInjected {
  /** Open the file tree, or fold the column that already shows it. */
  readonly toggleWorkspaceFiles: () => void
}

/**
 * Session-header control that shows or hides the workspace file tree.
 * @param props - runtime slot currency, the toggle, and the namespace translator.
 * @returns the icon button.
 */
export function FilesToggleAction({ toggleWorkspaceFiles, t }: FilesToggleActionProps): ReactNode {
  const label = t('toggle.label')
  return (
    <button
      type="button"
      className={css.trigger}
      aria-label={label}
      title={label}
      data-files-toggle
      onClick={toggleWorkspaceFiles}
    >
      <IconFolderOpenOutline16 />
    </button>
  )
}
