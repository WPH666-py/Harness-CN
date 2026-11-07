/**
 * The presentation menu: which arrangement it names, what it offers from there,
 * and that choosing one calls the frame once.
 *
 * The component reads the frame through the standard `useWorkstation`, `useIde`
 * and `useDrawer` hooks, so the spec supplies them as plain selectors over fixed
 * values — the same shape the renderer's provideRoot contribution has.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { WorkstationToggle } from '../src/client/WorkstationToggle.tsx'
import type { WorkstationToggleProps } from '../src/client/WorkstationToggle.tsx'

/** One of the three arrangements the frame can show. */
type Presentation = 'desk' | 'ide-three' | 'ide-full'

/** Mount the menu as if the frame showed `current`, and collect the gesture. */
function mount(current: Presentation): {
  present: ReturnType<typeof vi.fn>
  trigger: HTMLElement
  container: HTMLElement
} {
  const present = vi.fn()
  const seat = current !== 'desk'
  const props = {
    t: makeTranslate(zh),
    present,
    useWorkstation: <S,>(select: (state: boolean) => S): S => select(seat),
    useIde: <S,>(select: (state: boolean) => S): S => select(seat),
    useDrawer: <S,>(select: (state: boolean) => S): S => select(current === 'ide-three'),
  } as unknown as WorkstationToggleProps
  const { container } = render(<WorkstationToggle {...props} />)
  const trigger = container.querySelector<HTMLElement>('[data-workstation-toggle]')
  if (trigger === null) throw new Error('the presentation menu has no trigger')
  return { present, trigger, container }
}

/** The menu items currently offered. */
function itemsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-presentation]')]
}

afterEach(cleanup)

describe('WorkstationToggle', () => {
  it('names the arrangement the frame is in', () => {
    expect(mount('desk').trigger.textContent).toContain(zh['present.desk'])
    expect(mount('ide-three').trigger.textContent).toContain(zh['present.ideThree'])
    expect(mount('ide-full').trigger.textContent).toContain(zh['present.ideFull'])
  })

  it('reports the arrangement it names', () => {
    expect(mount('desk').trigger.getAttribute('data-stage')).toBe('desk')
    expect(mount('ide-three').trigger.getAttribute('data-stage')).toBe('ide-three')
    expect(mount('ide-full').trigger.getAttribute('data-stage')).toBe('ide-full')
  })

  it('stays closed until asked', () => {
    const { container } = mount('desk')
    expect(itemsOf(container)).toHaveLength(0)
    expect(container.querySelector('[data-presentation-menu]')).toBeNull()
  })

  it('offers the two arrangements it is not showing, from the desk', () => {
    const { container, trigger } = mount('desk')
    fireEvent.click(trigger)
    expect(itemsOf(container).map(item => item.getAttribute('data-presentation')))
      .toEqual(['ide-three', 'ide-full'])
  })

  it('offers the two arrangements it is not showing, from the three-column IDE', () => {
    const { container, trigger } = mount('ide-three')
    fireEvent.click(trigger)
    expect(itemsOf(container).map(item => item.getAttribute('data-presentation')))
      .toEqual(['desk', 'ide-full'])
  })

  it('offers the two arrangements it is not showing, from the full-screen IDE', () => {
    const { container, trigger } = mount('ide-full')
    fireEvent.click(trigger)
    expect(itemsOf(container).map(item => item.getAttribute('data-presentation')))
      .toEqual(['desk', 'ide-three'])
  })

  it('goes straight to the chosen arrangement and closes', () => {
    const { container, trigger, present } = mount('ide-full')
    fireEvent.click(trigger)
    fireEvent.click(itemsOf(container)[0] as HTMLElement)
    expect(present).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledWith('desk')
    expect(itemsOf(container)).toHaveLength(0)
  })

  it('steps aside entirely on a server page, where the arrangements do not apply', () => {
    const props = {
      t: makeTranslate(zh),
      present: vi.fn(),
      useWorkstation: <S,>(select: (state: boolean) => S): S => select(true),
      useIde: <S,>(select: (state: boolean) => S): S => select(true),
      useDrawer: <S,>(select: (state: boolean) => S): S => select(false),
      useServerMode: <S,>(select: (state: boolean) => S): S => select(true),
    } as unknown as WorkstationToggleProps
    const { container } = render(<WorkstationToggle {...props} />)
    expect(container.querySelector('[data-workstation-toggle]')).toBeNull()
  })
})
