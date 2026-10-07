// @vitest-environment jsdom
/** The header control: one gesture, and an accessible name that says what it is. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FilesToggleAction } from '../src/client/FilesToggleAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Props as the header seat hands them over: the namespace translator and the gesture. */
function props(toggleWorkspaceFiles: () => void) {
  return {
    toggleWorkspaceFiles,
    t: (key: keyof typeof en) => en[key],
  } as unknown as Parameters<typeof FilesToggleAction>[0]
}

describe('FilesToggleAction', () => {
  it('names the control for readers who cannot see the folder glyph', () => {
    render(<FilesToggleAction {...props(vi.fn())} />)
    const button = screen.getByRole('button', { name: en['toggle.label'] })
    expect(button.getAttribute('title')).toBe(en['toggle.label'])
  })

  it('performs the one gesture it was handed, and nothing else', () => {
    const toggleWorkspaceFiles = vi.fn()
    render(<FilesToggleAction {...props(toggleWorkspaceFiles)} />)
    fireEvent.click(screen.getByRole('button', { name: en['toggle.label'] }))
    expect(toggleWorkspaceFiles).toHaveBeenCalledOnce()
  })
})
