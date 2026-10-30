/**
 * One WebSocket that carries every desktop event stream.
 *
 * The browser allows six concurrent requests per origin. The workspace opens five event streams, so
 * three of the six were always spoken for and any page that needed two more requests could wait
 * forever — which is exactly how the settings pages and the log window came up blank. A WebSocket
 * does not count against that budget, so this module turns many logical streams into one socket.
 *
 * The socket lives here rather than in the Host because the shell reaches the Host over a
 * request/response pipe, which cannot carry an upgrade. Keeping the upgrade at the shell means the
 * browser side is one connection while the Host side keeps the plain POST streams it already serves.
 *
 * Protocol, JSON text frames:
 *   client → shell  {"t":"open","id":1,"endpoint":"…","payload":{…}}
 *                   {"t":"cancel","id":1}
 *   shell → client  {"t":"frame","id":1,"value":{…}}   one stream item
 *                   {"t":"end","id":1}                stream finished
 *                   {"t":"error","id":1,"message":"…"} stream failed
 */

import type { IncomingMessage, Server } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'

/** Path the page connects to. */
export const MUX_PATH = '/.dsh/stream-mux'

/** Where the per-stream diagnostics land; inside the installation so they survive a restart. */
const MUX_LOG = join(process.env.HARNESS_CN_INSTALL ?? 'D:/Harness/Harness-CN', 'data', 'desktop', 'mux.log')

/**
 * Path upstream 0.2.1's Gateway client connects to.
 *
 * 0.2.1 moved the logical-stream multiplexer onto the API origin and gave it its own message shape
 * (`type`/`streamId` instead of `t`/`id`), so the same session serves both dialects.
 */
export const REMOTE_MUX_PATH = '/api/remote.mux'

/** Every path that terminates a logical-stream multiplexer. */
const MUX_PATHS = new Set([MUX_PATH, REMOTE_MUX_PATH])

/** WebSocket frame opcodes this endpoint understands. */
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** Frames larger than this are refused rather than buffered. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/**
 * Encode one server-to-client frame.
 *
 * Server frames are never masked, and this implementation only emits whole frames (FIN set), which
 * is all the protocol above needs.
 * @param opcode - frame opcode.
 * @param payload - body bytes.
 * @returns the bytes to write.
 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.byteLength
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** One decoded client frame. */
interface Frame {
  readonly opcode: number
  readonly payload: Buffer
}

/**
 * Decode frames arriving on one socket.
 *
 * Client frames are always masked; fragmentation is assembled into one payload because the protocol
 * above never sends a partial message on purpose, and tolerating the split is cheaper than refusing
 * a client that batches writes differently.
 * @param socket - upgraded socket, already past the handshake.
 * @param onFrame - called once per complete frame.
 * @param onClose - called when the socket ends or the stream of bytes stops.
 */
function readFrames(socket: Socket, onFrame: (frame: Frame) => void, onClose: () => void): void {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let closed = false
  const finish = (): void => {
    if (closed) return
    closed = true
    onClose()
  }
  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer.readUInt8(0)
      const second = buffer.readUInt8(1)
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const wide = buffer.readBigUInt64BE(2)
        if (wide > BigInt(MAX_FRAME_BYTES)) {
          socket.destroy()
          finish()
          return
        }
        length = Number(wide)
        offset = 10
      }
      if (length > MAX_FRAME_BYTES) {
        socket.destroy()
        finish()
        return
      }
      const maskOffset = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index & 3), index)
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }
      buffer = buffer.subarray(offset + length)
      // Continuation frames are folded into the previous message by appending to its payload; this
      // layer only needs whole messages, and the client always sends one.
      onFrame({ opcode, payload })
    }
  })
  socket.on('end', finish)
  socket.on('close', finish)
  socket.on('error', finish)
}

/**
 * One connected page's multiplexer.
 *
 * Tracks streams by id so a cancelled or finished stream stops reading its upstream response, and a
 * closed socket cancels everything it started.
 */
class MuxSession {
  private readonly streams = new Map<number, AbortController>()
  /** Which wire shape each open stream is reported in: the shell's own, or upstream's Gateway one. */
  private readonly dialects = new Map<number, 'legacy' | 'gateway'>()
  /** Upstream's client-chosen stream id, kept so a `cancel`/`end` frame can find its local number. */
  private readonly gatewayIds = new Map<number, string>()
  private nextGatewayId = 0
  private uplinkDropped = 0
  private closed = false

  constructor(
    private readonly socket: Socket,
    private readonly openUpstream: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
    private readonly onClosed: () => void,
  ) {}

  /** Send one protocol frame. */
  private send(value: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value), 'utf8')))
  }

  /** Report one stream item in the dialect its opener speaks. */
  private frame(id: number, value: unknown): void {
    const streamId = this.gatewayIds.get(id)
    if (streamId === undefined) {
      this.send({ t: 'frame', id, value })
      return
    }
    this.send({ type: 'item', streamId, value })
  }

  /** Complete one stream in the dialect its opener speaks. */
  private finish(id: number): void {
    const streamId = this.gatewayIds.get(id)
    if (streamId === undefined) {
      this.send({ t: 'end', id })
      return
    }
    this.send({ type: 'end', streamId })
    this.gatewayIds.delete(id)
  }

  /** Fail one stream in the dialect its opener speaks. */
  private fail(id: number, message: string): void {
    const streamId = this.gatewayIds.get(id)
    if (streamId === undefined) {
      this.send({ t: 'error', id, message })
      return
    }
    this.send({ type: 'error', streamId, error: { code: 'stream-failed', message, details: {} } })
    this.gatewayIds.delete(id)
  }

  /** Start one logical stream and pump its items into the socket. */
  private start(id: number, endpoint: string, payload: unknown): void {
    const controller = new AbortController()
    this.streams.set(id, controller)
    // One line per stream, in and out: the client's boot only renders once the logical streams it
    // opened have answered, so "which stream never ends" is the question a hung page asks.
    const startedAt = Date.now()
    const dialect = this.dialects.get(id) ?? 'fork'
    let frames = 0
    const note = (outcome: string): void => {
      // The sidecar's stdout is the Rust handshake pipe, so console lines never reach harness.log;
      // a file is the only channel that survives it, and a hung boot needs reading after the fact.
      const line = `[mux] ${new Date().toISOString()} ${outcome} #${String(id)} ${dialect} `
        + `${endpoint === '' ? '(no endpoint)' : endpoint} frames=${String(frames)} `
        + `${String(Date.now() - startedAt)}ms\n`
      try {
        appendFileSync(MUX_LOG, line)
      } catch {
        /* diagnostics are best effort */
      }
    }
    note('open')
    void (async () => {
      try {
        const body = await this.openUpstream(endpoint, payload, controller.signal)
        if (body === null) {
          this.fail(id, 'no upstream body')
          note('failed: no upstream body')
          return
        }
        const reader = body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          let newline = pending.indexOf('\n')
          while (newline !== -1) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            newline = pending.indexOf('\n')
            if (line !== '') { frames += 1; this.frame(id, JSON.parse(line)) }
          }
        }
        const tail = pending.trim()
        if (tail !== '') { frames += 1; this.frame(id, JSON.parse(tail)) }
        this.finish(id)
        note('end')
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          this.fail(id, message)
          note(`failed: ${message}`)
        } else {
          note('cancelled')
        }
      } finally {
        this.streams.delete(id)
      }
    })()
  }

  /** Cancel one logical stream. */
  private cancel(id: number): void {
    const controller = this.streams.get(id)
    this.gatewayIds.delete(id)
    this.dialects.delete(id)
    if (controller === undefined) return
    this.streams.delete(id)
    controller.abort(new Error('client cancelled the stream'))
  }

  /** Handle one decoded client frame. */
  handle(frame: Frame): void {
    if (frame.opcode === OPCODE_CLOSE) {
      this.dispose()
      return
    }
    if (frame.opcode === OPCODE_PING) {
      if (!this.socket.destroyed) this.socket.write(encodeFrame(OPCODE_PONG, frame.payload))
      return
    }
    if (frame.opcode !== OPCODE_TEXT && frame.opcode !== OPCODE_BINARY) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>
    } catch {
      this.send({ t: 'error', id: 0, message: 'malformed frame' })
      return
    }
    if (typeof message.type === 'string') {
      this.handleGateway(message)
      return
    }
    if (message.t === 'open' && typeof message.id === 'number') {
      this.start(message.id, String(message.endpoint ?? ''), message.payload)
      return
    }
    if (message.t === 'cancel' && typeof message.id === 'number') this.cancel(message.id)
  }

  /**
   * Serve one message of upstream Gateway's mux dialect.
   *
   * 0.2.1 names streams with client strings and carries an uplink half (`item`) that this shell's
   * Host lane cannot reach, so uplink items are dropped here rather than silently half-forwarded: a
   * stream that needs them fails at the endpoint instead of hanging.
   * @param message - the decoded client message.
   */
  private handleGateway(message: Record<string, unknown>): void {
    if (message.type === 'open') {
      const streamId = typeof message.streamId === 'string' ? message.streamId : ''
      if (streamId === '') return
      this.nextGatewayId += 1
      const id = this.nextGatewayId
      this.dialects.set(id, 'gateway')
      this.gatewayIds.set(id, streamId)
      this.start(id, String(message.endpoint ?? ''), message.payload)
      return
    }
    if (message.type === 'item') {
      this.uplinkDropped += 1
      return
    }
    if (message.type === 'end' || message.type === 'cancel') {
      const streamId = typeof message.streamId === 'string' ? message.streamId : ''
      for (const [id, open] of this.gatewayIds) {
        if (open !== streamId) continue
        this.cancel(id)
        return
      }
    }
  }

  /** Close the socket and every stream it opened. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.streams.values()) controller.abort(new Error('mux closed'))
    this.streams.clear()
    this.gatewayIds.clear()
    this.dialects.clear()
    if (!this.socket.destroyed) this.socket.end(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)))
    this.onClosed()
  }
}

/**
 * Answer one WebSocket handshake.
 *
 * RFC 6455 asks for `SHA1(key + GUID)` in base64; there is no dependency here for four lines of
 * hashing, and the handshake never leaves loopback.
 * @param request - the upgrade request.
 * @param socket - the raw socket after the upgrade.
 * @returns true when the handshake was written.
 */
function acceptHandshake(request: IncomingMessage, socket: Socket): boolean {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || key === '') return false
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'))
  return true
}

/**
 * Attach the multiplexer to a server.
 * @param server - the workspace-origin server.
 * @param openUpstream - starts one Host stream and returns its body.
 */
export function attachStreamMux(
  server: Server,
  openUpstream: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
): void {
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (!MUX_PATHS.has(path)) {
      socket.destroy()
      return
    }
    if (!acceptHandshake(request, socket)) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    const session = new MuxSession(socket, openUpstream, () => { socket.destroy() })
    readFrames(socket, (frame) => { session.handle(frame) }, () => { session.dispose() })
  })
}
