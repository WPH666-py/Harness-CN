/**
 * Path arithmetic for the workstation tree.
 *
 * Every path here is workspace-relative — `''` is the workspace root, exactly
 * what the listing endpoint takes when a request names no directory — and
 * children are joined with `/` on every platform: the Host resolves mixed
 * separators, and `/` is what the tree uses as its key.
 */
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'

/**
 * Join one entry name onto a workspace-relative directory path.
 * @param parent - workspace-relative directory path, `''` for the root.
 * @param name - the entry's basename.
 * @returns the entry's workspace-relative path.
 */
export function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/**
 * The last segment of a workspace-relative path.
 * @param path - workspace-relative path.
 * @returns its basename, `''` for the root.
 */
export function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/**
 * Split one page of file text into the lines the viewer draws.
 *
 * The endpoint reports how many lines it returned; its `text` is that many
 * lines with `\n` between them, so a trailing separator opens one last empty
 * line, which is what an editor shows at the end of a terminated file.
 * @param text - the page's text.
 * @returns its lines, in order.
 */
export function linesOf(text: string): string[] {
  return text.split('\n')
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
