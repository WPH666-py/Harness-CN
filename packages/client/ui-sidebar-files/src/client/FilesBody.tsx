/**
 * The file tree's body: the session's workspace root, listed one level at a
 * time, with the file operations a file manager adds.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a gesture means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. A row is also selectable, and the
 * selection is what the header's controls act on; a right-click opens the same
 * operations on that one row. The header row is the text preview's: the root's
 * path, directories greyed and the last segment in full ink, then the controls
 * at its end — the file operations, and reload, which drops every listed level
 * and asks again for the expanded ones.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, FileTypeIcon, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, IconProjectAddOutline16,
  IconRefreshOutline16, IconCopyOutline16, Input, Menu, Modal, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { baseName, childPath, parentPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import type {} from './locales.ts'
import type { FilesTabState, NewEntryDraft, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/**
 * Say why the reader's last gesture did not land, in terms of that gesture.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show above the tree.
 */
export function gestureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/exists': return t('gesture.exists')
    case 'workspace-file/not-empty': return t('gesture.notEmpty')
    // The level was listed earlier, so a path that is gone now moved or was
    // deleted by something else; the code alone says which is worth trying.
    case 'workspace-file/not-found': return t('gesture.gone')
    default: return t('gesture.failed', { message: failure.message })
  }
}

/**
 * The directory a gesture lands in: the selected row when it is a directory,
 * and the tree's root when the selection is a file, an `other` entry, or
 * nothing at all.
 * @param state - the tab's tree.
 * @returns the absolute path of the destination directory.
 */
export function destinationOf(state: FilesTabState): string {
  const selected = state.selected
  if (selected === null) return state.root
  const parent = parentPath(selected)
  const level = state.levels[parent]
  if (level === undefined || level.kind !== 'ready') return state.root
  const entry = level.level.entries.find(candidate => childPath(parent, candidate.name) === selected)
  return entry?.type === 'directory' ? selected : state.root
}

/* jscpd:ignore-start -- the header row is the document preview's (ui-sidebar-documentpreview
   TextPreview `usePathClipped`), copied because a plugin bundle shares runtime code
   only through the platform modules. TODO: once the artifact and slot surfaces
   settle, one copy in ui-primitives could serve every pane header. */
/**
 * Keep the path row's `data-files-path-clipped` current: set while the path's
 * text is wider than its box, so the stylesheet fades the clipped start. Read
 * after each commit that can change the path or mount the header, and whenever
 * either box resizes; written to the DOM directly because it changes only how
 * the stylesheet fades what is already rendered.
 */
function usePathClipped(
  box: RefObject<HTMLDivElement | null>,
  text: RefObject<HTMLSpanElement | null>,
  path: string | undefined,
): void {
  useLayoutEffect(() => {
    const outer = box.current
    const inner = text.current
    if (outer === null || inner === null) return undefined
    const apply = (): void => {
      if (inner.offsetWidth > outer.clientWidth) outer.dataset.filesPathClipped = ''
      else delete outer.dataset.filesPathClipped
    }
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply)
    observer?.observe(outer)
    observer?.observe(inner)
    return () => { observer?.disconnect() }
  }, [box, text, path])
}
/* jscpd:ignore-end */

/** One row the reader asked the context menu about. */
interface MenuTarget {
  /** Absolute path of the row. */
  readonly path: string
  /** What the row is, which decides what may be done with it. */
  readonly kind: 'directory' | 'file'
}

/** One open context menu: the row it acts on, and where the pointer asked for it. */
interface MenuAnchor extends MenuTarget {
  /** Pointer x at the moment of the right-click. */
  readonly x: number
  /** Pointer y at the moment of the right-click. */
  readonly y: number
}

/** What every level shares: the tab's tree and the gestures a row offers. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (path: string) => void
  readonly onOpen: (path: string) => void
  readonly onSelect: (path: string) => void
  readonly onMenu: (target: MenuTarget, event: MouseEvent<HTMLButtonElement>) => void
  readonly onCreate: (draft: NewEntryDraft, name: string) => void
  readonly onCancel: () => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  const selected = tree.state.selected === path ? true : undefined
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button
          type="button"
          className={css.row}
          aria-expanded={expanded}
          data-files-selected={selected}
          onClick={() => { tree.onSelect(path); tree.onToggle(path) }}
          onContextMenu={(event) => { tree.onMenu({ path, kind: 'directory' }, event) }}
        >
          {expanded ? <IconFolderOpen16 className={css.icon} /> : <IconFolderClose16 className={css.icon} />}
          <span className={css.name}>{entry.name}</span>
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path}>
        <button
          type="button"
          className={css.row}
          data-files-selected={selected}
          onClick={() => { tree.onSelect(path); tree.onOpen(path) }}
          onContextMenu={(event) => { tree.onMenu({ path, kind: 'file' }, event) }}
        >
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
          <span className={css.name}>{entry.name}</span>
        </button>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** The inline name input one new entry is waiting for, drawn under its parent. */
function Draft({ draft, tree }: { draft: NewEntryDraft; tree: TreeContext }): ReactNode {
  const [name, setName] = useState('')
  const label = tree.t(draft.kind === 'directory' ? 'draft.nameFolder' : 'draft.nameFile')
  return (
    <li className={css.item} data-files-draft={draft.kind}>
      <div className={css.row}>
        {draft.kind === 'directory'
          ? <IconFolderClose16 className={css.icon} />
          : <FileTypeIcon kind="other" size={16} className={css.fileIcon} />}
        <Input
          className={css.draft}
          value={name}
          aria-label={label}
          placeholder={label}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              // A blank name names nothing; leaving the input open is the whole
              // answer, where a request would come back about a segment the
              // reader never meant to type.
              if (name.trim() !== '') tree.onCreate(draft, name)
              return
            }
            if (event.key === 'Escape') tree.onCancel()
          }}
          onBlur={tree.onCancel}
        />
      </div>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries)
  const draft = state.draft !== null && state.draft.parent === path ? state.draft : null
  return (
    <>
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
      {draft !== null && <Draft draft={draft} tree={tree} />}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions,
  start, load, toggle, createEntry, removeEntry, pasteEntry, t,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [removing, setRemoving] = useState<MenuTarget | null>(null)
  const pathRef = useRef<HTMLDivElement>(null)
  const pathTextRef = useRef<HTMLSpanElement>(null)
  // A context menu opens where the pointer asked for it, so its anchor is the
  // pointer's own zero-size rect rather than the row's box.
  const anchorRect = useCallback(
    () => (menu === null ? null : new DOMRect(menu.x, menu.y, 0, 0)),
    [menu],
  )
  usePathClipped(pathRef, pathTextRef, state?.root)
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null
  const { root } = state
  const destination = destinationOf(state)
  const clipboard = state.clipboard
  const openFile = (path: string): void => { tabActions.openResource(fileAddressFor(sessionId, root, path)) }
  const toggleDir = (path: string): void => { toggle(tab.id, path, state.levels[path] !== undefined, signal) }
  /** Show the name input for one new entry, opening the directory it lands in. */
  const openDraft = (kind: NewEntryDraft['kind']): void => {
    // A collapsed directory draws no rows, so an input under it would have
    // nowhere to appear; opening it is part of the gesture.
    if (!state.expanded.includes(destination)) toggleDir(destination)
    actions.drafted(tab.id, { parent: destination, kind })
  }
  /** Paste the clipboard into one directory, under the name the entry has. */
  const pasteInto = (into: string): void => {
    /* v8 ignore next -- the header control is disabled without a clipboard, and a menu never selects a disabled row */
    if (clipboard === null) return
    pasteEntry(tab.id, clipboard, into, signal)
  }
  const openMenu = (target: MenuTarget, event: MouseEvent<HTMLButtonElement>): void => {
    actions.selected(tab.id, target.path)
    setMenu({ ...target, x: event.clientX, y: event.clientY })
  }
  /** The rows one right-clicked entry offers, in display order. */
  const menuItems = (target: MenuTarget): MenuEntry[] => {
    const items: MenuEntry[] = [
      { id: 'open', label: t('menu.open') },
      { id: 'copy', label: t('menu.copy') },
      { id: 'cut', label: t('menu.cut') },
    ]
    // Only a directory holds anything to paste into.
    if (target.kind === 'directory') items.push({ id: 'paste', label: t('menu.paste'), disabled: clipboard === null })
    items.push({ id: 'separator', type: 'separator' }, { id: 'delete', label: t('menu.delete'), danger: true })
    return items
  }
  const runMenu = (target: MenuTarget, command: string): void => {
    setMenu(null)
    if (command === 'open') {
      if (target.kind === 'directory') toggleDir(target.path)
      else openFile(target.path)
      return
    }
    if (command === 'copy' || command === 'cut') {
      actions.clipboarded(tab.id, { mode: command, path: target.path })
      return
    }
    if (command === 'delete') {
      setRemoving(target)
      return
    }
    pasteInto(target.path)
  }
  /** Perform the removal the reader confirmed. */
  const removeConfirmed = (target: MenuTarget): void => {
    setRemoving(null)
    removeEntry(tab.id, target.path, target.kind === 'directory', signal)
  }
  const tree: TreeContext = {
    state,
    onToggle: toggleDir,
    onOpen: openFile,
    onSelect: (path) => { actions.selected(tab.id, path) },
    onMenu: openMenu,
    onCreate: (draft, name) => { createEntry(tab.id, draft.parent, name, draft.kind, signal) },
    onCancel: () => { actions.drafted(tab.id, null) },
    t,
  }
  // Reload drops every level and asks again for the expanded ones; a collapsed
  // level is fetched again the next time it opens.
  const reload = (): void => {
    actions.reset(tab.id)
    for (const path of state.expanded) load(tab.id, path, signal)
  }
  const { directory, name } = pathPartsOf(root)
  return (
    <div className={css.root} data-files-state="tree" data-files-root={root}>
      {/* jscpd:ignore-start -- the text preview's header row; see `usePathClipped`. */}
      <div className={css.header}>
        <div ref={pathRef} className={css.path} title={root} data-files-path>
          <span ref={pathTextRef} className={css.pathText}>
            {directory !== '' && <span className={css.pathDirectory}>{directory}</span>}
            <span className={css.pathName}>{name}</span>
          </span>
        </div>
        <div className={css.tools}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('newFile')}
            title={t('newFile')}
            data-files-new-file
            onClick={() => { openDraft('file') }}
          >
            <IconPlusOutline16 />
          </button>
          <button
            type="button"
            className={css.tool}
            aria-label={t('newFolder')}
            title={t('newFolder')}
            data-files-new-folder
            onClick={() => { openDraft('directory') }}
          >
            <IconProjectAddOutline16 />
          </button>
          <button
            type="button"
            className={css.tool}
            aria-label={t('paste')}
            title={t('paste')}
            data-files-paste
            disabled={clipboard === null}
            onClick={() => { pasteInto(destination) }}
          >
            <IconCopyOutline16 />
          </button>
        </div>
        <button
          type="button"
          className={css.tool}
          aria-label={t('reload')}
          title={t('reload')}
          data-files-reload
          onClick={reload}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      {/* jscpd:ignore-end */}
      {state.notice !== null && (
        <p className={css.notice} role="alert" data-files-notice data-files-code={state.notice.code}>
          {gestureLine(t, state.notice)}
        </p>
      )}
      <div className={css.body}>
        <ul className={css.level}><Level path={root} tree={tree} /></ul>
      </div>
      {menu !== null && (
        <Menu
          open
          anchor={null}
          items={menuItems(menu)}
          onSelect={(command) => { runMenu(menu, command) }}
          onClose={() => { setMenu(null) }}
          portal
          getAnchorRect={anchorRect}
        />
      )}
      {removing !== null && (
        <Modal
          open
          onClose={() => { setRemoving(null) }}
          title={t('confirm.title')}
          closeLabel={t('cancel')}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setRemoving(null) }}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => { removeConfirmed(removing) }}>{t('confirm.action')}</Button>
            </>
          )}
        >
          <p className={css.confirmLine}>
            {removing.kind === 'directory'
              ? t('confirm.directory', { name: baseName(removing.path) })
              : t('confirm.file', { name: baseName(removing.path) })}
          </p>
        </Modal>
      )}
    </div>
  )
}
