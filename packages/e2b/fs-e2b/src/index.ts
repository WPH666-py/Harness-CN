/**
 * E2B provider for the filesystem capability seam. Paths, contents, and
 * atomic staging files remain inside the shared remote sandbox.
 * @module @deepseek-ai/dsh-fs-e2b
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsByteWriteOutcome,
  FsCopyOutcome,
  FsCreateDirectoryOptions,
  FsCreateOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsRemoveOptions,
  FsRemoveOutcome,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  CommandExitError,
  e2bControlEnvs,
  FileNotFoundError,
  FileType,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { EntryInfo, Sandbox } from '@deepseek-ai/dsh-e2b'

const VERSION_METADATA_KEY = 'dsh-version'
const BINARY_SAMPLE_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-e2b: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded
    || framed.length < 2
    || framed.at(-1) !== 0
    || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-e2b: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error: unknown) {
    throw new Error('fs-e2b: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-e2b: canonical path is not absolute')
  return path
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function commandOpts(signal: AbortSignal | undefined): { envs: Record<string, string>; signal?: AbortSignal } {
  return { envs: e2bControlEnvs(), ...signalOpts(signal) }
}

async function openReadStream(
  sandbox: Sandbox,
  target: FsTarget,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
  try {
    // The pinned SDK's stream overload lies for empty files: content-length 0
    // returns '' instead of a ReadableStream.
    const read = await sandbox.files.read(String(target.targetKey), { format: 'stream', ...signalOpts(signal) }) as
      ReadableStream<Uint8Array> | string
    return typeof read === 'string'
      ? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
      : read
  } catch (error: unknown) {
    throw mapError(error, 'read', target.displayPath, signal)
  }
}

function entryType(entry: EntryInfo): FsInfo['type'] {
  switch (entry.type) {
    case FileType.FILE:
      return 'file'
    case FileType.DIR:
      return 'directory'
    default:
      return 'other'
  }
}

function entryVersion(entry: EntryInfo): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([
    entry.metadata?.[VERSION_METADATA_KEY],
    entry.path,
    entry.type,
    entry.size,
    entry.mode,
    entry.modifiedTime?.toISOString(),
    entry.symlinkTarget,
  ])
  return FsVersion(`e2b:${createHash('sha256').update(facts).digest('hex')}`)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (error instanceof FileNotFoundError) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|operation not permitted/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  // The pinned SDK exposes no distinct class for these two, and the controller's
  // message is the only fact that separates them; the preflight probes cover the
  // cases this provider can observe, so this is the fallback that keeps a raced
  // collision from reporting as an opaque I/O failure.
  if (/already exists|file exists|directory not empty/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": already exists`, 'FS_ALREADY_EXISTS', { cause: error })
  }
  if (/no such file or directory/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

/** The two ends of a move sit on different remote filesystems, so `rename` cannot join them. */
function isCrossDevice(error: unknown): boolean {
  return /cross-device|invalid cross-device link|EXDEV/i.test(String(error))
}

/** Kind of a remote entry, or `undefined` when either end of the link is absent. */
function kindOf(entry: EntryInfo | undefined): 'file' | 'directory' | 'other' | undefined {
  if (entry === undefined) return undefined
  return entryType(entry)
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** Remote filesystem backend sharing the sandbox owned by `ctx.e2b`. */
export class E2BFileSystem extends FileSystem {
  static inject = ['e2b']

  private readonly locks = new Map<string, Promise<unknown>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const targetKey = await this.canonicalPath(sandbox, displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-e2b: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(entry),
      type: entryType(entry),
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    const entry = await this.probe(displayPath, displayPath, signal)
    if (entry === undefined) return undefined
    const type = entry.symlinkTarget !== undefined
      ? 'symlink' as const
      : entry.type === FileType.FILE
        ? 'file' as const
        : entry.type === FileType.DIR
          ? 'directory' as const
          : 'other' as const
    return {
      version: entryVersion(entry),
      type,
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    try {
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'read')
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const sandbox = await this.ctx.e2b.getSandbox()
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const stream = await openReadStream(sandbox, target, signal)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let completed = false
    try {
      while (true) {
        assertNotAborted(signal, 'read')
        const next = await reader.read()
        if (next.done) break
        // The stat preflight covers the at-rest case; this streamed bound stops
        // a post-stat grower without transferring past the first overflowing chunk.
        bytes += next.value.byteLength
        if (bytes > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        chunks.push(next.value)
      }
      completed = true
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    } finally {
      if (!completed) {
        try {
          await reader.cancel()
        } catch (_streamCancellationFailure) {
          // The read already failed; a cancellation failure on the abandoned
          // remote stream adds nothing actionable for the caller.
        }
      }
      reader.releaseLock()
    }
    const whole = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      whole.set(chunk, offset)
      offset += chunk.byteLength
    }
    return whole
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    if (range.length === 0) return new Uint8Array(0)
    // The SDK streams only from the file's start: skip to `offset`, keep
    // `length` bytes, and cancel the stream there, so no more than the window
    // beyond the skipped prefix is ever transferred.
    const stream = await openReadStream(sandbox, target, signal)
    const reader = stream.getReader()
    const window = new Uint8Array(range.length)
    const end = range.offset + range.length
    let position = 0
    let filled = 0
    let drained = false
    try {
      while (filled < range.length) {
        assertNotAborted(signal, 'read')
        const next = await reader.read()
        if (next.done) {
          drained = true
          break
        }
        const from = Math.max(range.offset, position)
        const to = Math.min(end, position + next.value.byteLength)
        if (to > from) {
          window.set(next.value.subarray(from - position, to - position), filled)
          filled += to - from
        }
        position += next.value.byteLength
      }
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    } finally {
      if (!drained) {
        try {
          await reader.cancel()
        } catch (_streamCancellationFailure) {
          // The window is complete or the read already failed; a cancellation
          // failure on the abandoned remote stream adds nothing actionable.
        }
      }
      reader.releaseLock()
    }
    return filled === range.length ? window : window.subarray(0, filled)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    const stream = await openReadStream(sandbox, target, signal)
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const reader = stream.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          while (true) {
            assertNotAborted(signal, 'read')
            const next = await reader.read()
            if (next.done) break
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(next.value, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          if (!completed) {
            try {
              await reader.cancel()
            } catch (_streamCancellationFailure) {
              // The primary read outcome owns the result; cancellation is best-effort after early stop.
            }
          }
          reader.releaseLock()
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const listed = await sandbox.files.list(String(target.targetKey), { depth: 1, ...signalOpts(signal) })
      const entries: FsDirEntry[] = []
      for (const entry of listed) {
        const displayPath = posix.join(target.displayPath, entry.name)
        const canonical = entry.symlinkTarget === undefined
          ? entry.path
          : await this.canonicalPath(sandbox, entry.path, signal)
        const resolved = entry.symlinkTarget === undefined
          ? entry
          : await this.probe(canonical, displayPath, signal)
        entries.push({
          name: entry.name,
          type: resolved === undefined ? 'other' : entryType(resolved),
          target: { targetKey: FsTargetKey(canonical), displayPath },
          ...(resolved !== undefined ? { version: entryVersion(resolved) } : {}),
          ...(resolved?.type === FileType.FILE ? { size: resolved.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  /**
   * {@link FileSystem.writeBytes} over the remote execution world. The staging, guarded
   * create, mode preservation, and version metadata are the parts `writeText` already
   * runs; only the text diff basis is absent, which is why the outcome reports a byte
   * count instead.
   */
  override async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsByteWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        bytes: content.byteLength,
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  /**
   * {@link FileSystem.createDirectory} over the remote execution world. E2B
   * exposes only a recursive create, so the non-recursive case verifies the
   * parent first; the recursive case delegates the whole walk to the sandbox.
   */
  override async createDirectory(
    target: FsTarget,
    options?: FsCreateDirectoryOptions,
    signal?: AbortSignal,
  ): Promise<FsCreateOutcome> {
    const path = String(target.targetKey)
    return this.withLock(path, async () => {
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing !== undefined) {
        // `makeDir` reports an existing directory by returning false and throws
        // when a file sits at the path, so the recursive success case is decided
        // here instead of from the controller's answer.
        if (options?.recursive === true) {
          if (entryType(existing) !== 'directory') {
            throw new FsError(`cannot create directory "${target.displayPath}": already exists`, 'FS_ALREADY_EXISTS')
          }
          return { target, version: entryVersion(existing), type: 'directory' }
        }
        throw new FsError(`cannot create directory "${target.displayPath}": already exists`, 'FS_ALREADY_EXISTS')
      }
      if (options?.recursive !== true) await this.requireParentDirectory(target, 'create directory', signal)
      try {
        const sandbox = await this.ctx.e2b.getSandbox()
        await sandbox.files.makeDir(path, signalOpts(signal))
      } catch (error: unknown) {
        throw mapError(error, 'create directory', target.displayPath, signal)
      }
      assertNotAborted(signal, 'create directory')
      const created = await this.probe(path, target.displayPath, signal)
      /* v8 ignore next -- the directory was just created by this call, so only a concurrent removal makes the probe miss it. */
      if (created === undefined) throw new FsError(`cannot create directory "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      return { target, version: entryVersion(created), type: 'directory' }
    })
  }

  /**
   * {@link FileSystem.createFile} over the remote execution world: one write of
   * empty content, after a probe that refuses an occupied destination, so no
   * existing remote entry is ever replaced.
   */
  override async createFile(target: FsTarget, signal?: AbortSignal): Promise<FsCreateOutcome> {
    const path = String(target.targetKey)
    return this.withLock(path, async () => {
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing !== undefined) {
        throw new FsError(`cannot create file "${target.displayPath}": already exists`, 'FS_ALREADY_EXISTS')
      }
      await this.requireParentDirectory(target, 'create file', signal)
      try {
        const sandbox = await this.ctx.e2b.getSandbox()
        await sandbox.files.write(path, '', signalOpts(signal))
      } catch (error: unknown) {
        throw mapError(error, 'create file', target.displayPath, signal)
      }
      assertNotAborted(signal, 'create file')
      const created = await this.probe(path, target.displayPath, signal)
      /* v8 ignore next -- the file was just created by this call, so only a concurrent removal makes the probe miss it. */
      if (created === undefined) throw new FsError(`cannot create file "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      return { target, version: entryVersion(created), type: 'file' }
    })
  }

  /**
   * {@link FileSystem.remove} over the remote execution world. A non-recursive
   * removal of a directory that still has entries is refused here, before the
   * controller is asked, so the failure does not depend on how the sandbox
   * treats a recursive remove.
   */
  override async remove(
    target: FsTarget,
    options?: FsRemoveOptions,
    signal?: AbortSignal,
  ): Promise<FsRemoveOutcome> {
    const path = String(target.targetKey)
    const existing = await this.probe(path, target.displayPath, signal)
    if (existing === undefined) throw new FsError(`cannot remove "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    const type = entryType(existing)
    if (type === 'other') {
      throw new FsError(`cannot remove "${target.displayPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
    }
    if (type === 'directory' && options?.recursive !== true) {
      const children = await this.listChildren(path, target.displayPath, signal)
      if (children.length > 0) {
        throw new FsError(`cannot remove "${target.displayPath}": directory not empty`, 'FS_NOT_EMPTY')
      }
    }
    assertNotAborted(signal, 'remove')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      await sandbox.files.remove(path, signalOpts(signal))
    } catch (error: unknown) {
      throw mapError(error, 'remove', target.displayPath, signal)
    }
    return { type }
  }

  /**
   * {@link FileSystem.copy} over the remote execution world: a recursive walk of
   * the source subtree, reproducing links as links so nothing outside the
   * source is pulled in.
   */
  override async copy(from: FsTarget, to: FsTarget, signal?: AbortSignal): Promise<FsCopyOutcome> {
    return this.withLock(String(to.targetKey), async () => {
      const source = await this.probe(String(from.targetKey), from.displayPath, signal)
      if (source === undefined) throw new FsError(`cannot copy "${from.displayPath}": not found`, 'FS_NOT_FOUND')
      const type = entryType(source)
      if (type === 'other') {
        throw new FsError(`cannot copy "${from.displayPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
      }
      if (await this.probe(String(to.targetKey), to.displayPath, signal) !== undefined) {
        throw new FsError(`cannot copy "${from.displayPath}" to "${to.displayPath}": already exists`, 'FS_ALREADY_EXISTS')
      }
      await this.copyEntry(String(from.targetKey), String(to.targetKey), type, signal)
      const copied = await this.probe(String(to.targetKey), to.displayPath, signal)
      /* v8 ignore next -- the entry was just copied by this call, so only a concurrent removal makes the probe miss it. */
      if (copied === undefined) throw new FsError(`cannot copy "${from.displayPath}": not found`, 'FS_NOT_FOUND')
      return { target: to, type }
    })
  }

  /**
   * {@link FileSystem.move} over the remote execution world: one `rename` when
   * both ends share a filesystem, otherwise the copy-then-remove fallback, which
   * is not atomic and leaves the source in place if the removal fails.
   */
  override async move(from: FsTarget, to: FsTarget, signal?: AbortSignal): Promise<FsMoveOutcome> {
    const fromPath = String(from.targetKey)
    const toPath = String(to.targetKey)
    return this.withLock(toPath, async () => {
      const source = await this.probe(fromPath, from.displayPath, signal)
      if (source === undefined) throw new FsError(`cannot move "${from.displayPath}": not found`, 'FS_NOT_FOUND')
      const type = entryType(source)
      if (type === 'other') {
        throw new FsError(`cannot move "${from.displayPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
      }
      if (await this.probe(toPath, to.displayPath, signal) !== undefined) {
        throw new FsError(`cannot move "${from.displayPath}" to "${to.displayPath}": already exists`, 'FS_ALREADY_EXISTS')
      }
      assertNotAborted(signal, 'move')
      const sandbox = await this.ctx.e2b.getSandbox()
      try {
        const renamed = await sandbox.files.rename(fromPath, toPath, signalOpts(signal))
        return { target: to, type: kindOf(renamed) === 'directory' ? 'directory' : type }
      } catch (error: unknown) {
        if (!isCrossDevice(error)) throw mapError(error, 'move', to.displayPath, signal)
      }
      // Different remote filesystems: build the destination from the source and
      // remove the source only once the destination is complete.
      await this.copyEntry(fromPath, toPath, type, signal)
      await this.remove({ targetKey: FsTargetKey(fromPath), displayPath: from.displayPath }, { recursive: true }, signal)
      return { target: to, type }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async canonicalPath(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await sandbox.commands.run(
        `set -o pipefail; realpath -mz -- ${quoteE2BShellArg(path)} | base64 -w0`,
        commandOpts(signal),
      )
      return decodeCanonicalPath(result.stdout)
    } catch (error: unknown) {
      if (error instanceof CommandExitError) throw new Error(error.stderr || error.message, { cause: error })
      throw error
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<EntryInfo | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const entry = await sandbox.files.getInfo(path, signalOpts(signal))
      assertNotAborted(signal, 'stat')
      return entry
    } catch (error: unknown) {
      if (error instanceof FileNotFoundError) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  /** Refuse a create whose parent is absent or is not a directory. */
  private async requireParentDirectory(target: FsTarget, operation: string, signal?: AbortSignal): Promise<void> {
    const parentPath = posix.dirname(String(target.targetKey))
    const parentDisplay = posix.dirname(target.displayPath)
    const parent = await this.probe(parentPath, parentDisplay, signal)
    if (parent === undefined || entryType(parent) !== 'directory') {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
  }

  /** Direct children of a remote directory, for the non-recursive removal check. */
  private async listChildren(path: string, displayPath: string, signal?: AbortSignal): Promise<EntryInfo[]> {
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const listed = await sandbox.files.list(path, { depth: 1, ...signalOpts(signal) })
      return listed.filter(entry => entry.path !== path)
    } catch (error: unknown) {
      throw mapError(error, 'list', displayPath, signal)
    }
  }

  /**
   * Copy one remote entry — a regular file, a directory subtree, or a symbolic
   * link — without following links. Every destination below the root was
   * checked absent by the caller, so each level creates a fresh entry.
   */
  private async copyEntry(
    fromPath: string,
    toPath: string,
    type: 'file' | 'directory',
    signal?: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal, 'copy')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      if (type === 'directory') {
        await sandbox.files.makeDir(toPath, signalOpts(signal))
        for (const child of await this.listChildren(fromPath, fromPath, signal)) {
          const childType = entryType(child)
          if (childType === 'other' && child.symlinkTarget === undefined) {
            throw new FsError(`cannot copy "${child.path}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
          }
          await this.copyEntry(child.path, posix.join(toPath, child.name), childType === 'directory' ? 'directory' : 'file', signal)
        }
        return
      }
      const source = await this.probe(fromPath, fromPath, signal)
      /* v8 ignore next -- the caller probed this entry a moment earlier; only a concurrent removal makes it miss. */
      if (source === undefined) throw new FsError(`cannot copy "${fromPath}": not found`, 'FS_NOT_FOUND')
      if (source.symlinkTarget !== undefined) {
        // The link is reproduced, not followed: a link pointing outside the
        // source subtree must not pull that target's content into the copy.
        await sandbox.commands.run(
          `ln -s -- ${quoteE2BShellArg(source.symlinkTarget)} ${quoteE2BShellArg(toPath)}`,
          commandOpts(signal),
        )
        return
      }
      if (entryType(source) !== 'file') {
        throw new FsError(`cannot copy "${fromPath}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
      }
      const bytes = await sandbox.files.read(fromPath, { format: 'bytes', ...signalOpts(signal) })
      // The SDK transports bytes as an ArrayBuffer; `slice` on a view always
      // yields a non-shared one, which is what its narrower parameter type wants.
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      await sandbox.files.write(toPath, payload, signalOpts(signal))
    } catch (error: unknown) {
      throw mapError(error, 'copy', toPath, signal)
    }
  }

  private checkWriteIntent(existing: EntryInfo | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'read')
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'edit')
      return decodeText(bytes, target.displayPath, bytes.length)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  private async writeAtomic(
    target: FsTarget,
    content: string | Uint8Array,
    existing: EntryInfo | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const sandbox = await this.ctx.e2b.getSandbox()
    const targetPath = String(target.targetKey)
    const versionId = randomUUID()
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      const created = await sandbox.files.makeDir(stagingDirectory, signalOpts(signal))
      if (!created) throw new Error('private staging directory already exists')
      stagingDirectoryCreated = true
      await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stagingDirectory)}`, commandOpts(signal))
      assertNotAborted(signal, 'write')
      // The SDK transports bytes as an ArrayBuffer, and a Uint8Array view may cover only
      // part of its backing buffer, so the exact window is copied out rather than passing
      // the whole backing store. The cast is the library's declared narrower parameter
      // type; `slice` on a view always yields a non-shared ArrayBuffer.
      const payload = typeof content === 'string'
        ? content
        : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
      await sandbox.files.write(temporary, payload, {
        metadata: { [VERSION_METADATA_KEY]: versionId },
        ...signalOpts(signal),
      })
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await sandbox.commands.run(
        `chmod ${mode.toString(8)} -- ${quoteE2BShellArg(temporary)}`,
        commandOpts(signal),
      )
      assertNotAborted(signal, 'write')
      let committed: EntryInfo
      if (createIfAbsent) {
        const staged = await sandbox.files.getInfo(temporary, signalOpts(signal))
        assertNotAborted(signal, 'write')
        const targetArg = quoteE2BShellArg(targetPath)
        const publication = await sandbox.commands.run(
          `if ln -T -- ${quoteE2BShellArg(temporary)} ${targetArg}; then printf created; elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`,
          commandOpts(undefined),
        )
        if (publication.stdout === 'exists') {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            'FS_NOT_OBSERVED',
          )
        }
        if (publication.stdout !== 'created') {
          throw new Error('guarded create returned an invalid publication result')
        }
        committed = { ...staged, name: posix.basename(targetPath), path: targetPath }
      } else {
        committed = await sandbox.files.rename(temporary, targetPath)
      }
      try {
        await sandbox.files.remove(stagingDirectory)
      } catch (_committedStagingCleanupFailure) {
        // The target is already committed; an empty private directory cannot turn that write into a failure.
      }
      return entryVersion(committed)
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        try {
          await sandbox.files.remove(stagingDirectory)
        } catch (_stagingDirectoryAlreadyAbsentOrCleanupFailed) {
          // Only the private staging directory is swallowed; the original failure owns the operation.
        }
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

export default E2BFileSystem
