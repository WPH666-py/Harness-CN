/**
 * Migration: DSH session logs (`session.v3.jsonl.zstd`) into the monolith transcript format.
 *
 * The source is one zstd stream per append, concatenated into a single file, so a normal decompress
 * returns only the header frame. This reader splits on the frame magic and decodes each frame, which
 * is also why the whole file is read at once: a frame boundary can land anywhere.
 *
 * Mapping is deliberately lossy in one direction only — the monolith keeps the user and assistant
 * turns, the tool calls with their arguments, and the tool results. DSH's own bookkeeping events
 * (permission presets, sandbox mode, request headers, step boundaries) have no monolith equivalent
 * and are dropped, because the transcript the model reads does not need them.
 *
 *   node src/migrate.mjs [--from <dir>] [--to <dir>] [--dry-run] [--force]
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { parseArgs } from 'node:util'

/** zstd frame magic, little-endian bytes `28 B5 2F FD`. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a concatenated zstd file into its text.
 * @param bytes - raw file contents.
 * @returns the decoded UTF-8 text, or an empty string when no frame decodes.
 */
export function decodeFrames(bytes) {
  const starts = []
  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    if (bytes[index] === ZSTD_MAGIC[0] && bytes[index + 1] === ZSTD_MAGIC[1]
      && bytes[index + 2] === ZSTD_MAGIC[2] && bytes[index + 3] === ZSTD_MAGIC[3]) starts.push(index)
  }
  if (starts.length === 0) return ''
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const slice = bytes.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : bytes.length)
    try {
      parts.push(zstdDecompressSync(slice))
    } catch {
      // A truncated final frame is the normal result of a killed process; the frames before it are
      // still valid history, so a bad tail drops one frame instead of the session.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Extract the text of one DSH content block list.
 * @param blocks - content array from a DSH message.
 * @returns concatenated text, newline separated.
 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
}

/**
 * Convert one decoded DSH event log into a monolith transcript.
 * @param text - decoded JSONL text.
 * @returns header plus the records to write.
 */
export function convertSession(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A partially written line at the tail is expected; it carries no usable history.
    }
  }
  const header = events.find(event => event.type === 'session')?.data
    ?? events.find(event => event.type === 'session')
  if (header === undefined) throw new Error('no session header in this log')
  let title = '（迁移）未命名会话'
  let model = ''
  let effort = 'default'
  const records = []
  /** Assistant message the next tool call attaches to. */
  let current = null
  for (const event of events) {
    const data = event.data ?? event
    if (event.type === 'session/title') {
      const value = typeof data.title === 'string' ? data.title : ''
      if (value !== '') title = value
      continue
    }
    if (event.type === 'model/selection') {
      if (typeof data.model === 'string' && data.model !== '') model = data.model
      if (typeof data.reasoningEffort === 'string' && data.reasoningEffort !== '') effort = data.reasoningEffort
      continue
    }
    if (event.type === 'user/message') {
      const content = blocksToText(data.content ?? data.message?.content)
      if (content === '') continue
      records.push({ kind: 'message', message: { role: 'user', content } })
      current = null
      continue
    }
    if (event.type === 'assistant/message') {
      const content = blocksToText(data.message?.content ?? data.content)
      if (content === '' && (data.message?.tool_calls ?? []).length === 0) {
        current = null
        continue
      }
      const message = { role: 'assistant', content }
      records.push({ kind: 'message', message })
      current = message
      continue
    }
    if (event.type === 'tool/call') {
      if (current === null) {
        current = { role: 'assistant', content: '' }
        records.push({ kind: 'message', message: current })
      }
      current.tool_calls = current.tool_calls ?? []
      current.tool_calls.push({
        id: String(data.callId ?? `call_${String(data.seq ?? records.length)}`),
        type: 'function',
        function: { name: String(data.name ?? 'unknown'), arguments: String(data.arguments ?? '{}') },
      })
      continue
    }
    if (event.type === 'tool/result') {
      const result = data.message?.content?.[0]
      const callId = result?.toolCallId ?? data.callId ?? ''
      const content = blocksToText(result?.content ?? []) || String(result?.text ?? '')
      records.push({
        kind: 'tool',
        message: {
          role: 'tool',
          tool_call_id: String(callId),
          content: content === '' ? '(empty result)' : content.slice(0, 60_000),
        },
      })
      continue
    }
    // Everything else is DSH bookkeeping with no transcript meaning.
  }
  const createdAt = typeof header.createdAt === 'number' ? new Date(header.createdAt).toISOString() : new Date().toISOString()
  return {
    header: {
      id: String(header.id ?? `session-${basename(dirname(String(header.cwd ?? '')))}`),
      title,
      cwd: String(header.cwd ?? process.cwd()),
      createdAt,
      mode: 'ask',
      model,
      effort,
    },
    records,
  }
}

/**
 * Encode a monolith transcript as JSONL.
 * @param session - converted session.
 * @returns the file body.
 */
export function renderTranscript(session) {
  const lines = [JSON.stringify({ kind: 'header', ...session.header })]
  for (const record of session.records) lines.push(JSON.stringify(record))
  lines.push(JSON.stringify({ kind: 'migrated', at: new Date().toISOString(), source: 'dsh-session-v3' }))
  return `${lines.join('\n')}\n`
}

/**
 * Find every DSH session log under a directory.
 * @param root - sessions directory of a DSH home.
 * @returns absolute paths, sorted for stable output.
 */
export async function findDshSessions(root) {
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.name.endsWith('.zstd')) found.push(path)
    }
  }
  await walk(root, 0)
  return found.sort()
}

/**
 * Migrate one log file into the monolith store.
 * @param options - source file, destination sessions dir, and flags.
 * @returns a short outcome line.
 */
export async function migrateFile(options) {
  const session = convertSession(decodeFrames(await readFile(options.file)))
  // A log that only carries its header is a session somebody opened and never used; writing it would
  // add an empty conversation to the list with nothing to read.
  if (session.records.length === 0) return `skipped ${session.header.id} (no messages)`
  const target = join(options.to, `${session.header.id}.jsonl`)
  if (existsSync(target) && options.force !== true) return `skipped ${session.header.id} (already migrated)`
  if (options.dryRun === true) {
    return `would write ${session.header.id}: ${String(session.records.length)} records, title ${JSON.stringify(session.header.title)}`
  }
  await mkdir(options.to, { recursive: true })
  await writeFile(target, renderTranscript(session), 'utf8')
  return `wrote ${session.header.id}: ${String(session.records.length)} records`
}

/**
 * Build a concatenated-frame zstd file, used by tests and fixtures.
 * @param text - JSONL text to encode, one frame per line.
 * @returns the file bytes.
 */
export function encodeFrames(text) {
  return Buffer.concat(text.split('\n').filter(line => line !== '').map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

if (import.meta.main === true) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
    },
  })
  const from = resolve(values.from ?? process.env.MONO_MIGRATE_FROM ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.harness-cn', 'sessions'))
  const to = resolve(values.to ?? join(process.cwd(), 'data', 'sessions'))
  const files = await findDshSessions(from)
  console.log(`migrate: ${String(files.length)} source log(s) under ${from} → ${to}`)
  for (const file of files) {
    try {
      console.log(`  ${await migrateFile({ file, to, force: values.force === true, dryRun: values['dry-run'] === true })}`)
    } catch (error) {
      console.log(`  failed ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
