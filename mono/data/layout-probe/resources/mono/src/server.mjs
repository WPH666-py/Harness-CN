/**
 * Monolith bridge: one process, zero npm dependencies, HTTP + SSE, no plugin graph.
 *
 * Routes:
 *   GET  /                          → the single-page UI
 *   GET  /api/health                → model availability
 *   GET  /api/models                → model catalog and strength labels
 *   GET  /api/sessions              → session list
 *   POST /api/sessions              → create a session
 *   GET  /api/sessions/:id          → header plus messages
 *   POST /api/sessions/:id/settings → mode, model, effort, title
 *   POST /api/sessions/:id/messages → SSE stream of one turn
 *   POST /api/approvals/:id         → allow or deny one waiting tool call
 *
 * Every tool call passes `policy.decide` before it runs. A call that needs a human suspends the turn,
 * emits an `approval` event, and resumes only when the route above answers — so no route can execute
 * a write or a command without that decision having been made.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configuredModel, complete, EFFORTS, MODELS, modelAvailable, resolveModel, streamCompletion } from './llm.mjs'
import { appendMessage, appendRecord, createSession, initStore, listSessions, readSession, updateSettings } from './sessions.mjs'
import { compactedHistory, estimateTokens, planCompaction, renderForSummary, SUMMARY_INSTRUCTION } from './compact.mjs'
import { acceptsMime, contentParts, initAttachments, MAX_ATTACHMENT_BYTES, MAX_IMAGES_PER_MESSAGE, readAttachment, saveAttachment } from './attachments.mjs'
import { decide, DEFAULT_MODE, MODES } from './policy.mjs'
import { runTool, TOOL_SCHEMAS } from './tools.mjs'

/** Port to listen on; 0 asks the OS for one. */
const PORT = Number(process.env.MONO_PORT ?? '7801')
/** Bind address: loopback only, matching the product's default posture. */
const HOST = process.env.MONO_HOST ?? '127.0.0.1'
/** Model turns one user message may consume before the loop gives up. */
const MAX_TURNS = 12
/** Bytes of request body accepted. */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** How long one approval may stay unanswered before it is denied. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
/** Token budget above which older history is folded into a summary. */
const CONTEXT_BUDGET = Number(process.env.MONO_CONTEXT_BUDGET ?? '60000')
/** Newest messages kept verbatim when folding. */
const KEEP_RECENT = Number(process.env.MONO_KEEP_RECENT ?? '12')

/** System prompt for this build. Kept short: it is sent on every turn. */
const SYSTEM_PROMPT = [
  'You are Harness-CN, a coding agent running on the user\'s machine.',
  'You can inspect and change files and run shell commands through the provided tools.',
  'Prefer doing the work over describing it. Keep replies short and concrete.',
  'Every path you pass to a tool is relative to the session working directory.',
].join(' ')

/** Tool calls waiting for a human: id → resolver plus its timeout. */
const pendingApprovals = new Map()

/**
 * Read one JSON request body.
 * @param request - incoming request.
 * @returns the parsed object, or an empty object when the body is empty.
 */
async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object')
  return value
}

/**
 * Send one JSON response.
 * @param response - response to write.
 * @param status - HTTP status.
 * @param value - body to serialize.
 */
function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Ask a human whether one tool call may run, and wait for the answer.
 * @param options - the call, why it needs a decision, and the SSE sink that announces it.
 * @returns `allow` or `deny`; an unanswered request is denied when the timeout fires.
 */
function requestApproval(options) {
  const id = `approval-${randomUUID()}`
  options.emit('approval', {
    id,
    name: options.name,
    arguments: options.arguments,
    reason: options.reason,
  })
  return new Promise((resolve) => {
    const settle = (decision) => {
      const entry = pendingApprovals.get(id)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      pendingApprovals.delete(id)
      resolve(decision)
    }
    const timer = setTimeout(() => { settle('deny') }, APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(id, { settle, timer })
    options.onCancel(() => { settle('deny') })
  })
}

/**
 * Expand a transcript message into the wire shape, rebuilding image parts from stored bytes.
 *
 * The transcript keeps attachment ids rather than base64, so this is the one place a stored session
 * becomes a request: an image is read here, encoded here, and never written back into the JSONL.
 * @param message - stored message, optionally carrying attachments.
 * @returns the message to send to the model.
 */
async function expandMessage(message) {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return message
  const text = typeof message.content === 'string' ? message.content : ''
  return { role: message.role, content: await contentParts(text, message.attachments) }
}

/**
 * Stream one user turn and the tool loop it triggers.
 *
 * Events are `delta` (assistant text), `tool` (a call about to run), `approval` (waiting on a human),
 * `tool_result`, `denied`, `usage`, `done`, `error`.
 * @param response - SSE response.
 * @param session - header of the session being advanced.
 * @param text - the user message.
 * @param attachments - stored attachment records to embed in this message.
 */
async function streamTurn(response, session, text, attachments = []) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const emit = (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const controller = new AbortController()
  const cancels = new Set()
  response.on('close', () => {
    controller.abort()
    for (const cancel of cancels) cancel()
  })
  try {
    const { messages, header } = await readSession(session.id)
    const mode = MODES.includes(header.mode) ? header.mode : DEFAULT_MODE
    const model = resolveModel(header.model)
    const userMessage = {
      role: 'user',
      content: text,
      ...(attachments.length === 0 ? {} : { attachments }),
    }
    await appendMessage(session.id, userMessage)
    const expanded = []
    for (const message of messages) expanded.push(await expandMessage(message))
    const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...expanded, await expandMessage(userMessage)]
    emit('mode', { mode, model: model.id, effort: header.effort ?? 'default' })
    // Compaction happens once per user message, before the first model call: a summary taken
    // mid-loop would describe a conversation whose tools are still running.
    let history = full
    const plan = planCompaction(full, { budgetTokens: CONTEXT_BUDGET, keepRecent: KEEP_RECENT })
    if (plan.needed) {
      const summary = await complete({
        model: model.id,
        signal: controller.signal,
        messages: [
          { role: 'system', content: SUMMARY_INSTRUCTION },
          { role: 'user', content: renderForSummary(plan.older) },
        ],
      })
      await appendRecord(session.id, {
        kind: 'summary',
        at: new Date().toISOString(),
        foldedMessages: plan.older.length,
        tokensBefore: plan.tokens,
        text: summary,
      })
      history = compactedHistory(plan.system, summary, plan.recent)
      emit('compacted', {
        foldedMessages: plan.older.length,
        tokensBefore: plan.tokens,
        tokensAfter: estimateTokens(history),
      })
    }
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      let assistantText = ''
      let toolCalls = []
      for await (const event of streamCompletion({
        messages: history,
        tools: TOOL_SCHEMAS,
        model: model.id,
        effort: header.effort ?? 'default',
        signal: controller.signal,
      })) {
        if (event.type === 'text') {
          assistantText += event.text
          emit('delta', { text: event.text })
        } else if (event.type === 'tool_calls') toolCalls = event.calls
        else if (event.type === 'usage') emit('usage', event.usage)
      }
      const assistantMessage = {
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
      await appendMessage(session.id, assistantMessage)
      history.push(assistantMessage)
      if (toolCalls.length === 0) break
      for (const call of toolCalls) {
        let args = {}
        try {
          args = JSON.parse(call.function.arguments === '' ? '{}' : call.function.arguments)
        } catch {
          args = {}
        }
        const verdict = decide({ mode, name: call.function.name, args })
        emit('tool', { name: call.function.name, arguments: call.function.arguments, outcome: verdict.outcome })
        let result
        if (verdict.outcome === 'deny') {
          result = `refused by policy: ${verdict.reason}`
          emit('denied', { name: call.function.name, reason: verdict.reason })
        } else {
          let allowed = true
          if (verdict.outcome === 'ask') {
            allowed = await requestApproval({
              name: call.function.name,
              arguments: call.function.arguments,
              reason: verdict.reason,
              emit,
              onCancel: (handler) => { cancels.add(handler) },
            }) === 'allow'
          }
          await appendRecord(session.id, {
            kind: 'approval',
            at: new Date().toISOString(),
            name: call.function.name,
            decision: allowed ? 'allow' : 'deny',
            reason: verdict.reason,
          })
          result = allowed ? await runTool(call.function.name, args, header.cwd) : 'refused by the user'
          if (!allowed) emit('denied', { name: call.function.name, reason: '用户拒绝了这次调用' })
        }
        emit('tool_result', { name: call.function.name, result })
        const toolMessage = { role: 'tool', tool_call_id: call.id, content: result }
        await appendMessage(session.id, toolMessage)
        history.push(toolMessage)
      }
    }
    await appendRecord(session.id, { kind: 'turn-end', at: new Date().toISOString() })
    emit('done', {})
  } catch (error) {
    emit('error', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    response.end()
  }
}

/**
 * Route one request.
 * @param request - incoming request.
 * @param response - response to write.
 */
async function route(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    const body = await readFile(join(import.meta.dirname, '..', 'public', 'index.html'))
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
    return
  }
  if (request.method === 'GET' && path === '/api/health') {
    sendJson(response, 200, { model: configuredModel(), available: modelAvailable() })
    return
  }
  const attachmentMatch = /^\/api\/attachments\/([^/]+)$/u.exec(path)
  if (request.method === 'GET' && attachmentMatch !== null) {
    try {
      const stored = await readAttachment(decodeURIComponent(attachmentMatch[1]))
      response.writeHead(200, {
        'content-type': stored.mime,
        'content-length': String(stored.bytes.byteLength),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      response.end(stored.bytes)
    } catch {
      sendJson(response, 404, { error: 'unknown attachment' })
    }
    return
  }
  if (request.method === 'POST' && path === '/api/attachments') {
    const mime = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (!acceptsMime(mime)) {
      sendJson(response, 415, { error: `unsupported content type: ${mime}` })
      return
    }
    const chunks = []
    let total = 0
    for await (const chunk of request) {
      total += chunk.length
      if (total > MAX_ATTACHMENT_BYTES) {
        sendJson(response, 413, { error: `attachment is larger than ${String(MAX_ATTACHMENT_BYTES)} bytes` })
        return
      }
      chunks.push(chunk)
    }
    const name = String(request.headers['x-file-name'] ?? '').trim()
    const record = await saveAttachment({ bytes: Buffer.concat(chunks), mime, ...(name === '' ? {} : { name }) })
    sendJson(response, 201, record)
    return
  }
  if (request.method === 'GET' && path === '/api/models') {
    sendJson(response, 200, { models: MODELS, efforts: EFFORTS, modes: MODES })
    return
  }
  if (path === '/api/sessions') {
    if (request.method === 'GET') {
      sendJson(response, 200, await listSessions())
      return
    }
    if (request.method === 'POST') {
      const body = await readJson(request)
      const cwd = String(body.cwd ?? process.cwd())
      const session = await createSession({
        cwd,
        ...(body.title === undefined ? {} : { title: String(body.title) }),
        ...(body.mode === undefined ? {} : { mode: String(body.mode) }),
        ...(body.model === undefined ? {} : { model: String(body.model) }),
        ...(body.effort === undefined ? {} : { effort: String(body.effort) }),
      })
      sendJson(response, 201, session)
      return
    }
  }
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/u.exec(path)
  if (approvalMatch !== null && request.method === 'POST') {
    const body = await readJson(request)
    const entry = pendingApprovals.get(decodeURIComponent(approvalMatch[1]))
    if (entry === undefined) {
      sendJson(response, 404, { error: 'no such approval' })
      return
    }
    entry.settle(body.decision === 'allow' ? 'allow' : 'deny')
    sendJson(response, 200, { decision: body.decision === 'allow' ? 'allow' : 'deny' })
    return
  }
  const match = /^\/api\/sessions\/([^/]+)(\/messages|\/settings)?$/u.exec(path)
  if (match !== null) {
    const id = decodeURIComponent(match[1])
    if (match[2] === undefined && request.method === 'GET') {
      sendJson(response, 200, await readSession(id))
      return
    }
    if (match[2] === '/settings' && request.method === 'POST') {
      const body = await readJson(request)
      const patch = {}
      if (body.mode !== undefined) {
        if (!MODES.includes(String(body.mode))) {
          sendJson(response, 400, { error: `mode must be one of ${MODES.join(', ')}` })
          return
        }
        patch.mode = String(body.mode)
      }
      if (body.model !== undefined) patch.model = resolveModel(String(body.model)).id
      if (body.effort !== undefined) {
        if (!EFFORTS.includes(String(body.effort))) {
          sendJson(response, 400, { error: `effort must be one of ${EFFORTS.join(', ')}` })
          return
        }
        patch.effort = String(body.effort)
      }
      if (body.title !== undefined) patch.title = String(body.title)
      sendJson(response, 200, await updateSettings(id, patch))
      return
    }
    if (match[2] === '/messages' && request.method === 'POST') {
      const body = await readJson(request)
      const text = String(body.text ?? '').trim()
      const wanted = Array.isArray(body.attachments) ? body.attachments.map(String).slice(0, MAX_IMAGES_PER_MESSAGE) : []
      if (text === '' && wanted.length === 0) {
        sendJson(response, 400, { error: 'text or attachments are required' })
        return
      }
      const records = []
      try {
        for (const attachmentId of wanted) {
          const stored = await readAttachment(attachmentId)
          records.push({ id: attachmentId, name: attachmentId, mime: stored.mime, bytes: stored.bytes.byteLength })
        }
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const { header } = await readSession(id)
      await streamTurn(response, header, text, records)
      return
    }
  }
  sendJson(response, 404, { error: `no route for ${request.method ?? 'GET'} ${path}` })
}

await initStore()
await initAttachments()
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) {
      response.end()
      return
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  })
})
server.listen(PORT, HOST, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : PORT
  // The shell parses this line to learn where to point the window.
  console.log(`mono bridge listening on http://${HOST}:${String(port)} model=${configuredModel()} available=${String(modelAvailable())}`)
})
