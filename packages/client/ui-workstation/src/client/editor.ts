/**
 * Line arithmetic for the editor's gutter and its caret band.
 *
 * A line here is a run between `\n` characters, because the editor shows a file
 * as plain text with no wrapping: one drawn line is one buffered line, so the
 * count and the caret's line index can be derived from the buffer alone. The
 * text after a trailing newline is a line of its own — a file that ends with one
 * still shows an empty last line, and the caret can sit on it.
 */

/**
 * How many lines the gutter numbers.
 * @param text - the whole buffer.
 * @returns the line count, at least one.
 */
export function lineCount(text: string): number {
  let count = 1
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1
  return count
}

/**
 * The gutter's numbers, one per line, as a single pre-formatted block.
 *
 * One text node rather than one element per line keeps a large file's gutter out
 * of the reconciler; the stylesheet's `white-space: pre` draws the newlines.
 * @param count - the number of lines to number.
 * @returns the numbers joined by newlines, starting at 1.
 */
export function lineNumbers(count: number): string {
  const numbers: string[] = []
  for (let line = 1; line <= count; line += 1) numbers.push(String(line))
  return numbers.join('\n')
}

/**
 * The width the gutter needs, in digits.
 * @param count - the number of lines to number.
 * @returns the decimal digit count of the largest number.
 */
export function lineNumberDigits(count: number): number {
  return String(Math.max(1, count)).length
}

/**
 * The zero-based line the caret sits on.
 * @param text - the whole buffer.
 * @param caret - the textarea's selection start, clamped to the buffer.
 * @returns the index of the line holding that offset.
 */
export function lineIndexAt(text: string, caret: number): number {
  const stop = Math.max(0, Math.min(caret, text.length))
  let index = 0
  for (let at = text.indexOf('\n'); at >= 0 && at < stop; at = text.indexOf('\n', at + 1)) index += 1
  return index
}
