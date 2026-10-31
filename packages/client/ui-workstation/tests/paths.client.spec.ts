/**
 * The workstation's pure helpers: joining a parent onto one entry, naming the
 * last segment, deciding whether a path previews as an image, spelling a byte
 * count for the viewer header, and ordering a level the way the tree draws it.
 *
 * These are the only functions in the package that are pure enough to pin
 * without a renderer, so they carry the edge cases the tree and the tabs rely
 * on: the root joins without a separator, an image extension decides the media
 * type whatever its case, and directories always precede files whatever their
 * names sort to.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { baseName, childPath, formatBytes, imageMediaType, orderEntries } from '../src/client/paths.ts'

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

describe('imageMediaType', () => {
  it('recognises each extension the viewer previews', () => {
    expect(imageMediaType('pictures/shot.png')).toBe('image/png')
    expect(imageMediaType('avatar.jpeg')).toBe('image/jpeg')
    expect(imageMediaType('avatar.jpg')).toBe('image/jpeg')
    expect(imageMediaType('loop.gif')).toBe('image/gif')
    expect(imageMediaType('shot.webp')).toBe('image/webp')
    expect(imageMediaType('icon.bmp')).toBe('image/bmp')
    expect(imageMediaType('favicon.ico')).toBe('image/x-icon')
    expect(imageMediaType('photo.avif')).toBe('image/avif')
  })

  it('reads the extension case-insensitively', () => {
    expect(imageMediaType('SHOT.PNG')).toBe('image/png')
    expect(imageMediaType('Photo.JpEg')).toBe('image/jpeg')
  })

  it('answers null for text files, unknown extensions, and bare names', () => {
    expect(imageMediaType('src/index.ts')).toBeNull()
    expect(imageMediaType('src/.gitignore')).toBeNull()
    expect(imageMediaType('README')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('spells bytes below one kilobyte as a whole count', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(11)).toBe('11 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('spells kilobytes with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('spells megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB')
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
