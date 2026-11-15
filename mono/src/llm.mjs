/**
 * Model transport: one streaming completion, OpenAI-compatible.
 *
 * Deliberately the only module that knows a provider exists. Switching to another OpenAI-shaped
 * endpoint is a base-URL change; a provider with a different wire format adds a branch here and
 * nothing else. `MONO_FAKE_MODEL=1` replaces the network with a scripted stream so the tool loop can
 * be exercised without spending tokens.
 */

/** Endpoint base; overridable so the same build targets DeepSeek or a compatible gateway. */
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/u, '')
/** Default model for this build. */
const DEFAULT_MODEL = process.env.MONO_MODEL ?? 'deepseek-chat'

/**
 * Models this build offers.
 *
 * Kept as data rather than a hardcoded switch: the picker, the health line, and the request all read
 * this one list, so adding a model is one entry. `efforts` names the strengths the provider accepts
 * for that model; `default` means the provider's own default.
 */
export const MODELS = [
  { id: 'deepseek-chat', label: 'DeepSeek V4 Chat', efforts: ['default'] },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', efforts: ['default', 'low', 'medium', 'high'] },
]

/** Strength labels the API accepts when a model supports them. */
export const EFFORTS = ['default', 'low', 'medium', 'high']

/**
 * Model name this process defaults to.
 * @returns the configured model identifier.
 */
export function configuredModel() {
  return DEFAULT_MODEL
}

/**
 * Resolve a session's model choice against the catalog.
 * @param requested - model id the session asked for, possibly empty or stale.
 * @returns a model present in the catalog.
 */
export function resolveModel(requested) {
  const found = MODELS.find(entry => entry.id === requested)
  return found ?? MODELS.find(entry => entry.id === DEFAULT_MODEL) ?? MODELS[0]
}

/**
 * Report whether the process can talk to a model at all.
 * @returns true when a key or fake mode is present.
 */
export function modelAvailable() {
  return process.env.MONO_FAKE_MODEL === '1' || (process.env.DEEPSEEK_API_KEY ?? '') !== ''
}

/**
 * Scripted stream used by `MONO_FAKE_MODEL=1`.
 *
 * Its two shapes mirror what the real loop must handle: one turn that calls a tool, then one turn
 * that answers in text once a tool result is present.
 * @param messages - the conversation so far.
 * @returns an async generator of the same events the network path yields.
 */
async function* fakeStream(messages) {
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    yield { type: 'text', text: '（模拟）工具已返回，循环正常。' }
    yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 8 } }
    return
  }
  const prompt = messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
  // The scripted turn mirrors the two effects the permission gate distinguishes: reading, and a
  // write that must pass the gate before it runs.
  if (String(prompt).includes('写')) {
    yield { type: 'text', text: '（模拟）写一个文件。' }
    yield {
      type: 'tool_calls',
      calls: [{
        id: `call_${String(Date.now())}`,
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'mono-write-probe.txt', content: 'probe\n' }) },
      }],
    }
  } else {
    yield { type: 'text', text: '（模拟）先看一下目录。' }
    yield {
      type: 'tool_calls',
      calls: [{
        id: `call_${String(Date.now())}`,
        type: 'function',
        function: { name: 'list_dir', arguments: JSON.stringify({ path: '' }) },
      }],
    }
  }
  yield { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 14 } }
}

/**
 * Run one non-streaming completion, used by compaction.
 * @param options - messages, model, and an abort signal.
 * @returns the assistant text, trimmed.
 */
export async function complete(options) {
  if (process.env.MONO_FAKE_MODEL === '1') return '（模拟）历史摘要：用户查看了工作目录，并尝试写入一个探针文件。'
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}`,
    },
    body: JSON.stringify({ model: options.model ?? DEFAULT_MODEL, messages: options.messages, stream: false }),
    signal: options.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`summary request failed: HTTP ${String(response.status)} ${detail.slice(0, 300)}`)
  }
  const body = await response.json()
  return String(body.choices?.[0]?.message?.content ?? '').trim()
}

/**
 * Stream one assistant turn.
 *
 * Yields `text` deltas as they arrive, then either a single `tool_calls` event carrying every
 * complete call, or nothing more. Tool-call fragments arrive spread across chunks, so they
 * accumulate by `index` and are emitted only once the stream ends.
 * @param options - messages, tool schemas, model, and an abort signal.
 * @returns an async generator of `{ type }` events.
 */
export async function* streamCompletion(options) {
  const { messages, tools, signal } = options
  const model = options.model ?? DEFAULT_MODEL
  const effort = options.effort ?? 'default'
  if (process.env.MONO_FAKE_MODEL === '1') {
    yield* fakeStream(messages)
    return
  }
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      // Only sent when the session asked for something other than the provider default: a model
      // that does not accept the field would otherwise reject every request.
      ...(effort === 'default' ? {} : { reasoning_effort: effort }),
    }),
    signal,
  })
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new Error(`model request failed: HTTP ${String(response.status)} ${detail.slice(0, 400)}`)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  /** Tool calls accumulate across chunks by their index. */
  const calls = new Map()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let frame
      try {
        frame = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = frame.choices?.[0]
      const delta = choice?.delta ?? {}
      if (typeof delta.content === 'string' && delta.content !== '') {
        yield { type: 'text', text: delta.content }
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0
        const current = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (fragment.id !== undefined) current.id = fragment.id
        if (fragment.function?.name !== undefined) current.function.name += fragment.function.name
        if (fragment.function?.arguments !== undefined) current.function.arguments += fragment.function.arguments
        calls.set(index, current)
      }
      if (frame.usage !== undefined && frame.usage !== null) yield { type: 'usage', usage: frame.usage }
    }
  }
  if (calls.size > 0) {
    yield { type: 'tool_calls', calls: [...calls.entries()].sort((left, right) => left[0] - right[0]).map(entry => entry[1]) }
  }
}
