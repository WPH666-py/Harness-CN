// @vitest-environment jsdom
/**
 * Filename-to-language selection and the React binding over the shared lazy
 * highlighter. The lazy-grammar behavior itself belongs to
 * `markdown/highlight.ts` and is covered by `read-block.client.spec.tsx`; here
 * the assertions are that the extension table reaches a grammar id, that the
 * hook re-renders its caller when a grammar arrives, and that it keeps the
 * highlighter identity stable across renders.
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CODE_HIGHLIGHT_EXTENSIONS, languageForPath, useCodeHighlighter } from '../src/index.ts'

afterEach(cleanup)

describe('languageForPath', () => {
  it('maps a suffix to the grammar id its language table entry names', () => {
    expect(languageForPath('src/main.ts')).toBe('typescript')
    expect(languageForPath('a.py')).toBe('python')
    expect(languageForPath('conf/app.yaml')).toBe('yaml')
    expect(languageForPath('infra/main.tf')).toBe('hcl')
    expect(languageForPath('run.ps1')).toBe('powershell')
  })

  it('is case insensitive and reads the final segment of either separator style', () => {
    expect(languageForPath('C:\\project\\source.CPP')).toBe('cpp')
    expect(languageForPath('/a/b/c/README.MD')).toBe('markdown')
    // The suffix is what follows the last dot of the final segment.
    expect(languageForPath('/project/archive.old/source.d.ts')).toBe('typescript')
  })

  it('treats a leading dot as the separator', () => {
    expect(languageForPath('.env')).toBe('dotenv')
  })

  it('returns undefined for an unknown, absent, or dotfile suffix', () => {
    expect(languageForPath('data.unknownext')).toBeUndefined()
    expect(languageForPath('/etc/hosts')).toBeUndefined()
    expect(languageForPath('.gitignore')).toBeUndefined()
    expect(languageForPath('trailingdot.')).toBeUndefined()
  })

  it('misses inherited Object.prototype keys instead of resolving them', () => {
    // The extension table is a Map for exactly this reason: `foo.constructor`
    // must not reach a prototype member and hand shiki a non-string language.
    expect(languageForPath('foo.constructor')).toBeUndefined()
    expect(languageForPath('foo.__proto__')).toBeUndefined()
    expect(languageForPath('foo.toString')).toBeUndefined()
    expect(languageForPath('foo.hasOwnProperty')).toBeUndefined()
  })
})

describe('CODE_HIGHLIGHT_EXTENSIONS', () => {
  it('lists every recognized suffix once, without duplicates', () => {
    expect(CODE_HIGHLIGHT_EXTENSIONS).toContain('ts')
    expect(CODE_HIGHLIGHT_EXTENSIONS).toContain('md')
    expect(new Set(CODE_HIGHLIGHT_EXTENSIONS).size).toBe(CODE_HIGHLIGHT_EXTENSIONS.length)
  })
})

/** Renders how many token runs the bound highlighter produced for one language. */
function Probe({ language, code }: { language: string | undefined; code: string }) {
  const highlight = useCodeHighlighter(language)
  const lines = highlight(code)
  return <span data-testid="runs">{lines === undefined ? 'plain' : String(lines.flat().length)}</span>
}

describe('useCodeHighlighter', () => {
  it('highlights through a boot grammar synchronously', () => {
    const view = render(<Probe language={languageForPath('a.ts')} code="const x = 1" />)
    expect(Number(view.getByTestId('runs').textContent)).toBeGreaterThan(1)
  })

  it('renders plain first and re-highlights after a lazy grammar arrives', async () => {
    // `rs` is outside the boot grammars, so the first render has no tokens while
    // the grammar imports; the hook's `useSyncExternalStore` subscription is what
    // re-renders the caller once it registers.
    const view = render(<Probe language={languageForPath('main.rs')} code="fn main() {}" />)
    expect(view.getByTestId('runs').textContent).toBe('plain')
    await vi.waitFor(() => {
      expect(Number(view.getByTestId('runs').textContent)).toBeGreaterThan(1)
    })
  })

  it('keeps the highlighter identity stable across renders of one language', () => {
    const seen: ((code: string) => unknown)[] = []

    function IdentityProbe() {
      const highlight = useCodeHighlighter('typescript')
      const previous = useRef<typeof highlight | null>(null)
      if (previous.current !== null && previous.current !== highlight) seen.push(highlight)
      previous.current = highlight
      return <span data-testid="runs">{String(highlight('const x = 1')?.length ?? -1)}</span>
    }

    const view = render(<IdentityProbe />)
    view.rerender(<IdentityProbe />)
    view.rerender(<IdentityProbe />)
    expect(seen).toEqual([])
  })

  it('returns undefined for a language the highlighter does not register', () => {
    const view = render(<Probe language="cobol" code="IDENTIFICATION DIVISION." />)
    expect(view.getByTestId('runs').textContent).toBe('plain')
  })
})
