/**
 * Smoke test for the monolith: boot time, payload size, and one full turn with a tool call.
 *
 * Runs against `MONO_FAKE_MODEL=1`, so it exercises the real HTTP surface, the real session store,
 * and the real tool executor without calling a model. Exit code 0 means every assertion held.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as pure from '../src/compact.mjs'
import * as migrate from '../src/migrate.mjs'

/**
 * Report whether a path exists, without throwing.
 * @param path - absolute path to test.
 * @returns true when the path exists.
 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.MONO_TEST_PORT ?? '7812')
const BASE = `http://127.0.0.1:${String(PORT)}`

/** Boot the bridge and resolve once it prints its listening line. */
function boot(extraEnv = {}) {
  const started = Date.now()
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MONO_FAKE_MODEL: '1', MONO_PORT: String(PORT), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolvePromise, rejectPromise) => {
    let output = ''
    const timer = setTimeout(() => rejectPromise(new Error(`bridge did not listen within 15 s:\n${output}`)), 15_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('mono bridge listening')) {
        clearTimeout(timer)
        resolvePromise({ child, bootMs: Date.now() - started })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('exit', (code) => rejectPromise(new Error(`bridge exited with ${String(code)}:\n${output}`)))
  })
}

/** Read one SSE response into a list of `{ event, data }` frames. */
async function readSse(response) {
  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split >= 0) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      split = buffer.indexOf('\n\n')
      const event = /^event: (.+)$/mu.exec(block)?.[1]
      const raw = /^data: (.+)$/mu.exec(block)?.[1]
      if (event !== undefined && raw !== undefined) frames.push({ event, data: JSON.parse(raw) })
    }
  }
  return frames
}

const checks = []
const assert = (label, condition, detail = '') => {
  checks.push({ label, ok: condition, detail })
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}\n`)
}

const { child, bootMs } = await boot()
try {
  const page = await fetch(`${BASE}/`)
  const html = await page.text()
  assert('GET / serves the UI', page.status === 200 && html.includes('Harness-CN'))
  assert('payload is one small document', html.length < 20_000, `${String(html.length)} bytes`)
  assert('boot to listening under 2 s', bootMs < 2000, `${String(bootMs)} ms`)

  const health = await (await fetch(`${BASE}/api/health`)).json()
  assert('health reports a model', typeof health.model === 'string' && health.available === true, JSON.stringify(health))

  const created = await (await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: ROOT, title: 'smoke' }),
  })).json()
  assert('session created', typeof created.id === 'string' && created.id.startsWith('session-'), created.id)

  const turn = await fetch(`${BASE}/api/sessions/${encodeURIComponent(created.id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '看一下目录' }),
  })
  assert('turn responds as SSE', turn.headers.get('content-type')?.includes('text/event-stream') === true)
  const frames = await readSse(turn)
  const events = frames.map(frame => frame.event)
  assert('assistant text streamed', events.includes('delta'))
  assert('tool call announced', events.includes('tool'))
  assert('tool executed', events.includes('tool_result'))
  const toolResult = frames.find(frame => frame.event === 'tool_result')
  assert('list_dir returned real entries', String(toolResult?.data.result ?? '').includes('src'), String(toolResult?.data.result ?? '').slice(0, 60))
  assert('turn completed', events.includes('done'))

  const stored = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(created.id)}`)).json()
  assert('history persisted', stored.messages.length >= 4, `${String(stored.messages.length)} messages`)

  const list = await (await fetch(`${BASE}/api/sessions`)).json()
  assert('session appears in the list', list.some(row => row.id === created.id))

  // --- step 1: permission gate -----------------------------------------------------------------
  const catalog = await (await fetch(`${BASE}/api/models`)).json()
  assert('catalog lists modes and models', catalog.modes.includes('read-only') && catalog.models.length >= 1)

  // A write in `ask` mode must suspend the turn and wait for a decision.
  const askSession = await (await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: ROOT, title: 'ask', mode: 'ask' }),
  })).json()
  assert('new session defaults to ask', askSession.mode === 'ask')

  const pendingTurn = fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '写一个探针文件' }),
  })
  const askFrames = []
  const askResponse = await pendingTurn
  const reader = askResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let approvalId
  while (approvalId === undefined) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split >= 0) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      split = buffer.indexOf('\n\n')
      const event = /^event: (.+)$/mu.exec(block)?.[1]
      const raw = /^data: (.+)$/mu.exec(block)?.[1]
      if (event === undefined || raw === undefined) continue
      const data = JSON.parse(raw)
      askFrames.push({ event, data })
      if (event === 'approval') approvalId = data.id
    }
  }
  assert('write in ask mode raises an approval', typeof approvalId === 'string', String(approvalId).slice(0, 22))
  const decision = await fetch(`${BASE}/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'deny' }),
  })
  assert('approval accepted', decision.status === 200)
  // Keep parsing to the end of the same stream: the denial and the completion arrive after the answer.
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split >= 0) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      split = buffer.indexOf('\n\n')
      const event = /^event: (.+)$/mu.exec(block)?.[1]
      const raw = /^data: (.+)$/mu.exec(block)?.[1]
      if (event !== undefined && raw !== undefined) askFrames.push({ event, data: JSON.parse(raw) })
    }
  }
  const deniedFrame = askFrames.find(frame => frame.event === 'denied')
  assert('denied call is reported', deniedFrame !== undefined, deniedFrame?.data.reason ?? 'no denied frame')
  assert('turn finished after the denial', askFrames.some(frame => frame.event === 'done'))
  const probePath = join(ROOT, 'mono-write-probe.txt')
  const probeExists = await exists(probePath)
  assert('denied write did not touch disk', probeExists === false)

  // The same call under read-only is refused without ever asking.
  await fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'read-only' }),
  })
  const roResponse = await fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '写一个探针文件' }),
  })
  const roFrames = await readSse(roResponse)
  assert('read-only denies without asking', roFrames.some(frame => frame.event === 'denied') && !roFrames.some(frame => frame.event === 'approval'))
  assert('read-only left no file', (await exists(probePath)) === false)

  // --- step 2: model and effort are session-scoped ---------------------------------------------
  const patched = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-reasoner', effort: 'high' }),
  })).json()
  assert('model and effort persist', patched.model === 'deepseek-reasoner' && patched.effort === 'high', `${patched.model}/${patched.effort}`)
  const reopened = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}`)).json()
  assert('settings survive a reload', reopened.header.model === 'deepseek-reasoner' && reopened.header.mode === 'read-only')
  const badModel = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(askSession.id)}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model' }),
  })).json()
  assert('unknown model falls back to a real one', badModel.model === 'deepseek-chat', badModel.model)

  // --- step 3: the UI carries the trajectory, approval, and selectors ---------------------------
  const ui = await (await fetch(`${BASE}/`)).text()
  assert('UI renders collapsible tool cards', ui.includes('details') && ui.includes("details.className = 'tool'"))
  assert('UI has an approval card', ui.includes('addApproval'))
  assert('UI exposes mode, model, and effort', ui.includes("id=\"mode\"") && ui.includes("id=\"model\"") && ui.includes("id=\"effort\""))
} finally {
  // `close`, not `exit`: the child's stdio handles must finish closing before this process tears
  // down, or libuv trips its async-close assertion on Windows.
  child.kill()
  await once(child, 'close').catch(() => undefined)
  child.stdout?.destroy()
  child.stderr?.destroy()
}

// --- step 4: context compaction ----------------------------------------------------------------
{
  const rows = [
    { role: 'system', content: 'rules' },
    ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(300) })),
  ]
  assert('token estimate is proportional', pure.estimateTokens(rows) > 1_000, String(pure.estimateTokens(rows)))
  const big = pure.planCompaction(rows, { budgetTokens: 500, keepRecent: 4 })
  assert('over budget folds the old part', big.needed === true && big.older.length === 16 && big.recent.length === 4, `${String(big.older.length)}/${String(big.recent.length)}`)
  assert('system prompt is never folded', big.system.length === 1 && big.system[0].content === 'rules')
  const small = pure.planCompaction(rows.slice(0, 4), { budgetTokens: 60_000 })
  assert('under budget leaves history alone', small.needed === false && small.recent.length === 3)
  const rebuilt = pure.compactedHistory(big.system, 'SUMMARY-TEXT', big.recent)
  assert('compacted history is one system plus the recent slice', rebuilt.length === 5 && rebuilt[0].content.includes('SUMMARY-TEXT'))
  assert('compaction shrinks the request', pure.estimateTokens(rebuilt) < big.tokens, `${String(pure.estimateTokens(rebuilt))} < ${String(big.tokens)}`)
}

// A server with a tiny budget must fold history on the second message and persist the summary.
{
  const tinyPort = PORT + 1
  const tinyBase = `http://127.0.0.1:${String(tinyPort)}`
  const tiny = await boot({ MONO_PORT: String(tinyPort), MONO_CONTEXT_BUDGET: '40', MONO_KEEP_RECENT: '2' })
  try {
    const session = await (await fetch(`${tinyBase}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ROOT, title: 'tiny', mode: 'auto' }),
    })).json()
    let compactedFrame
    for (const text of ['第一轮：看一下目录', '第二轮：再看一次目录']) {
      const response = await fetch(`${tinyBase}/api/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const frames = await readSse(response)
      compactedFrame = frames.find(frame => frame.event === 'compacted') ?? compactedFrame
    }
    assert('tiny budget triggers compaction', compactedFrame !== undefined, JSON.stringify(compactedFrame?.data ?? null))
    const record = await (await fetch(`${tinyBase}/api/sessions/${encodeURIComponent(session.id)}`)).json()
    const file = await readFile(join(ROOT, 'data', 'sessions', `${session.id}.jsonl`), 'utf8')
    assert('summary is persisted to the transcript', file.includes('"kind":"summary"'))
    assert('full history stays on disk', record.messages.length >= 4, `${String(record.messages.length)} messages`)
    assert('summary shrank the request', compactedFrame !== undefined && compactedFrame.data.tokensAfter < compactedFrame.data.tokensBefore)
  } finally {
    tiny.child.kill()
    await once(tiny.child, 'close').catch(() => undefined)
    tiny.child.stdout?.destroy()
    tiny.child.stderr?.destroy()
  }
}

// --- step 5: attachments and images -------------------------------------------------------------
// Runs on its own instance: the main one is already torn down above.
{
  const attPort = PORT + 2
  const attBase = `http://127.0.0.1:${String(attPort)}`
  const att = await boot({ MONO_PORT: String(attPort) })
  try {
    // A real 1x1 PNG, so the encoder and the reader both handle actual image bytes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const uploaded = await fetch(`${attBase}/api/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-file-name': 'dot.png' },
      body: png,
    })
    const record = await uploaded.json()
    assert('image uploads', uploaded.status === 201 && String(record.id).startsWith('att-'), JSON.stringify(record))
    const readBack = await fetch(`${attBase}/api/attachments/${encodeURIComponent(record.id)}`)
    const bytes = Buffer.from(await readBack.arrayBuffer())
    assert('image round-trips', readBack.headers.get('content-type') === 'image/png' && bytes.equals(png), `${String(bytes.length)} bytes`)
    const rejected = await fetch(`${attBase}/api/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not an image',
    })
    assert('non-image upload is refused', rejected.status === 415, String(rejected.status))
    const visionSession = await (await fetch(`${attBase}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ROOT, title: 'vision', mode: 'auto' }),
    })).json()
    const visionResponse = await fetch(`${attBase}/api/sessions/${encodeURIComponent(visionSession.id)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No text at all: an image-only message must be accepted.
      body: JSON.stringify({ text: '', attachments: [record.id] }),
    })
    const visionFrames = await readSse(visionResponse)
    assert('image-only message streams a turn', visionFrames.some(frame => frame.event === 'delta'))
    const visionStored = await (await fetch(`${attBase}/api/sessions/${encodeURIComponent(visionSession.id)}`)).json()
    const userRow = visionStored.messages.find(message => message.role === 'user')
    assert('transcript references the attachment', userRow?.attachments?.[0]?.id === record.id, JSON.stringify(userRow?.attachments ?? null))
    const raw = await readFile(join(ROOT, 'data', 'sessions', `${visionSession.id}.jsonl`), 'utf8')
    assert('image bytes never enter the transcript', !raw.includes('iVBORw0KGgo'), `${String(raw.length)} bytes on disk`)
    assert('UI offers an image picker', (await (await fetch(`${attBase}/`)).text()).includes('id="file"'))
  } finally {
    att.child.kill()
    await once(att.child, 'close').catch(() => undefined)
    att.child.stdout?.destroy()
    att.child.stderr?.destroy()
  }
}
// --- step 6: migration from DSH session logs ---------------------------------------------------
{
  // A synthetic source log: the converter must not depend on a machine's real history.
  const events = [
    { type: 'session', data: { id: 'session-1111', createdAt: 1_700_000_000_000, cwd: ROOT } },
    { type: 'session/title', data: { title: '迁移样例' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看目录' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，先列目录。' }] } } },
    { type: 'tool/call', data: { callId: 'call_a', name: 'glob', arguments: '{"pattern":"**/*"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'a.txt\nb.txt' }] }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '目录里有两个文件。' }] } } },
    { type: 'model/selection', data: { model: 'deepseek-reasoner', reasoningEffort: 'high' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  ]
  const fixtureRoot = join(ROOT, 'data', 'migrate-fixture')
  const sessionDir = join(fixtureRoot, 'hash-1', 'session-1111')
  await mkdir(sessionDir, { recursive: true })
  const encoded = migrate.encodeFrames(events.map(event => JSON.stringify(event)).join('\n'))
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), encoded)
  const decoded = migrate.decodeFrames(encoded)
  assert('multi-frame log decodes fully', decoded.split('\n').filter(Boolean).length === events.length, `${String(decoded.split('\n').filter(Boolean).length)}/${String(events.length)} lines`)

  const converted = migrate.convertSession(decoded)
  const roles = converted.records.map(record => record.message.role)
  assert('migration keeps the exchange', converted.records.length === 4, `${String(converted.records.length)} records`)
  assert('migration preserves order', roles.join(',') === 'user,assistant,tool,assistant', roles.join(','))
  const toolCall = converted.records[1].message.tool_calls?.[0]
  assert('tool call survives with its arguments', toolCall?.function?.name === 'glob' && toolCall.function.arguments.includes('**/*'))
  assert('tool result is linked to its call', converted.records[2].message.tool_call_id === 'call_a')
  assert('header carries title, cwd, model, effort', converted.header.title === '迁移样例' && converted.header.cwd === ROOT && converted.header.model === 'deepseek-reasoner' && converted.header.effort === 'high')
  assert('bookkeeping events are dropped', !JSON.stringify(converted.records).includes('workspace-write'))

  const outDir = join(ROOT, 'data', 'migrate-out')
  // Hermetic: the fixture and the destination are rebuilt every run.
  await rm(outDir, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), encoded)
  const found = await migrate.findDshSessions(fixtureRoot)
  assert('source discovery is recursive', found.length === 1, `${String(found.length)} file(s)`)
  const first = await migrate.migrateFile({ file: found[0], to: outDir })
  assert('migration writes a transcript', first.startsWith('wrote session-1111'), first)
  const second = await migrate.migrateFile({ file: found[0], to: outDir })
  assert('migration is idempotent', second.startsWith('skipped'), second)
  const written = await readFile(join(outDir, 'session-1111.jsonl'), 'utf8')
  const header = JSON.parse(written.split('\n')[0])
  assert('written header is mono shaped', header.kind === 'header' && header.id === 'session-1111' && header.mode === 'ask')
  assert('written transcript is replayable', written.includes('"role":"tool"') && written.includes('"tool_call_id":"call_a"'))
  const dry = await migrate.migrateFile({ file: found[0], to: join(ROOT, 'data', 'migrate-dry'), dryRun: true })
  assert('dry run writes nothing', dry.startsWith('would write') && !(await exists(join(ROOT, 'data', 'migrate-dry', 'session-1111.jsonl'))))
}

// --- step 7: the bridge runs from the packaged installation layout ------------------------------
// The shell finds the bridge at `<resources>/mono/src/server.mjs`; this reproduces that layout in a
// temp directory and boots it, so a packaging mistake fails here instead of in a window.
{
  const layoutRoot = join(ROOT, 'data', 'layout-probe')
  await rm(layoutRoot, { recursive: true, force: true })
  const bridgeDir = join(layoutRoot, 'resources', 'mono')
  await mkdir(join(bridgeDir, 'src'), { recursive: true })
  await mkdir(join(bridgeDir, 'public'), { recursive: true })
  for (const name of await readdir(join(ROOT, 'src'))) {
    if (name.endsWith('.mjs')) await copyFile(join(ROOT, 'src', name), join(bridgeDir, 'src', name))
  }
  await copyFile(join(ROOT, 'public', 'index.html'), join(bridgeDir, 'public', 'index.html'))
  assert('layout carries the bridge and the page', (await exists(join(bridgeDir, 'src', 'server.mjs'))) && (await exists(join(bridgeDir, 'public', 'index.html'))))
  const stagedPort = PORT + 3
  const staged = spawn(process.execPath, [join(bridgeDir, 'src', 'server.mjs')], {
    cwd: layoutRoot,
    env: { ...process.env, MONO_FAKE_MODEL: '1', MONO_PORT: String(stagedPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const deadline = Date.now() + 15_000
    let line = ''
    staged.stdout.setEncoding('utf8')
    staged.stdout.on('data', (chunk) => { line += chunk })
    while (!line.includes('mono bridge listening') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert('packaged layout boots', line.includes('mono bridge listening'), line.slice(0, 80))
    const health = await (await fetch(`http://127.0.0.1:${String(stagedPort)}/api/health`)).json()
    assert('packaged layout serves the API', health.available === true, JSON.stringify(health))
    const page = await (await fetch(`http://127.0.0.1:${String(stagedPort)}/`)).text()
    assert('packaged layout serves the page', page.includes('Harness-CN Mono'))
    // Its data lives beside the layout, not in the checkout: cwd decides where sessions are written.
    assert('packaged layout writes its own data', await exists(join(layoutRoot, 'data', 'sessions')))
  } finally {
    staged.kill()
    await once(staged, 'close').catch(() => undefined)
    staged.stdout?.destroy()
    staged.stderr?.destroy()
  }
}

const failed = checks.filter(check => !check.ok)
process.stdout.write(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`)
// Let the last sockets finish before exiting; an explicit exit here races undici's keep-alive pool.
process.exitCode = failed.length === 0 ? 0 : 1
setTimeout(() => { process.exit(process.exitCode ?? 0) }, 250).unref()
