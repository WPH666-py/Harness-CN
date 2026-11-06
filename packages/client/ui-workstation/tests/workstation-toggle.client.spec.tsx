/**
 * The workstation toggle: what it says at each of the three stages, whether it
 * reports them, and that one click is one gesture.
 *
 * The component reads the presentation through the frame's standard
 * `useWorkstation` and `useIde` hooks, so the spec supplies them as plain
 * selectors over fixed values — the same shape the renderer's provideRoot
 * contribution has.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { WorkstationToggle } from '../src/client/WorkstationToggle.tsx'
import type { WorkstationToggleProps } from '../src/client/WorkstationToggle.tsx'

/** The three presentations the button walks through. */
type Stage = 'conversation' | 'workstation' | 'ide'

/** Mount the toggle with the stage it should report and the gesture it should call. */
function mount(stage: Stage): { cycled: ReturnType<typeof vi.fn>; button: HTMLElement } {
  const cycled = vi.fn()
  const props = {
    t: makeTranslate(zh),
    cyclePresentation: cycled,
    useWorkstation: <S,>(select: (state: boolean) => S): S => select(stage !== 'conversation'),
    useIde: <S,>(select: (state: boolean) => S): S => select(stage === 'ide'),
  } as unknown as WorkstationToggleProps
  const { getByRole } = render(<WorkstationToggle {...props} />)
  const action = stage === 'ide' ? zh['toggle.workbenchAction'] : stage === 'workstation' ? zh['toggle.stage'] : zh['toggle.enable']
  return { cycled, button: getByRole('button', { name: action }) }
}

afterEach(cleanup)

describe('WorkstationToggle', () => {
  it('leads with the seat layout name from the conversation and names the stage it reaches', () => {
    const { button } = mount('conversation')
    expect(button.textContent).toBe(zh['toggle.mode'])
    expect(zh['toggle.mode']).toBe('IDE/工作站')
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.enable'])
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('data-stage')).toBe('conversation')
  })

  it('offers the full-screen stage once the seat is laid out', () => {
    const { button } = mount('workstation')
    expect(button.textContent).toBe(zh['toggle.fullscreen'])
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.stage'])
    expect(button.getAttribute('title')).toBe(zh['toggle.stage'])
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.hasAttribute('data-active')).toBe(true)
    expect(button.getAttribute('data-stage')).toBe('workstation')
  })

  it('offers the workbench again from the full-screen stage', () => {
    const { button } = mount('ide')
    expect(button.textContent).toBe(zh['toggle.workbench'])
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.workbenchAction'])
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('data-stage')).toBe('ide')
  })

  it('swaps the seat between its two stages, one click each', () => {
    const { cycled, button } = mount('workstation')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(cycled).toHaveBeenCalledTimes(2)
  })

  it('advances one stage per click', () => {
    const { cycled, button } = mount('conversation')
    fireEvent.click(button)
    expect(cycled).toHaveBeenCalledTimes(1)
  })

  it('steps aside entirely on a server page, where the stages do not apply', () => {
    const props = {
      t: makeTranslate(zh),
      cyclePresentation: vi.fn(),
      useWorkstation: <S,>(select: (state: boolean) => S): S => select(true),
      useIde: <S,>(select: (state: boolean) => S): S => select(false),
      useServerMode: <S,>(select: (state: boolean) => S): S => select(true),
    } as unknown as WorkstationToggleProps
    const { container } = render(<WorkstationToggle {...props} />)
    expect(container.querySelector('[data-workstation-toggle]')).toBeNull()
  })
})
