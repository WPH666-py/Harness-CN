/**
 * Session store: one JSONL file per conversation under `data/sessions/`.
 *
 * One append-only file per session keeps the format inspectable with any text editor and makes a
 * crashed turn recoverable: a half-written line is dropped at read time instead of failing the load.
 * The shape is intentionally the plain `{ role, content, … }` message the model consumes, so a
 * session can be replayed without a projection layer.
 */

import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Directory holding one JSONL file per session. */
const ROOT = join(process.env.MONO_DATA ?? join(process.cwd(), 'data'), 'sessions')

/** Ensure the store exists before the first write. */
export async function initStore() {
  await mkdir(ROOT, { recursive: true })
}

/**
 * Create one session record.
 * @param options - working directory and an optional title.
 * @returns the created session header.
 */
export async function createSession(options) {
  const id = `session-${randomUUID()}`
  const header = {
    id,
    title: options.title ?? '新会话',
    cwd: options.cwd,
    createdAt: new Date().toISOString(),
    mode: options.mode ?? 'ask',
    model: options.model ?? '',
    effort: options.effort ?? 'default',
  }
  await appendFile(join(ROOT, `${id}.jsonl`), `${JSON.stringify({ kind: 'header', ...header })}\n`, 'utf8')
  return header
}

/**
 * Apply one persisted settings record onto a header.
 * @param header - header object to update in place.
 * @param record - settings record.
 */
function applySettings(header, record) {
  if (record.mode !== undefined) header.mode = record.mode
  if (record.model !== undefined) header.model = record.model
  if (record.effort !== undefined) header.effort = record.effort
  if (record.title !== undefined) header.title = record.title
}

/**
 * Append a settings change and return the merged header.
 * @param id - session id.
 * @param patch - mode, model, effort, or title to change.
 * @returns the header after the change.
 */
export async function updateSettings(id, patch) {
  const { header } = await readSession(id)
  const next = { ...header }
  applySettings(next, patch)
  await appendRecord(id, { kind: 'settings', at: new Date().toISOString(), ...patch })
  return next
}

/**
 * List every session, newest first.
 * @returns session headers with their message counts.
 */
export async function listSessions() {
  const files = (await readdir(ROOT).catch(() => [])).filter(name => name.endsWith('.jsonl'))
  const rows = []
  for (const file of files) {
    const lines = (await readFile(join(ROOT, file), 'utf8')).split('\n').filter(line => line !== '')
    let header = { id: file.slice(0, -6), title: '新会话', cwd: '', createdAt: '', mode: 'ask', model: '', effort: 'default' }
    let count = 0
    for (const line of lines) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.kind === 'header') {
        header = record
        continue
      }
      if (record.kind === 'settings') {
        applySettings(header, record)
        continue
      }
      count += 1
    }
    rows.push({ ...header, messages: count })
  }
  return rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

/**
 * Read one session's full message history.
 * @param id - session id.
 * @returns header plus the model-facing message list.
 */
export async function readSession(id) {
  const path = join(ROOT, `${id}.jsonl`)
  const lines = (await readFile(path, 'utf8')).split('\n').filter(line => line !== '')
  let header
  const messages = []
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind === 'header') {
      header = record
      continue
    }
    if (record.kind === 'settings') {
      header = header ?? {}
      applySettings(header, record)
      continue
    }
    if (record.kind === 'message') messages.push(record.message)
    if (record.kind === 'tool') messages.push(record.message)
  }
  if (header === undefined) throw new Error(`unknown session: ${id}`)
  return { header, messages }
}

/**
 * Append one record to a session.
 * @param id - session id.
 * @param record - record to append; `kind` selects its meaning.
 */
export async function appendRecord(id, record) {
  await appendFile(join(ROOT, `${id}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Append one model-facing message.
 * @param id - session id.
 * @param message - chat message in the wire shape.
 */
export async function appendMessage(id, message) {
  await appendRecord(id, { kind: message.role === 'tool' ? 'tool' : 'message', message })
}
