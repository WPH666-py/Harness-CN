/**
 * Path arithmetic for the workstation tree, and the two file-shape helpers the
 * tabs need: whether a path previews as an image, and how large a preview is.
 *
 * Every path here is the absolute path the listing endpoint was asked with:
 * the tree starts at the Session's working directory, and children are joined
 * with `/` on every platform because the Host resolves mixed separators, so the
 * joined string is both the key the store files a level under and the path the
 * next listing takes.
 */
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'

/**
 * Join one entry name onto an absolute directory path.
 * @param parent - directory path to join onto.
 * @param name - the entry's basename.
 * @returns the entry's path.
 */
export function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/**
 * The last segment of a path.
 * @param path - the path to shorten.
 * @returns its basename, `''` for the root.
 */
export function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** Image media type by lowercase extension; anything absent here is edited as text. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * The media type a path previews as, or `null` when it opens as text.
 *
 * Only the extension decides: the read verb reports a non-text file by failing,
 * and a text file with an image extension is rare enough that its preview
 * failing (and saying so) is the better trade than sniffing every byte.
 * @param path - absolute file path.
 * @returns the blob's media type, or `null` for a text tab.
 */
export function imageMediaType(path: string): string | null {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * A byte count as the viewer header shows it.
 *
 * Binary units, one decimal below a megabyte: the header has one short line and
 * the exact count is not what the reader weighs a preview by.
 * @param bytes - the file's size in bytes.
 * @returns the size, unit-suffixed.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then files and
 * everything else, each group by natural name.
 * @param entries - the listing's entries.
 * @returns a sorted copy.
 */
export function orderEntries(
  entries: readonly WorkspaceDirectoryEntry[],
): readonly WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const leftDir = left.type === 'directory'
    const rightDir = right.type === 'directory'
    if (leftDir !== rightDir) return leftDir ? -1 : 1
    return byName.compare(left.name, right.name)
  })
}
