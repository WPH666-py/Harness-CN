/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
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
  applyLiteralEdit,
  copyPath,
  createDirectory,
  createFile,
  listDirectory,
  movePath,
  normalizeLineEndings,
  probe,
  probeNoFollow,
  readForEdit,
  readByteWindow,
  readTextForDiff,
  readWholeBytes,
  readWholeText,
  removePath,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals } from './fsio.ts'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

type ResolvedConfig = Required<Config>
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
)

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = resolved
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return isAbsolute(hostPath) ? resolve(hostPath) : undefined
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await probe(target.targetKey)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const info = await probeNoFollow(resolve(opts?.cwd ?? this.config.cwd, path))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return readByteWindow({ displayPath: target.displayPath, targetKey: target.targetKey }, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const before = diffable
        ? await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal)
        : null
      await writeFileAtomic(
        target.targetKey,
        content,
        existing?.mode,
        signal,
        this.internals,
        expected?.kind === 'createIfAbsent' ? { displayPath: target.displayPath } : undefined,
      )
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        before,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed. Line-ending restoration
        // is a storage detail the applied-hunk diff ignores.
        after: normalizeLineEndings(content),
      }
    })
  }

  /**
   * {@link FileSystem.writeBytes} over the local filesystem. Intent guarding, the stale
   * check, staging, `fsync`, and publication use exactly the parts `writeText` uses; only
   * the encoding step and the text diff basis are absent, which is why the outcome reports
   * a byte count instead of a `before`/`after` pair.
   */
  override async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsByteWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      await writeFileAtomic(
        target.targetKey,
        content,
        existing?.mode,
        signal,
        this.internals,
        expected?.kind === 'createIfAbsent' ? { displayPath: target.displayPath } : undefined,
      )
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        bytes: content.byteLength,
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // Missing targets use the same stale code on guarded and unconditional edit paths.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeFileAtomic(target.targetKey, content, existing.mode, signal, this.internals)

      const after = await probe(target.targetKey)
      return {
        version: this.versionAfterWrite(after, target),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }

  /**
   * {@link FileSystem.createDirectory} over the host filesystem. The directory
   * is created by one `mkdir` (or one recursive `mkdir`), so a failure leaves
   * no partial directory behind.
   */
  override async createDirectory(
    target: FsTarget,
    options?: FsCreateDirectoryOptions,
    signal?: AbortSignal,
  ): Promise<FsCreateOutcome> {
    return this.withLock(target.targetKey, async () => {
      const outcome = await createDirectory(String(target.targetKey), options, signal)
      return { ...outcome, target: this.outcomeTarget(outcome.target, target) }
    })
  }

  /**
   * {@link FileSystem.createFile} over the host filesystem. The empty file is
   * published by one exclusive create, so no existing entry is ever replaced.
   */
  override async createFile(target: FsTarget, signal?: AbortSignal): Promise<FsCreateOutcome> {
    return this.withLock(target.targetKey, async () => {
      const outcome = await createFile(String(target.targetKey), signal)
      return { ...outcome, target: this.outcomeTarget(outcome.target, target) }
    })
  }

  /**
   * {@link FileSystem.remove} over the host filesystem. One `rm`/`rmdir` call
   * carries the removal; a non-recursive removal of a directory that still has
   * entries reports `FS_NOT_EMPTY` from the syscall itself.
   */
  override async remove(target: FsTarget, options?: FsRemoveOptions, signal?: AbortSignal): Promise<FsRemoveOutcome> {
    return removePath(String(target.targetKey), options, signal)
  }

  /**
   * {@link FileSystem.copy} over the host filesystem. The destination subtree is
   * built entry by entry; a failure partway leaves what it had already copied,
   * because no filesystem can un-copy atomically.
   */
  override async copy(from: FsTarget, to: FsTarget, signal?: AbortSignal): Promise<FsCopyOutcome> {
    return this.withLock(to.targetKey, async () => {
      const outcome = await copyPath(String(from.targetKey), String(to.targetKey), signal)
      return { ...outcome, target: this.outcomeTarget(outcome.target, to) }
    })
  }

  /**
   * {@link FileSystem.move} over the host filesystem. One `rename` carries the
   * move; a cross-device move falls back to a copy followed by a removal of the
   * source, and both ends are serialized against other mutations of the same
   * targets.
   */
  override async move(from: FsTarget, to: FsTarget, signal?: AbortSignal): Promise<FsMoveOutcome> {
    return this.withLocks([from.targetKey, to.targetKey], async () => {
      const outcome = await movePath(String(from.targetKey), String(to.targetKey), signal, this.internals)
      return { ...outcome, target: this.outcomeTarget(outcome.target, to) }
    })
  }

  /** Run `op` holding every named key at once. */
  private async withLocks<T>(targetKeys: readonly string[], op: () => Promise<T>): Promise<T> {
    const unique = [...new Set(targetKeys)].sort()
    const run = async (index: number): Promise<T> => {
      const key = unique[index]
      /* v8 ignore next -- the recursion stops at the length of a list this call built. */
      if (key === undefined) return op()
      return this.withLock(key, () => run(index + 1))
    }
    return run(0)
  }

  /**
   * The display path of an operation's destination, which is the path the
   * caller resolved — a created entry may have been reached through a symlinked
   * ancestor, and the display path must keep naming the caller's path.
   */
  private outcomeTarget(resolved: { targetKey: FsTarget['targetKey'] }, requested: FsTarget): FsTarget {
    return { targetKey: resolved.targetKey, displayPath: requested.displayPath }
  }
}

export default LocalFileSystem
