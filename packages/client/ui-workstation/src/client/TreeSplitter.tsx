/**
 * The vertical strip between the tree and the viewer.
 *
 * It reports widths rather than containing the panes: the seat's store owns the
 * number, so a drag survives re-renders and the frame can resize the seat
 * independently.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './Workstation.module.css'

/** What the strip draws from: the width a drag starts at, and where widths go. */
export interface TreeSplitterProps {
  /** Current tree column width in px, the base a drag is measured from. */
  width: number
  /**
   * Receives the pointer-derived width while the strip is dragged.
   * @param px - requested tree column width in px.
   */
  onResize: (px: number) => void
}

/** Where the pointer went down, so every move reports against one origin. */
interface DragOrigin {
  /** Pointer that owns the capture. */
  pointerId: number
  /** Client x at pointerdown. */
  x: number
  /** Tree width at pointerdown. */
  width: number
}

/**
 * Draw the tree/viewer split handle.
 * @param props - the current width and the width sink.
 * @returns the drag strip.
 */
export function TreeSplitter(props: TreeSplitterProps): ReactNode {
  const [dragging, setDragging] = useState(false)
  const origin = useRef<DragOrigin | null>(null)
  const capture = useRef<{ element: HTMLDivElement; pointerId: number } | null>(null)
  // Handlers stay mounted across renders, so they read the current props.
  const callbacks = useRef(props)
  callbacks.current = props

  const release = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    setDragging(false)
  }, [])
  useEffect(() => release, [release])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    capture.current = { element, pointerId: event.pointerId }
    origin.current = { pointerId: event.pointerId, x: event.clientX, width: callbacks.current.width }
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (start === null || start.pointerId !== event.pointerId) return
    callbacks.current.onResize(start.width + (event.clientX - start.x))
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (start === null || start.pointerId !== event.pointerId) return
    callbacks.current.onResize(start.width + (event.clientX - start.x))
    origin.current = null
    release()
  }, [release])

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (origin.current?.pointerId !== event.pointerId) return
    origin.current = null
    release()
  }, [release])

  return (
    <div
      className={css.resizer}
      role="separator"
      aria-orientation="vertical"
      data-workstation-resizer
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}
