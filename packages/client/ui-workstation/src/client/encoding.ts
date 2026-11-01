/**
 * What a file's bytes are, and which encoding turned them into text.
 *
 * The text read verb answers `workspace-file/not-text` for anything that is not
 * valid UTF-8, which covers both a file in a legacy Chinese encoding and a
 * payload that is not text at all. The byte read has no opinion, so this module
 * decides from the bytes: a byte order mark names the encoding outright,
 * otherwise strict UTF-8, then strict GB18030, then binary. The chain is
 * deliberately finite — a file it cannot decode is shown as binary rather than
 * as mojibake.
 *
 * Only UTF-8 writes back. The save verb takes a string and encodes it as UTF-8,
 * so saving a GB18030 or UTF-16 buffer would rewrite the file in a different
 * encoding; `isReadOnlyEncoding` is what the viewer turns into `readOnly`.
 */

/** One of the encodings the decode chain recognizes. */
export type FileEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'

/** What one file's bytes are. */
export type DecodedFile =
  | { readonly kind: 'text'; readonly text: string; readonly encoding: FileEncoding }
  | { readonly kind: 'binary' }

/** The byte order marks that announce an encoding, longest marker first. */
const BOMS: readonly { readonly bytes: readonly number[]; readonly encoding: FileEncoding }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

/**
 * The byte order mark a file opens with.
 * @param data - the file's bytes.
 * @returns the announced encoding and the marker's length, or `null` when none matches.
 */
function bomOf(data: Uint8Array): { readonly encoding: FileEncoding; readonly size: number } | null {
  for (const bom of BOMS) {
    if (data.length < bom.bytes.length) continue
    if (bom.bytes.every((byte, at) => data[at] === byte)) {
      return { encoding: bom.encoding, size: bom.bytes.length }
    }
  }
  return null
}

/**
 * Decode one run of bytes strictly.
 *
 * Strict decoding is the detector: a sequence the encoding does not define
 * throws instead of decoding to a replacement character, which is what tells
 * this chain to try the next encoding. A runtime without the encoding throws at
 * construction, and the chain treats that as "cannot decode" the same way.
 * @param data - the bytes to decode.
 * @param encoding - the encoding to decode them with.
 * @returns the decoded text, or `null` when this encoding does not fit.
 */
function decode(data: Uint8Array, encoding: FileEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data)
  } catch {
    return null
  }
}

/**
 * Decide what one file's bytes are and decode them when they are text.
 * @param data - the whole file, as the byte read returned it.
 * @returns the decoded text with its encoding, or a binary verdict.
 */
export function decodeFile(data: Uint8Array): DecodedFile {
  const bom = bomOf(data)
  if (bom !== null) {
    const decoded = decode(data.subarray(bom.size), bom.encoding)
    return decoded === null ? { kind: 'binary' } : { kind: 'text', text: decoded, encoding: bom.encoding }
  }
  // Without a BOM that announces UTF-16, a NUL byte is the one signal that the
  // payload is not text: every UTF-8 and GB18030 code point starts with a byte
  // that is not zero, so a zero here comes from a binary format instead.
  if (data.includes(0)) return { kind: 'binary' }
  const utf8 = decode(data, 'utf-8')
  if (utf8 !== null) return { kind: 'text', text: utf8, encoding: 'utf-8' }
  const gb18030 = decode(data, 'gb18030')
  if (gb18030 !== null) return { kind: 'text', text: gb18030, encoding: 'gb18030' }
  return { kind: 'binary' }
}

/**
 * Whether a tab in this encoding may be written back to the Host.
 * @param encoding - the encoding a read decoded.
 * @returns `false` only for UTF-8, the one encoding the save verb reproduces.
 */
export function isReadOnlyEncoding(encoding: FileEncoding): boolean {
  return encoding !== 'utf-8'
}
