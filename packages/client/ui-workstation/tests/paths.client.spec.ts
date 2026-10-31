/**
 * The workstation's path arithmetic: joining a parent onto one entry, naming the
 * last segment, splitting a page into lines, and ordering a level the way the
 * tree draws it.
 *
 * These are the only functions in the package that are pure enough to pin
 * without a renderer, so they carry the edge cases the tree relies on: the root
 * joins without a separator, a trailing newline opens one last empty line, and
 * directories always precede files whatever their names sort to.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { baseName, childPath, linesOf, orderEntries } from '../src/client/paths.ts'

describe('childPath', () => {
  it('joins a root entry without a leading separator', () => {
    expect(childPath('', 'src')).toBe('src')
  })

  it('joins a nested entry with one separator', () => {
    expect(childPath('src/client', 'index.ts')).toBe('src/client/index.ts')
  })
})

describe('baseName', () => {
  it('returns the last segment of a nested path', () => {
    expect(baseName('src/client/index.ts')).toBe('index.ts')
  })

  it('returns a bare name unchanged', () => {
    expect(baseName('README.md')).toBe('README.md')
  })

  it('returns the empty string for the root', () => {
    expect(baseName('')).toBe('')
  })
})

describe('linesOf', () => {
  it('splits one page into its lines', () => {
    expect(linesOf('alpha\nbeta')).toEqual(['alpha', 'beta'])
  })

  it('opens one last empty line for a terminated file', () => {
    expect(linesOf('alpha\n')).toEqual(['alpha', ''])
  })

  it('returns one empty line for empty text', () => {
    expect(linesOf('')).toEqual([''])
  })
})

describe('orderEntries', () => {
  const entry = (name: string, type: WorkspaceDirectoryEntry['type']): WorkspaceDirectoryEntry =>
    type === 'file' ? { name, type, size: 1 } : { name, type }

  it('sorts directories before files', () => {
    const ordered = orderEntries([entry('a.ts', 'file'), entry('z-dir', 'directory')])
    expect(ordered.map(at => at.name)).toEqual(['z-dir', 'a.ts'])
  })

  it('sorts naturally, so file2 precedes file10', () => {
    const ordered = orderEntries([entry('file10.ts', 'file'), entry('file2.ts', 'file')])
    expect(ordered.map(at => at.name)).toEqual(['file2.ts', 'file10.ts'])
  })

  it('leaves the caller’s array untouched', () => {
    const entries = [entry('b.ts', 'file'), entry('a.ts', 'file')]
    orderEntries(entries)
    expect(entries.map(at => at.name)).toEqual(['b.ts', 'a.ts'])
  })
})
