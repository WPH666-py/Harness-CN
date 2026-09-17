/** Bounded run log for the desktop shell, mirrored to one append-only file. */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'

/** Which desktop process produced one log line. */
export type DesktopLogSource = 'shell' | 'host-out' | 'host-err'

/** One retained log line addressed by its monotonic sequence number. */
export interface DesktopLogEntry {
  readonly seq: number
  readonly time: number
  readonly source: DesktopLogSource
  readonly text: string
}

/** Complete retained log state handed to a desktop-owned renderer. */
export interface DesktopLogSnapshot {
  readonly entries: readonly DesktopLogEntry[]
  readonly dropped: number
  readonly file: string
}

/**
 * Lines appended since one push. A viewer appends these to what it already shows
 * instead of re-reading the whole ring, so a chatty Host does not resend thousands
 * of unchanged lines on every write.
 */
export interface DesktopLogUpdate {
  readonly entries: readonly DesktopLogEntry[]
  /** Cumulative lines evicted by the ring since the last clear. */
  readonly dropped: number
}

/**
 * Retained line count. The viewer is a diagnostic surface, not an audit log: the
 * file on disk keeps every line, so memory only has to cover what a reader scrolls.
 */
export const DESKTOP_LOG_CAPACITY = 2000

/**
 * Longest retained line. Harness diagnostics can carry a whole stack frame chain on
 * one line, so this is generous while still bounding the ring at a few megabytes.
 */
const MAX_LINE_CHARS = 4000

// Terminal color and cursor sequences: the viewer renders plain text, and the file is
// read by humans, so escape bytes are removed rather than displayed.
const ANSI_PATTERN = /[\u001B\u009B][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-nqry=><]/gu

/**
 * Store host and shell output for one running desktop application.
 *
 * The buffer owns two sinks with different lifetimes: a fixed-size ring the viewer
 * reads, and a file that survives the process. Neither sink is allowed to take the
 * shell down, so every write failure is absorbed rather than thrown.
 */
export class DesktopLogBuffer {
  private readonly entries: DesktopLogEntry[] = []
  private readonly partial = new Map<DesktopLogSource, string>()
  private readonly stream: WriteStream
  private pending: DesktopLogEntry[] = []
  private nextSeq = 1
  private droppedCount = 0
  private closed = false

  /**
   * @param file - absolute path of the append-only log file; its directory is created when absent.
   * @param capacity - retained line count before the oldest line is evicted.
   */
  constructor(
    private readonly file: string,
    private readonly capacity: number = DESKTOP_LOG_CAPACITY,
  ) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      // A missing log directory degrades to memory-only logging; the viewer still works.
    }
    this.stream = createWriteStream(file, { flags: 'a' })
    this.stream.on('error', () => { /* A failed file sink never interrupts the shell. */ })
  }

  /**
   * Record output for one source, splitting it into complete lines.
   * @param source - desktop process the text came from.
   * @param text - raw chunk, which may hold several lines or a partial one.
   */
  append(source: DesktopLogSource, text: string): void {
    if (this.closed || text === '') return
    const combined = (this.partial.get(source) ?? '') + text
    const segments = combined.split(/\r?\n/u)
    const remainder = segments.pop() ?? ''
    this.partial.set(source, remainder.slice(-MAX_LINE_CHARS))
    for (const segment of segments) this.record(source, segment)
  }

  /**
   * Record one complete line that carries no line terminator.
   *
   * {@link append} exists for streamed chunks and therefore has to hold the trailing
   * fragment back until its terminator arrives. A shell event is already a whole line,
   * so buffering it as a fragment would keep it out of both sinks indefinitely.
   * @param source - desktop process the line came from.
   * @param text - one complete line.
   */
  line(source: DesktopLogSource, text: string): void {
    if (this.closed) return
    this.record(source, text)
  }

  /** @returns retained lines in arrival order with the count evicted by the ring. */
  snapshot(): DesktopLogSnapshot {
    return { entries: [...this.entries], dropped: this.droppedCount, file: this.file }
  }

  /**
   * Take every line recorded since the previous drain for one viewer push.
   * @returns the new lines plus the ring's cumulative eviction count.
   */
  drain(): DesktopLogUpdate {
    const entries = this.pending
    this.pending = []
    return { entries, dropped: this.droppedCount }
  }

  /** Drop every retained line while preserving sequence numbering and the file sink. */
  clear(): void {
    this.entries.length = 0
    this.pending = []
    this.droppedCount = 0
  }

  /** Stop accepting lines and flush the file sink. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [source, remainder] of this.partial) {
      if (remainder !== '') this.record(source, remainder)
    }
    this.partial.clear()
    await new Promise<void>((resolve) => {
      this.stream.end(() => { resolve() })
    })
  }

  private record(source: DesktopLogSource, text: string): void {
    const line = text.replace(ANSI_PATTERN, '').slice(0, MAX_LINE_CHARS)
    const entry: DesktopLogEntry = { seq: this.nextSeq++, time: Date.now(), source, text: line }
    this.entries.push(entry)
    this.pending.push(entry)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
      this.droppedCount += 1
    }
    this.stream.write(`${new Date(entry.time).toISOString()} [${source}] ${line}\n`)
  }
}
