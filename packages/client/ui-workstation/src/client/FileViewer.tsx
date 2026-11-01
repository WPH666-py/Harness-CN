/**
 * The workstation's editor half: one tab per open file, the active tab's text in
 * a textarea under a line-number gutter, a band across the line the caret is on,
 * and an image's bytes as a preview.
 *
 * Nothing here fetches or writes: the tab is in the store, and every gesture —
 * focusing, typing, saving, closing — is one call through the injected face. The
 * blob URL an image needs and the code area's scroll offset are the two pieces of
 * browser state this component owns.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { lineCount, lineIndexAt, lineNumberDigits, lineNumbers } from './editor.ts'
import { isReadOnlyEncoding } from './encoding.ts'
import type { WorkstationFace } from './face.ts'
import { baseName, formatBytes, imageMediaType } from './paths.ts'
import type { WorkstationState } from './store.ts'
import css from './FileViewer.module.css'

/** One Tab press inserts this much indentation; the textarea never autoformats. */
const INDENT = '  '

/**
 * The height of one line in px, which the stylesheet's `line-height` must equal.
 *
 * The caret band is placed from a line index, and CSS cannot multiply a row count
 * by a line box in a way this layout can use, so the number comes from here and
 * the stylesheet repeats it.
 */
const LINE_HEIGHT = 19

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

/** What one text tab's code area draws, and the two gestures it forwards. */
interface CodeEditorProps {
  /** The tab's buffer; the store owns it and the textarea is controlled by it. */
  readonly text: string
  /** The decoded encoding cannot be written back, so the buffer is display only. */
  readonly readOnly: boolean
  /** The textarea's accessible name, already localized. */
  readonly label: string
  /** Replace the buffer after an edit. */
  readonly edit: (text: string) => void
  /** Write the buffer to the Host. */
  readonly save: () => void
}

/**
 * One text tab: its line numbers, its caret band, and its textarea.
 *
 * The textarea is the only scroller. The gutter moves by the textarea's scroll
 * offset and the band by the caret's line, both placed from state rather than
 * from a second scroll container, so the numbers cannot drift from the lines they
 * number and the band stays on the caret's line after any scroll.
 * @param props - the buffer, its writability, and the two gestures.
 * @returns the code area.
 */
function CodeEditor(props: CodeEditorProps): ReactNode {
  const { text, readOnly, label, edit, save } = props
  const area = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const [line, setLine] = useState(0)
  const [offset, setOffset] = useState(0)

  // A controlled textarea replaces its value on commit, which drops the caret at
  // the end; an indentation inserted at the caret re-places it after that commit.
  useLayoutEffect(() => {
    if (caret.current === null) return
    const at = caret.current
    caret.current = null
    area.current?.setSelectionRange(at, at)
  })

  /**
   * Point the band at the line the caret moved to.
   * @param event - a textarea event whose element carries the new caret.
   */
  const follow = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const element = event.currentTarget
    setLine(lineIndexAt(element.value, element.selectionStart))
  }

  const count = lineCount(text)

  return (
    <div className={css.code} data-workstation-code>
      <div className={css.gutter} aria-hidden="true">
        <div
          className={css.numbers}
          data-workstation-line-numbers
          style={{ width: `${lineNumberDigits(count)}ch`, transform: `translateY(${-offset}px)` }}
        >
          {lineNumbers(count)}
        </div>
      </div>
      <div className={css.viewport}>
        <div className={css.bandLayer} aria-hidden="true">
          <div
            className={css.band}
            data-workstation-current-line={line + 1}
            style={{ top: `${line * LINE_HEIGHT - offset}px`, height: `${LINE_HEIGHT}px` }}
          />
        </div>
        <textarea
          ref={area}
          className={css.editor}
          data-workstation-editor
          aria-label={label}
          value={text}
          readOnly={readOnly}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            follow(event)
            edit(event.currentTarget.value)
          }}
          onClick={follow}
          onSelect={follow}
          onKeyUp={follow}
          onScroll={(event) => { setOffset(event.currentTarget.scrollTop) }}
          onKeyDown={(event) => {
            // A read-only buffer has no save to run and no indentation to insert;
            // Tab keeps its meaning of moving to the next control.
            if (readOnly) return
            if (event.key === 'Tab') {
              event.preventDefault()
              const start = event.currentTarget.selectionStart
              const next = `${text.slice(0, start)}${INDENT}${text.slice(event.currentTarget.selectionEnd)}`
              caret.current = start + INDENT.length
              setLine(lineIndexAt(next, start + INDENT.length))
              edit(next)
              return
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              save()
            }
          }}
        />
      </div>
    </div>
  )
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
  const encoding = active?.encoding ?? null
  /** The encoding that keeps this tab from writing back, `null` when it may. */
  const displayOnly = encoding !== null && isReadOnlyEncoding(encoding) ? encoding : null

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
            {displayOnly === null ? null : (
              <span className={css.hint} data-workstation-readonly>
                {t('viewer.readOnly', { encoding: displayOnly.toUpperCase() })}
              </span>
            )}
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
        {active === null || !active.loading ? null : <p className={css.status}>{t('viewer.loading')}</p>}
        {active === null ? null : active.kind === 'image' ? (
          <div className={css.preview} data-workstation-preview>
            {source === null ? null : (
              <img className={css.image} src={source} alt={t('preview.image')} draggable={false} />
            )}
          </div>
        ) : active.kind === 'binary' ? (
          <p className={css.status} data-workstation-binary>
            {t('viewer.binary', { size: formatBytes(active.size ?? 0) })}
          </p>
        ) : active.loading || active.failedOn === 'read' ? null : (
          <CodeEditor
            key={active.path}
            text={active.text}
            readOnly={displayOnly !== null}
            label={t('editor.label', { name: baseName(active.path) })}
            edit={(next) => { editTab(active.path, next) }}
            save={() => { saveTab(active.path, active.text) }}
          />
        )}
      </div>
    </section>
  )
}
