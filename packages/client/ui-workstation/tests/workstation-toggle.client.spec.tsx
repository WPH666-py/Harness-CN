/**
 * The workstation toggle: what it says, whether it reports the mode, and that
 * one click is one gesture.
 *
 * The component reads the mode through the frame's standard `useWorkstation`
 * hook, so the spec supplies that hook as a plain selector over a fixed value —
 * the same shape the renderer's provideRoot contribution has.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { WorkstationToggle } from '../src/client/WorkstationToggle.tsx'
import type { WorkstationToggleProps } from '../src/client/WorkstationToggle.tsx'

/** Mount the toggle with the mode it should report and the gesture it should call. */
function mount(mode: boolean): { clicked: ReturnType<typeof vi.fn>; button: HTMLElement } {
  const clicked = vi.fn()
  const props = {
    t: makeTranslate(zh),
    toggleWorkstation: clicked,
    useWorkstation: <S,>(select: (state: boolean) => S): S => select(mode),
  } as unknown as WorkstationToggleProps
  const { getByRole } = render(<WorkstationToggle {...props} />)
  return { clicked, button: getByRole('button', { name: mode ? zh['toggle.disable'] : zh['toggle.enable'] }) }
}

afterEach(cleanup)

describe('WorkstationToggle', () => {
  it('shows the mode name as its visible label in both dictionaries', () => {
    const { button } = mount(false)
    expect(button.textContent).toBe(zh['toggle.mode'])
    expect(zh['toggle.mode']).toBe('IDE/工作站')
  })

  it('is named by the action the click performs and not pressed while the frame is not in workstation mode', () => {
    const { button } = mount(false)
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.enable'])
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe(zh['toggle.enable'])
  })

  it('reports the pressed state and offers the way back while workstation mode is on', () => {
    const { button } = mount(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe(zh['toggle.disable'])
    expect(button.getAttribute('title')).toBe(zh['toggle.disable'])
    expect(button.hasAttribute('data-active')).toBe(true)
  })

  it('calls the toggle once per click', () => {
    const { clicked, button } = mount(false)
    fireEvent.click(button)
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
