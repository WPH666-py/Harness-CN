/**
 * Context compaction.
 *
 * A long session eventually exceeds the window. The policy here is: keep the newest turns verbatim,
 * replace everything older with one summary, and never touch the transcript on disk — the JSONL is
 * the record, compaction only changes what is sent to the model on this request.
 *
 * `planCompaction` is pure so the split can be tested without a model; `summarize` is the only part
 * that talks to a provider.
 */

/** Rough token estimate: these conversations are mixed Chinese and code, so divide by three. */
const CHARS_PER_TOKEN = 3

/** Newest messages always sent verbatim, on top of any summary. */
export const DEFAULT_KEEP_RECENT = 12

/**
 * Estimate the token footprint of a message list.
 * @param messages - chat messages in the wire shape.
 * @returns approximate token count.
 */
export function estimateTokens(messages) {
  let chars = 0
  for (const message of messages) {
    chars += typeof message.content === 'string' ? message.content.length : 0
    if (Array.isArray(message.content)) {
      for (const part of message.content) chars += part.type === 'text' ? String(part.text ?? '').length : 0
    }
    for (const call of message.tool_calls ?? []) chars += (call.function?.arguments ?? '').length
    // An image costs roughly a thousand tokens regardless of its byte size.
    chars += (message.attachments?.length ?? 0) * 3_000
    chars += 12
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Decide whether a request history needs compaction, and split it if so.
 *
 * System messages are never summarized: they carry the instructions the summary must remain
 * subordinate to. The newest `keepRecent` non-system messages are preserved verbatim, including the
 * user message that just arrived.
 * @param messages - full history, system messages included.
 * @param options - token budget and how many recent messages to preserve.
 * @returns whether compaction is needed, plus the two slices when it is.
 */
export function planCompaction(messages, options = {}) {
  const budget = options.budgetTokens ?? 60_000
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT
  const system = messages.filter(message => message.role === 'system')
  const body = messages.filter(message => message.role !== 'system')
  if (estimateTokens(messages) <= budget) return { needed: false, system, older: [], recent: body, tokens: estimateTokens(messages) }
  const cut = Math.max(0, body.length - keepRecent)
  const older = body.slice(0, cut)
  const recent = body.slice(cut)
  // One exchange is the smallest thing a summary can describe; below that there is nothing to fold.
  if (older.length === 0) return { needed: false, system, older: [], recent: body, tokens: estimateTokens(messages) }
  return { needed: true, system, older, recent, tokens: estimateTokens(messages) }
}

/**
 * Render the portion being folded into text the summarizer reads.
 * @param messages - messages to summarize.
 * @returns a plain-text transcript, bounded so the summarizer request itself cannot blow the window.
 */
export function renderForSummary(messages) {
  const lines = []
  for (const message of messages) {
    if (message.role === 'tool') {
      lines.push(`[tool result] ${String(message.content).slice(0, 600)}`)
      continue
    }
    const calls = (message.tool_calls ?? []).map(call => ` -> ${call.function?.name}(${call.function?.arguments})`).join('')
    lines.push(`[${message.role}] ${typeof message.content === 'string' ? message.content : ''}${calls}`)
  }
  const text = lines.join('\n')
  return text.length > 120_000 ? text.slice(0, 120_000) : text
}

/** Instruction given to the summarizer. */
export const SUMMARY_INSTRUCTION = [
  'Summarize the conversation excerpt below for another assistant that will continue the work.',
  'Keep: what the user asked for, decisions made, files created or changed (with paths), commands run',
  'and their outcome, and anything still unfinished. Drop pleasantries and repeated reasoning.',
  'Write at most 200 words, in the language the user used, as plain prose with no preamble.',
].join(' ')

/**
 * Build the request history that replaces the folded portion.
 * @param system - system messages to keep first.
 * @param summary - summary text.
 * @param recent - messages to keep verbatim.
 * @returns the message list to send.
 */
export function compactedHistory(system, summary, recent) {
  const instructions = system.map(message => (typeof message.content === 'string' ? message.content : '')).join('\n')
  const header = `${instructions}\n\n Earlier conversation, summarized:\n${summary}`
  return [{ role: 'system', content: header }, ...recent]
}
