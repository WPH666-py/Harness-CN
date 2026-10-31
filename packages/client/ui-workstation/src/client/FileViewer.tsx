/**
 * The workstation's viewer half: the open file's lines behind a gutter, and a
 * "load more" control while the endpoint has more to give.
 *
 * Nothing here fetches: the page is in the store and the next page is one
 * gesture through the injected face.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkstationFace } from './face.ts'
import type { WorkstationState } from './store.ts'
import css from './FileViewer.module.css'

/** What the viewer needs: the store, the copy, and the paging gesture. */
export interface FileViewerProps {
  /** The workstation store's selector hook. */
  readonly useStore: <S>(selector: (state: WorkstationState) => S) => S
  /** This package's copy, already bound to the `workstation` namespace. */
  readonly translate: TranslateNS<'workstation'>
  /** Append the next page of the open file. */
  readonly loadMore: WorkstationFace['loadMore']
}

/**
 * Draw the open file, or the state that stands in for one.
 * @param props - the store, the copy, and the paging gesture.
 * @returns the viewer column.
 */
export function FileViewer(props: FileViewerProps): ReactNode {
  const { useStore, translate: t, loadMore } = props
  const viewer = useStore(state => state.viewer)
  const open = viewer.path
  return (
    <section className={css.viewer} data-workstation-viewer>
      {open === null
        ? null
        : (
          <header className={css.head}>
            <span className={css.path} title={open}>{open}</span>
            {viewer.loading ? <span className={css.hint}>{t('viewer.loading')}</span> : null}
          </header>
        )}
      <div className={css.body}>
        {viewer.failure === null ? null : (
          <p className={css.status} role="alert">{t('viewer.failed', { message: viewer.failure.message })}</p>
        )}
        {open === null ? (
          viewer.failure === null ? <p className={css.status}>{t('viewer.empty')}</p> : null
        ) : (
          <>
            <div className={css.code} data-workstation-code>
              {viewer.lines.map((line, at) => (
                <div key={at} className={css.line}>
                  <span className={css.gutter} aria-hidden="true">{at + 1}</span>
                  <span className={css.text}>{line === '' ? ' ' : line}</span>
                </div>
              ))}
            </div>
            {viewer.eof ? null : (
              <button
                type="button"
                className={css.more}
                disabled={viewer.loading}
                onClick={() => { loadMore(open, viewer.offset) }}
              >
                {t('viewer.more')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}
