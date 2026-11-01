/**
 * The line arithmetic behind the gutter and the caret band: how many lines a
 * buffer draws, what numbers it labels them with, and which one holds an offset.
 */
import { describe, expect, it } from 'vitest'
import { lineCount, lineIndexAt, lineNumberDigits, lineNumbers } from '../src/client/editor.ts'

describe('lineCount', () => {
  it('counts one line for an empty buffer', () => {
    expect(lineCount('')).toBe(1)
  })

  it('counts the lines a buffer breaks into', () => {
    expect(lineCount('alpha\nbeta')).toBe(2)
  })

  it('counts the empty line after a trailing newline', () => {
    expect(lineCount('alpha\n')).toBe(2)
  })

  it('counts blank lines of their own', () => {
    expect(lineCount('\n\n')).toBe(3)
  })
})

describe('lineNumbers', () => {
  it('numbers from one, one line per row', () => {
    expect(lineNumbers(3)).toBe('1\n2\n3')
  })

  it('numbers the single line of a one-line file', () => {
    expect(lineNumbers(1)).toBe('1')
  })
})

describe('lineNumberDigits', () => {
  it('sizes the gutter to the largest number it draws', () => {
    expect(lineNumberDigits(1)).toBe(1)
    expect(lineNumberDigits(9)).toBe(1)
    expect(lineNumberDigits(10)).toBe(2)
  })

  it('keeps one digit for a count that never occurs', () => {
    expect(lineNumberDigits(0)).toBe(1)
  })
})

describe('lineIndexAt', () => {
  it('places an offset on its line', () => {
    expect(lineIndexAt('alpha\nbeta', 0)).toBe(0)
    expect(lineIndexAt('alpha\nbeta', 8)).toBe(1)
  })

  it('places an offset right after a newline on the next line', () => {
    expect(lineIndexAt('alpha\nbeta', 6)).toBe(1)
  })

  it('places the end of the buffer on its last line', () => {
    expect(lineIndexAt('alpha\nbeta', 10)).toBe(1)
  })

  it('clamps an offset outside the buffer', () => {
    expect(lineIndexAt('alpha\nbeta', 200)).toBe(1)
    expect(lineIndexAt('alpha\nbeta', -5)).toBe(0)
  })
})
