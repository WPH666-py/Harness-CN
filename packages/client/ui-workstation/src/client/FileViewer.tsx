/**
 * The workstation's editor half: one tab per open file, the active tab's text in
 * a plain textarea, and an image's bytes as a preview.
 *
 * Nothing here fetches or writes: the tab is in the store, and every gesture —
 * focusing, typing, saving, closing — is one call through the injected face. The
 * blob URL an image needs is the one piece of browser state this component owns;
 * it is created from the tab's bytes and revoked when the tab behind it changes,
 * so closing a tab releases its URL.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkstationFace } from './face.ts'
import { baseName, formatBytes, imageMediaType } from './paths.ts'
import type { WorkstationState } from './store.ts'
import css from './FileViewer.module.css'

/** One Tab press inserts this much indentation; the textarea never autoformats. */
const INDENT = '  '

/** What the viewer needs: the store, the copy, and the tab gestures. */
export interface FileViewerProps {
  /** The workstation store's selector hook. */
  readonly useStore: <S>(selector: (state: WorkstationState) => S) => S
  /** This package's copy, already bound to the `workstation` namespace. */
  readonly translate: TranslateNS<'workstation'>
  /** Focus an already open tab. */
  readonly focusTab: WorkstationFace['focusTab']
  /** Replace the active tab's buffer from the editor. */
  readonly editTab: WorkstationFace['editTab']
  /** Write the active tab's buffer to the Host. */
  readonly saveTab: WorkstationFace['saveTab']
  /** Close a tab, saving it first when it is dirty. */
  readonly closeTab: WorkstationFace['closeTab']
}

/**
 * A blob URL for one image's bytes, revoked when the bytes change or the viewer goes.
 *
 * jsdom has no object-URL implementation; the image spec supplies one. A tab
 * without bytes yet (still loading) has no URL, so the preview element exists
 * before it can draw.
 * @param bytes - the decoded image, `null` while there is none.
 * @param mediaType - the blob's media type, `null` with no image.
 * @returns the object URL, or `null` while there is no image.
 */
function useObjectUrl(bytes: Uint8Array<ArrayBuffer> | null, mediaType: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (bytes === null || mediaType === null) {
      setUrl(null)
      return
    }
    const created = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
    setUrl(created)
    return () => { URL.revokeObjectURL(created) }
  }, [bytes, mediaType])
  return url
}

/**
 * Draw the tab strip, the active tab, or the state that stands in for one.
 * @param props - the store, the copy, and the tab gestures.
 * @returns the viewer column.
 */
export function FileViewer(props: FileViewerProps): ReactNode {
  const { useStore, translate: t, focusTab, editTab, saveTab, closeTab } = props
  const tabs = useStore(state => state.tabs)
  const activePath = useStore(state => state.activePath)
  const active = tabs.find(tab => tab.path === activePath) ?? null
  const mediaType = active !== null && active.kind === 'image' ? imageMediaType(active.path) : null
  const image = active?.image ?? null
  const source = useObjectUrl(image === null ? null : image.bytes, mediaType)
  const editor = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)

  // A controlled textarea replaces its value on commit, which drops the caret at
  // the end; an indentation inserted at the caret re-places it after that commit.
  useLayoutEffect(() => {
    if (caret.current === null) return
    const at = caret.current
    caret.current = null
    editor.current?.setSelectionRange(at, at)
  })

  return (
    <section className={css.viewer} data-workstation-viewer>
      {tabs.length === 0 ? null : (
        <div className={css.tabs} data-workstation-tabs>
          {tabs.map((tab) => {
            const focused = tab.path === activePath
            // The close button saves before it closes, so its label says so on
            // every tab: a clean tab has nothing to write, a dirty one must.
            const closeLabel = t('tab.closeSave')
            return (
              <div key={tab.path} className={css.tab} data-active={focused ? true : undefined}>
                <button
                  type="button"
                  className={css.tabButton}
                  title={tab.path}
                  aria-current={focused ? 'true' : undefined}
                  data-workstation-tab={tab.path}
                  onClick={() => { focusTab(tab.path) }}
                >
                  <span className={css.tabName}>{baseName(tab.path)}</span>
                  {tab.dirty ? <span className={css.dirty} aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  className={css.close}
                  aria-label={closeLabel}
                  title={closeLabel}
                  data-workstation-tab-close={tab.path}
                  onClick={() => { closeTab(tab.path, tab.text, tab.dirty) }}
                >
                  {'×'}
                </button>
              </div>
            )
          })}
        </div>
      )}
      {active === null ? null : (
        <header className={css.head}>
          <span className={css.path} title={active.path}>{active.path}</span>
          <span className={css.hints}>
            {image === null ? null : <span className={css.hint}>{t('preview.size', { size: formatBytes(image.size) })}</span>}
            {active.dirty ? <span className={css.dirtyHint}>{t('tab.unsaved')}</span> : null}
            {active.dirty ? (
              <button
                type="button"
                className={css.save}
                onClick={() => { saveTab(active.path, active.text) }}
              >
                {t('tab.save')}
              </button>
            ) : null}
          </span>
        </header>
      )}
      <div className={css.body}>
        {active === null ? (
          tabs.length === 0 ? <p className={css.status}>{t('viewer.empty')}</p> : null
        ) : active.failure === null ? null : (
          <p className={css.status} role="alert" data-workstation-tab-status>
            {active.failedOn === 'save'
              ? t('tab.saveFailed', { message: active.failure })
              : t('viewer.failed', { message: active.failure })}
          </p>
        )}
        {active === null ? null : active.loading ? <p className={css.status}>{t('viewer.loading')}</p> : null}
        {active === null ? null : active.kind === 'image' ? (
          <div className={css.preview} data-workstation-preview>
            {source === null ? null : (
              <img className={css.image} src={source} alt={t('preview.image')} draggable={false} />
            )}
          </div>
        ) : active.loading || active.failedOn === 'read' ? null : (
          <textarea
            ref={editor}
            className={css.editor}
            data-workstation-editor
            data-workstation-code
            aria-label={t('editor.label', { name: baseName(active.path) })}
            value={active.text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => { editTab(active.path, event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                event.preventDefault()
                const area = event.currentTarget
                const start = area.selectionStart
                caret.current = start + INDENT.length
                editTab(active.path, `${active.text.slice(0, start)}${INDENT}${active.text.slice(area.selectionEnd)}`)
                return
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                saveTab(active.path, active.text)
              }
            }}
          />
        )}
      </div>
    </section>
  )
}
