/**
 * The workstation's tree half: the Session's workspace, listed one level at a
 * time, with directories that expand in place and files that open in the
 * editor's tabs.
 *
 * The tree starts at the Session's working directory and appends child names
 * onto it, so every key below the root is an absolute path the listing endpoint
 * already accepts. One level draws from the store and one request goes through
 * the injected face per level opened; the component itself only decides what a
 * click means.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  FileTypeIcon,
  IconFolderCloseMedium,
  IconFolderOpenMedium,
  IconWorkspaceTreeOutlineMedium,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkstationFace } from './face.ts'
import { childPath, orderEntries } from './paths.ts'
import type { WorkstationState } from './store.ts'
import css from './FileTree.module.css'

/** What one tree level needs: the store, the copy, and the three gestures. */
export interface FileTreeProps {
  /** The workstation store's selector hook. */
  readonly useStore: <S>(selector: (state: WorkstationState) => S) => S
  /** This package's copy, already bound to the `workstation` namespace. */
  readonly translate: TranslateNS<'workstation'>
  /** List one directory that was never asked for. */
  readonly openDirectory: WorkstationFace['openDirectory']
  /** Open or close one directory's level. */
  readonly toggleDirectory: WorkstationFace['toggleDirectory']
  /** Open one file in its own tab. */
  readonly openFile: WorkstationFace['openFile']
  /** Focus the tab of a file that is already open. */
  readonly focusTab: WorkstationFace['focusTab']
  /**
   * The Session's working directory, which the tree lists first; `undefined`
   * while the Session summary that carries it has not arrived.
   */
  readonly root: string | undefined
  /** Drawn column width in px, owned by the seat's splitter; the viewer takes the rest. */
  readonly width: number
}

/** The share every level draws from, apart from its own path and indentation. */
type LevelShare = Omit<FileTreeProps, 'root' | 'width'>

/** One level's props: the shared share plus its own path and indentation. */
interface LevelProps extends LevelShare {
  /** Absolute path of the directory this level lists. */
  readonly path: string
  /** How deep under the root the level sits, for indentation only. */
  readonly depth: number
}

/** One row's props: the shared share plus the entry it draws. */
interface RowProps extends LevelShare {
  /** Absolute path of this entry. */
  readonly path: string
  /** The entry's own name, as the listing gave it. */
  readonly name: string
  /** Whether this entry lists a directory rather than opening in a tab. */
  readonly directory: boolean
  /** How deep under the root this row sits, for indentation only. */
  readonly depth: number
}

/**
 * Draw one row, and the level under it when it is an open directory.
 *
 * A row subscribes to its OWN path: a directory's open state is
 * `state.expanded.includes(path)` for that directory, not for the level that
 * lists it, and reading the listing level's flag here left every folder shut —
 * the click recorded the path, nothing re-rendered, and the tree looked
 * unexpandable.
 * @param props - the shared share and this entry's path, name, kind and depth.
 * @returns the row and, for an open directory, the level below it.
 */
function Row(props: RowProps): ReactNode {
  const { path, name, directory, depth, useStore, translate, openDirectory, toggleDirectory, openFile, focusTab } = props
  const open = useStore(state => state.expanded.includes(path))
  const active = useStore(state => state.activePath === path)
  // A tab's path set as one string: a selector must return a stable value, so
  // the tabs array itself cannot be what the row subscribes to.
  const openPaths = useStore(state => state.tabs.map(tab => tab.path).join('\n'))
  return (
    <li className={css.item}>
      <button
        type="button"
        className={css.row}
        data-workstation-entry={directory ? 'directory' : 'file'}
        data-workstation-path={path}
        aria-expanded={directory ? open : undefined}
        aria-current={active ? 'true' : undefined}
        title={name}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => {
          if (directory) toggleDirectory(path, open)
          else if (openPaths.split('\n').includes(path)) focusTab(path)
          else openFile(path)
        }}
      >
        {directory
          ? open ? <IconFolderOpenMedium /> : <IconFolderCloseMedium />
          : <FileTypeIcon kind={classifyFileType(name)} size={16} />}
        <span className={css.name}>{name}</span>
      </button>
      {directory && open
        ? (
          <Level
            useStore={useStore}
            translate={translate}
            openDirectory={openDirectory}
            toggleDirectory={toggleDirectory}
            openFile={openFile}
            focusTab={focusTab}
            path={path}
            depth={depth + 1}
          />
        )
        : null}
    </li>
  )
}

/**
 * Draw one directory level, and its open descendants.
 * @param props - the shared share, this level's path, and its depth.
 * @returns the level's rows, or the state that stands in for them.
 */
function Level(props: LevelProps): ReactNode {
  const { path, depth, useStore, translate: t, openDirectory } = props
  const level = useStore(state => state.levels[path])

  // A level that was never asked for is asked for here, once: the store records
  // the request as `loading`, so the effect's dependency changes and stops.
  useEffect(() => {
    if (level === undefined) openDirectory(path)
  }, [level, openDirectory, path])

  if (level === undefined || level.kind === 'loading') {
    return <div className={css.status} data-workstation-level="loading">{t('tree.loading')}</div>
  }
  if (level.kind === 'failed') {
    return (
      <div className={css.status} role="alert" data-workstation-level="failed">
        {t('tree.failed', { message: level.failure.message })}
      </div>
    )
  }
  const entries = orderEntries(level.level.entries)
  if (entries.length === 0) {
    return <div className={css.status} data-workstation-level="empty">{t('tree.empty')}</div>
  }
  return (
    <ul className={css.level} role={depth === 0 ? 'tree' : 'group'}>
      {entries.map((entry) => {
        const child = childPath(path, entry.name)
        return (
          <Row
            key={child}
            useStore={useStore}
            translate={t}
            openDirectory={openDirectory}
            toggleDirectory={props.toggleDirectory}
            openFile={props.openFile}
            focusTab={props.focusTab}
            path={child}
            name={entry.name}
            directory={entry.type === 'directory'}
            depth={depth}
          />
        )
      })}
      {level.level.truncated
        ? <li className={css.status} role="note" data-workstation-level="truncated">{t('tree.truncated')}</li>
        : null}
    </ul>
  )
}

/**
 * Draw the tree's header and its root level.
 * @param props - the shared share and the Session's working directory.
 * @returns the tree column.
 */
export function FileTree(props: FileTreeProps): ReactNode {
  const t = props.translate
  const { root, width, ...share } = props
  return (
    <section className={css.tree} style={{ width: `${width}px` }} aria-label={t('tree.root')} data-workstation-tree>
      <header className={css.head}>
        <IconWorkspaceTreeOutlineMedium />
        <span className={css.title}>{t('tree.root')}</span>
      </header>
      <nav className={css.body}>
        {root === undefined
          ? <div className={css.status} data-workstation-level="pending">{t('tree.loading')}</div>
          : <Level {...share} path={root} depth={0} />}
      </nav>
    </section>
  )
}
