/**
 * The feedback form's mail path: turn one submitted review into an HTML message and
 * hand it to the author's own QQ mailbox over SMTPS.
 *
 * Hand-rolled rather than taken from `nodemailer`: the whole protocol use here is
 * "authenticate, MAIL FROM, RCPT TO, DATA", the target is one fixed host, and the
 * sidecar ships inside the installer where a mail library's transport matrix,
 * attachment handling, and plugin surface would all be dead weight.
 *
 * The message is built from the visitor's own words, so nothing is interpolated
 * without escaping and every field passes through the same newline-stripping the
 * SMTP headers need.
 */

import { connect } from 'node:tls'
import type { TLSSocket } from 'node:tls'

/** Submission-over-TLS endpoint QQ Mail publishes for third-party clients. */
const SMTP_HOST = 'smtp.qq.com'
const SMTP_PORT = 465

/** Account the feedback is sent from, and the address it is delivered to. */
const SENDER = '3799691108@qq.com'
const RECIPIENT = '943050454@qq.com'

/**
 * QQ Mail's SMTP authorization code for {@link SENDER}. It is a mail-app credential
 * rather than the account password, and it is scoped to sending: it is what this
 * product ships so that a user's feedback needs no mailbox of their own.
 */
const SENDER_AUTHORIZATION_CODE = 'fsqnsoqhjzdmcdaa'

/** Longest a single SMTP transaction may take before it is abandoned. */
const SMTP_TIMEOUT_MS = 25_000

/** Longest the visitor's message may be, which bounds what the body may carry. */
export const FEEDBACK_MESSAGE_MAX = 5_000

/** One submitted review, already validated at the HTTP boundary. */
export interface FeedbackSubmission {
  /** What the visitor wrote. */
  readonly message: string
  /** The QQ mailbox the author should reply to. */
  readonly email: string
}

/**
 * Remove the characters that must never reach a header value.
 *
 * A CR or LF inside a header is a header injection; a NUL byte truncates the value
 * for some readers. Both are stripped rather than rejected, because the values that
 * reach here are a mailbox address and free text the visitor is entitled to type.
 * @param value - raw field text.
 * @returns the same text with control characters removed.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]/gu, ' ').trim()
}

/**
 * Escape text for interpolation into the message's HTML body.
 * @param value - raw text.
 * @returns HTML with the five significant characters replaced by entities.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * RFC 2047 encode one header value so a Chinese subject survives the ASCII wire.
 * @param value - header text.
 * @returns the value as a base64 encoded-word.
 */
function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Build the RFC 5322 message the visitor's review is delivered as.
 * @param submission - validated review text and reply address.
 * @param receivedAt - the moment the form was submitted.
 * @returns the complete message, headers first, CRLF-terminated.
 */
export function buildFeedbackMessage(submission: FeedbackSubmission, receivedAt: Date): string {
  const replyTo = headerSafe(submission.email)
  const body = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.7">',
    '<h2 style="margin:0 0 12px">Harness-CN 用户反馈</h2>',
    `<p style="margin:0 0 4px"><strong>回复邮箱：</strong>${escapeHtml(replyTo)}</p>`,
    `<p style="margin:0 0 16px"><strong>提交时间：</strong>${escapeHtml(receivedAt.toISOString())}</p>`,
    '<hr style="border:none;border-top:1px solid #ddd;margin:0 0 16px">',
    `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(submission.message)}</pre>`,
    '</body></html>',
  ].join('\r\n')

  const headers = [
    `From: "Harness-CN 反馈" <${SENDER}>`,
    `To: <${RECIPIENT}>`,
    `Reply-To: <${replyTo}>`,
    `Subject: ${encodedWord(`用户反馈 - ${replyTo}`)}`,
    `Date: ${receivedAt.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]

  const encodedBody = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/gu, '$1\r\n')
  return `${[...headers, '', encodedBody].join('\r\n')}\r\n`
}

/**
 * An SMTPS conversation whose replies are read from one accumulating buffer.
 *
 * A per-step listener is not usable here: the server is free to deliver a reply in
 * several chunks, and a later reply can arrive in the same chunk as an earlier one,
 * so replies have to be framed from a buffer that outlives any single step. Replies
 * are therefore queued as they complete and each command awaits the next one, which
 * keeps the transaction strictly lock-step.
 */
class SmtpConversation {
  private buffer = ''
  private readonly replies: { code: number; text: string }[] = []
  private waiting: { resolve: () => void; reject: (error: Error) => void; want: number } | undefined
  private failure: Error | undefined

  constructor(private readonly socket: TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
    socket.on('error', (error: Error) => { this.fail(error) })
    socket.on('close', () => { this.fail(new Error('邮件服务器在会话结束前断开了连接')) })
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.reject(error)
  }

  /** Frame every complete reply currently in the buffer and settle the waiter. */
  private drain(): void {
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      // Multi-line replies continue while the fourth character is '-'.
      if (/^\d{3}-/.test(line)) continue
      if (!/^\d{3}[ ]/.test(line)) continue
      const reply = { code: Number(line.slice(0, 3)), text: line.slice(4) }
      const waiting = this.waiting
      if (waiting === undefined) {
        this.replies.push(reply)
        return
      }
      this.waiting = undefined
      if (reply.code !== waiting.want) {
        waiting.reject(new Error(`SMTP 服务器返回 ${String(reply.code)}：${reply.text}`))
      } else {
        waiting.resolve()
      }
      return
    }
  }

  /**
   * Await the next reply and require one code.
   * @param want - the reply code that means success for the current step.
   * @throws {Error} when the server answers with a different code or the link fails.
   */
  async expect(want: number): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    const queued = this.replies.shift()
    if (queued !== undefined) {
      if (queued.code !== want) {
        throw new Error(`SMTP 服务器返回 ${String(queued.code)}：${queued.text}`)
      }
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.waiting = { resolve, reject, want }
    })
  }

  /**
   * Send one command line and require its reply code.
   * @param line - command to write.
   * @param want - the reply code that means success.
   */
  async command(line: string, want: number): Promise<void> {
    this.socket.write(`${line}\r\n`)
    await this.expect(want)
  }
}

/**
 * Deliver one feedback message to the author's mailbox.
 *
 * Every step's reply code is checked, so a rejected recipient or refused credential
 * surfaces as a message the form can show rather than a silent success.
 * @param submission - validated review text and reply address.
 * @returns `accepted` once the mailbox has queued the message.
 * @throws {Error} when the connection, authentication, or delivery fails.
 */
export async function sendFeedbackMail(submission: FeedbackSubmission): Promise<string> {
  const message = buildFeedbackMessage(submission, new Date())
  const socket = connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
  socket.setTimeout(SMTP_TIMEOUT_MS)

  const timedOut = (): void => { socket.destroy(new Error('与邮件服务器的连接超时')) }
  socket.once('timeout', timedOut)

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve)
      socket.once('error', reject)
    })
    const conversation = new SmtpConversation(socket)
    await conversation.expect(220)
    await conversation.command(`EHLO ${SMTP_HOST}`, 250)
    await conversation.command('AUTH LOGIN', 334)
    await conversation.command(Buffer.from(SENDER, 'utf8').toString('base64'), 334)
    await conversation.command(Buffer.from(SENDER_AUTHORIZATION_CODE, 'utf8').toString('base64'), 235)
    await conversation.command(`MAIL FROM:<${SENDER}>`, 250)
    await conversation.command(`RCPT TO:<${RECIPIENT}>`, 250)
    await conversation.command('DATA', 354)
    // The message body is written before awaiting the queue reply, because the server
    // answers only after the terminating dot.
    const queued = conversation.expect(250)
    socket.write(`${message}\r\n.\r\n`)
    await queued
    socket.write('QUIT\r\n')
    socket.end()
    return 'accepted'
  } finally {
    socket.off('timeout', timedOut)
    socket.destroy()
  }
}
