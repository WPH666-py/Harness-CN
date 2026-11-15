/**
 * Attachment storage: one file per upload, served back by id.
 *
 * Only image types are accepted in this stage, because that is the only attachment kind the model
 * face consumes. The bytes live on disk and the transcript stores an id, so a session file stays
 * small and an attachment can be re-read later; the model request rebuilds the data URL when it is
 * built, which keeps the stored transcript independent of how a provider wants images encoded.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Directory holding uploaded bytes. */
const ROOT = join(process.env.MONO_DATA ?? join(process.cwd(), 'data'), 'attachments')

/** Content types accepted, with the extension each is stored under. */
const ACCEPTED = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** Largest accepted upload. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Most images one message may carry. */
export const MAX_IMAGES_PER_MESSAGE = 4

/** Ensure the store exists before the first write. */
export async function initAttachments() {
  await mkdir(ROOT, { recursive: true })
}

/**
 * Report whether a content type is accepted.
 * @param mime - content type from the upload.
 * @returns true when this build can store and send it.
 */
export function acceptsMime(mime) {
  return ACCEPTED.has(String(mime).toLowerCase())
}

/**
 * Store one upload.
 * @param options - bytes, content type, and a display name.
 * @returns the attachment record the transcript references.
 */
export async function saveAttachment(options) {
  const mime = String(options.mime).toLowerCase()
  if (!ACCEPTED.has(mime)) throw new Error(`unsupported attachment type: ${mime}`)
  if (options.bytes.byteLength === 0) throw new Error('attachment is empty')
  if (options.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment is larger than ${String(MAX_ATTACHMENT_BYTES)} bytes`)
  }
  const id = `att-${randomUUID()}`
  const file = `${id}${ACCEPTED.get(mime)}`
  await writeFile(join(ROOT, file), options.bytes)
  return {
    id,
    name: options.name === undefined || options.name === '' ? file : String(options.name),
    mime,
    bytes: options.bytes.byteLength,
  }
}

/**
 * Read one stored attachment.
 * @param id - attachment id from the transcript.
 * @returns its bytes and mime type.
 */
export async function readAttachment(id) {
  for (const [mime, ext] of ACCEPTED) {
    try {
      const bytes = await readFile(join(ROOT, `${id}${ext}`))
      return { mime, bytes }
    } catch {
      continue
    }
  }
  throw new Error(`unknown attachment: ${id}`)
}

/**
 * Build the model-facing content parts for one user message.
 *
 * Text first, then one image part per attachment. The data URL is produced here rather than stored,
 * so a provider that wants a URL instead of base64 changes only this function.
 * @param text - user text, possibly empty when only images were sent.
 * @param records - attachment records to embed.
 * @returns array-of-parts content the chat API accepts.
 */
export async function contentParts(text, records) {
  const parts = []
  if (text !== '') parts.push({ type: 'text', text })
  for (const record of records.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    const { mime, bytes } = await readAttachment(record.id)
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } })
  }
  return parts
}

/**
 * Pick out the text of a message whose content may be a string or a part array.
 * @param content - message content.
 * @returns the concatenated text parts.
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

/** Extensions this build stores, for diagnostics. */
export const STORED_EXTENSIONS = [...ACCEPTED.values()]
export { extname }
