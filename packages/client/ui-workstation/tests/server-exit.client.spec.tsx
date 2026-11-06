/**
 * The server page's one header control: it appears only while a host is current,
 * it names the way back, and one click is one gesture.
 *
 * The component reads which machine the seat shows through the frame's standard
 * `useServerMode` hook, so the spec supplies it as a plain selector over a fixed
 * value — the same shape the renderer's provideRoot contribution has.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { ServerExitButton } from '../src/client/ServerExitButton.tsx'
import type { ServerExitButtonProps } from '../src/client/ServerExitButton.tsx'

/** Mount the exit control as a frame that is (or is not) showing a server. */
function mount(onServer: boolean): { left: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const left = vi.fn()
  const props = {
    t: makeTranslate(zh),
    leaveServer: left,
    useServerMode: <S,>(select: (state: boolean) => S): S => select(onServer),
  } as unknown as ServerExitButtonProps
  const { container } = render(<ServerExitButton {...props} />)
  return { left, container }
}

afterEach(cleanup)

describe('ServerExitButton', () => {
  it('is absent while the seat shows this machine', () => {
    const { container } = mount(false)
    expect(container.querySelector('[data-server-exit]')).toBeNull()
  })

  it('names the way back on a server page', () => {
    const { container } = mount(true)
    const button = container.querySelector('[data-server-exit]')
    expect(button?.textContent).toBe('退出服务器页面')
    expect(button?.getAttribute('aria-label')).toBe(zh['server.leave'])
  })

  it('leaves in one click', () => {
    const { left, container } = mount(true)
    const button = container.querySelector('[data-server-exit]')
    if (button === null) throw new Error('the exit control is missing on a server page')
    fireEvent.click(button)
    expect(left).toHaveBeenCalledTimes(1)
  })
})
