/**
 * Workspace file service: read-only file previews, workspace directory
 * listings, the filesystem-observation change feed, and workspace-confined
 * mutations, exposed as `workspaceFiles`.
 *
 * File reads follow the composed filesystem's read access, including paths
 * outside the workspace. The selected Session header supplies the base for
 * relative paths, with the sandbox policy root as its no-cwd fallback, not a
 * read-containment restriction. Directory listings and change observations
 * remain workspace-scoped, and every mutation is contained: the Session's
 * workspace root is resolved, the target is resolved against it, and a target
 * outside the root is refused with `workspace-file/outside-workspace`. File-kind
 * checks and configured read caps apply to every preview.
 *
 * A page is cut from `streamText`, which decodes and rejects non-UTF-8 as it
 * goes, so the file is read only up to the first character past the page and
 * never held whole in memory; the NUL scan runs on the page itself.
 *
 * This is NOT modelled on `session.openWorkspacePath`. That endpoint hands a
 * path to the local opener and leaves the effect on the machine; this one sends
 * file content across the wire, which is a different level of exposure.
 */

import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsErrorCode, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceChangeFeed } from './changes.ts'
import type {
  WorkspaceByteRange,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing,
  WorkspaceFileBytes,
  WorkspaceFileMutation,
  WorkspaceFileRange,
  WorkspaceFileRemoval,
  WorkspaceFileStat,
  WorkspaceFileText,
  WorkspaceFileWatchFrame,
  WorkspaceRemoveOptions,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `workspaceFiles` Remote namespace. */
    workspaceFiles: WorkspaceFiles
  }
}

/** Header-derived file resolution context for one Session identity. */
export interface WorkspaceFileScope {
  /** Session identity received on the wire. */
  readonly sessionId: SessionId
  /** Session workspace root, or the deployment fallback when its header has no cwd. */
  readonly workspaceRoot: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    /** Resolve a Session id to its workspace root without loading its event body or activating an Agent. */
    workspaceFileScope: TypertLookup<WorkspaceFileScope, SessionId>
  }
}

/** Deployment caps on one page or one listing. */
export interface Config {
  /**
   * Inclusive byte cap on one page's text and on one byte window.
   *
   * A page above this fails; it is not shortened, because a silently cut page
   * reads as the whole page. A byte window asking for more is refused the same
   * way. The file itself has no size cap: a caller pages through it.
   */
  readonly maxBytes: number
  /** Inclusive byte cap on a complete-file read; larger files are refused, never truncated. */
  readonly maxFileBytes: number
  /** Default and largest page size in lines; a request asking for more is refused. */
  readonly maxLines: number
  /** Cap on returned directory entries; the rest is dropped and reported cut. */
  readonly maxEntries: number
}

/** One page cut from a decoded text stream. */
interface Page {
  readonly text: string
  /** Lines in `text`; `0` for a page past the last line. */
  readonly lines: number
  readonly eof: boolean
}

/** The byte text never carries: its presence marks a page as binary. */
const NUL = String.fromCharCode(0)

/**
 * A create-like verb's `name` must be exactly one path segment, so the name
 * cannot reach a parent directory, an absolute root, or another volume. Both
 * separators are refused on every platform, because the wire does not say which
 * platform the other end runs.
 */
const SINGLE_SEGMENT = /^[^/\\]+$/u

/**
 * Refuse a `name` that is not one path segment. `.` and `..` are refused with
 * the separators: both name a directory that already exists rather than a new
 * entry.
 */
function requireSegment(name: string, verb: string): string {
  const trimmed = name.trim()
  if (trimmed !== name || !SINGLE_SEGMENT.test(name) || name === '.' || name === '..') {
    throw new RemoteError('gateway/bad-request', `${verb} requires a single non-blank path segment name`, {})
  }
  return name
}

/** Join a workspace path with one segment, keeping the `/` join the workspace-relative form uses. */
function joinWorkspacePath(parent: string, name: string): string {
  return parent === '' ? name : `${parent.replace(/[\\/]+$/u, '')}/${name}`
}

/**
 * Join one validated segment onto a process path in the filesystem's execution
 * world. The execution world's convention decides the separator, because the
 * path is handed back to `resolve`.
 */
function joinProcessPath(parent: string, segment: string): string {
  const paths = parent.startsWith('/') ? posix : win32
  return paths.join(parent, segment)
}

/** Abort check between entries of a multi-entry mutation. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/bad-request', 'the request was cancelled', {})
}

/**
 * The backend's stable code for a mutation refusal, recognized by the code
 * alone: the error class belongs to whichever `dsh-fs` instance the provider
 * loaded, so no class identity is shared across the package boundary.
 */
function fsErrorCodeOf(error: unknown): FsErrorCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code as FsErrorCode
}

/** Refuse anything the wire schema admits as a number but a window cannot use: only safe integers index a file. */
function integerAtLeast(value: number, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RemoteError('gateway/bad-request', `${name} must be a safe integer of at least ${min}`, {})
  }
  return value
}

/**
 * Cut lines `offset` through `offset + limit - 1` from decoded chunks, stopping
 * at the first character past the page so the rest of the file is never read.
 * Lines before the page are counted, not kept, and the page is refused the
 * moment its bytes exceed `maxBytes`, so one giant line cannot grow memory past
 * the cap either.
 */
async function cutPage(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  maxBytes: number,
  path: string,
): Promise<Page> {
  const last = offset + limit - 1
  const lines: string[] = []
  let current = ''
  let bytes = 0
  let lineNumber = 1
  const admit = (size: number): void => {
    bytes += size
    if (bytes > maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `lines ${offset}-${last} of "${path}" exceed the ${maxBytes} byte cap`,
        { path, limit: maxBytes },
      )
    }
  }
  const complete = (): void => {
    if (lines.length > 0) admit(1)
    lines.push(current)
    current = ''
  }
  for await (const chunk of chunks) {
    let position = 0
    while (position < chunk.length) {
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false }
      const newline = chunk.indexOf('\n', position)
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline)
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, 'utf8'))
        current += segment
      }
      if (newline === -1) break
      if (lineNumber >= offset) complete()
      lineNumber += 1
      position = newline + 1
    }
  }
  // Only an in-page line can be pending here: earlier lines were never kept,
  // and a character past the page returned above.
  if (current.length > 0) complete()
  return { text: lines.join('\n'), lines: lines.length, eof: true }
}

/**
 * Workspace path of `target` relative to `root`, derived from the two canonical
 * `file:` URIs so the answer is `/`-joined on every platform. Empty for the root.
 */
function workspacePathOf(rootUrl: string, targetUrl: string): string {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, '')
  const target = new URL(targetUrl).pathname
  if (target === root) return ''
  return target.slice(root.length + 1).split('/').map(decodeURIComponent).join('/')
}

/** Strip the resolved child target: the wire carries names and metadata only. */
function directoryEntry(child: FsDirEntry): WorkspaceDirectoryEntry {
  return {
    name: child.name,
    type: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }
}

/** Host Remote file reads and workspace directory observations over the composed filesystem. */
export class WorkspaceFiles extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']

  static Config: z<Config> = z.object({
    maxBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxFileBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(32 * 1024 * 1024),
    maxLines: z.number().step(1).min(1).default(5000),
    maxEntries: z.number().step(1).min(1).default(2000),
  })

  private readonly feed: WorkspaceChangeFeed

  /**
   * @param ctx - Host context carrying the filesystem and the sandbox policy.
   * @param config - deployment caps on one page or one listing.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceFiles')
    this.feed = new WorkspaceChangeFeed(ctx)
    ctx.inject(['sessions', 'typert'], (scope) => {
      scope.typert.lookups.register('workspaceFileScope', {
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: async (sessionId) => {
          const live = scope.sessions.get(sessionId)?.header
          const stored = live === undefined
            ? await scope.get('sessionPersistence')?.stat(sessionId)
            : undefined
          const header = live ?? stored?.header
          if (header === undefined) return undefined
          return {
            sessionId,
            workspaceRoot: header.cwd ?? scope.sandboxPolicy.workspaceRoot,
          }
        },
      })
    })
  }

  /**
   * Read one page of lines from a UTF-8 file readable by the filesystem backend.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
   * @param range - the line window; omitted fields take the page defaults.
   * @param signal - caller cancellation.
   * @returns the page, the file's version at the stat before it, and whether it reaches the last line.
   */
  @Remote
  async read(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    range: WorkspaceFileRange,
    signal: AbortSignal,
  ): Promise<WorkspaceFileText> {
    const { offset, limit } = this.resolvePage(range)
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    const page = await this.cutPage(target, offset, limit, signal, path)
    if (page.text.includes(NUL)) {
      throw new RemoteError('workspace-file/not-text', `"${path}" contains NUL bytes`, { path })
    }
    return { ...this.statOf(target, info), offset, text: page.text, lines: page.lines, eof: page.eof }
  }

  /**
   * Read one byte window of a regular file readable by the filesystem backend: raw
   * bytes, no text decoding and no binary rejection.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
   * @param range - the byte window; omitted fields take the window defaults.
   * @param signal - caller cancellation.
   * @returns the window in base64, the file's version and size at the stat before it, and whether it reaches the last byte.
   */
  @Remote
  async readBytes(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    range: WorkspaceByteRange,
    signal: AbortSignal,
  ): Promise<WorkspaceFileBytes> {
    const { offset, length } = this.resolveWindow(range, path)
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    const data = await this.ctx.fs.readByteRange(target, { offset, length }, signal)
    const eof = info.size === undefined ? data.length < length : offset + data.length >= info.size
    return { ...this.statOf(target, info), offset, data: Buffer.from(data).toString('base64'), eof }
  }

  /**
   * Read a complete regular file as bytes, subject to the configured full-file cap.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute or workspace-relative file path.
   * @param signal - caller cancellation.
   * @returns one complete base64 window with offset zero and eof true; oversized files fail with too-large.
   */
  @Remote
  async readAll(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileBytes> {
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    const limit = this.config.maxFileBytes
    if (info.size !== undefined && info.size > limit) {
      throw new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${limit} byte full-file cap`, { path, limit })
    }
    const data = await this.ctx.fs.readByteRange(target, { offset: 0, length: limit + 1 }, signal)
    if (data.length > limit) {
      throw new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${limit} byte full-file cap`, { path, limit })
    }
    return { ...this.statOf(target, info), offset: 0, data: Buffer.from(data).toString('base64'), eof: true }
  }

  /**
   * Read a complete file relative to another file's directory, including outside the workspace.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - base file, absolute or workspace-relative.
   * @param relativePath - relative filesystem path, not a URL or absolute path.
   * @param signal - caller cancellation.
   * @returns the complete related file using the ordinary file-size and access checks.
   */
  @Remote
  async readRelated(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileBytes> {
    const relative = relativePath.replace(/\\/g, '/')
    if (relative.length === 0 || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes(NUL)) {
      throw new RemoteError('gateway/bad-request', 'relativePath must be a relative filesystem path', {})
    }
    const { target } = await this.locateFile(workspaceFileScope, path, signal)
    const absolute = this.ctx.fs.processPath(target)
    const paths = absolute.startsWith('/') ? posix : win32
    return this.readAll(workspaceFileScope, paths.resolve(paths.dirname(absolute), relative), signal)
  }

  /**
   * Report one regular file's identity, version, and size without its content.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
   * @param signal - caller cancellation.
   * @returns the file's absolute path, current version, and byte size.
   */
  @Remote
  async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    return this.statOf(target, info)
  }

  /**
   * List the direct children of one directory inside the Session's workspace.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - workspace path, absolute or relative to the workspace root.
   * @param signal - caller cancellation.
   * @returns the directory's children in the backend's stable name order, bounded by the entry cap.
   */
  @Remote
  async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const { root, workspaceRoot, entry } = await this.inspect(workspaceFileScope, path, signal)
    if (entry.type !== 'directory') {
      throw new RemoteError(
        'workspace-file/not-directory',
        `"${path}" is a ${entry.type}`,
        { path, kind: entry.type },
      )
    }
    const target = await this.confine(root, workspaceRoot, path, signal)
    const children = await this.ctx.fs.listDir(target, signal)
    return {
      path: workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(target)),
      entries: children.slice(0, this.config.maxEntries).map(directoryEntry),
      truncated: children.length > this.config.maxEntries,
    }
  }

  /**
   * Stream every `fs/observed` observation of a file inside the Session's
   * workspace. Only instrumented filesystem operations report here; the OS is
   * not watched.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param signal - generation cancellation.
   * @returns `ready` once the Host observation queue is active and the workspace
   *   root is resolved, then queued and live observations in emission order.
   */
  @Remote({ mode: 'stream' })
  changes(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    return this.feed.follow(workspaceFileScope.workspaceRoot, signal)
  }

  /**
   * Create one directory inside the Session's workspace.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - the parent directory, absolute or relative to the workspace root.
   * @param name - one path segment: the new directory's name.
   * @param signal - caller cancellation.
   * @returns the created directory's metadata and workspace path; an existing entry at that name fails with `workspace-file/exists`.
   */
  @Remote
  async createDirectory(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    name: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileMutation> {
    const { workspacePath, created, workspaceRoot } = await this.childPath(workspaceFileScope, path, name, signal)
    const target = await this.ctx.fs.resolve(created, { cwd: workspaceRoot, signal })
    // One explicit segment under an existing parent never needs an ancestor
    // walk, and `recursive` would turn an occupied name into a success.
    return this.mutateOutcome(
      await this.mutation(this.ctx.fs.createDirectory(target, {}, signal), workspacePath),
      workspacePath,
      workspaceFileScope,
    )
  }

  /**
   * Create one empty file inside the Session's workspace.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - the parent directory, absolute or relative to the workspace root.
   * @param name - one path segment: the new file's name.
   * @param signal - caller cancellation.
   * @returns the created file's metadata and workspace path; an existing entry at that name fails with `workspace-file/exists`.
   */
  @Remote
  async createFile(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    name: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileMutation> {
    const { workspacePath, created, workspaceRoot } = await this.childPath(workspaceFileScope, path, name, signal)
    const target = await this.ctx.fs.resolve(created, { cwd: workspaceRoot, signal })
    return this.mutateOutcome(
      await this.mutation(this.ctx.fs.createFile(target, signal), workspacePath),
      workspacePath,
      workspaceFileScope,
    )
  }

  /**
   * Remove one entry inside the Session's workspace, or the entries one
   * directory contains.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - the entry to remove, absolute or relative to the workspace root; the root itself is refused.
   * @param options - `recursive` removes a non-empty directory with its contents;
   *   `contentsOnly` removes what the target contains and keeps the target.
   * @param signal - caller cancellation.
   * @returns the workspace path of the target whose contents were cleared, or the removed entry's.
   */
  @Remote
  async remove(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    options: WorkspaceRemoveOptions,
    signal: AbortSignal,
  ): Promise<WorkspaceFileRemoval> {
    const { root, target, workspacePath } = await this.confinePath(workspaceFileScope, path, signal)
    if (workspacePath === '' && options.contentsOnly !== true) {
      // The root is the workspace boundary itself; callers clear it through
      // `contentsOnly`, which keeps the absence of the root impossible.
      throw new RemoteError('gateway/bad-request', 'the workspace root cannot be removed', {})
    }
    if (options.contentsOnly === true) {
      const entries = await this.ctx.fs.listDir(target, signal)
      for (const entry of entries) {
        throwIfAborted(signal)
        await this.removeContained(root, entry.target, { recursive: true }, signal)
      }
      return { path: workspacePath, sessionId: workspaceFileScope.sessionId }
    }
    await this.removeContained(root, target, { recursive: options.recursive === true }, signal)
    return { path: workspacePath, sessionId: workspaceFileScope.sessionId }
  }

  /**
   * Copy one entry inside the Session's workspace, a whole subtree included.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param fromPath - the entry to copy, absolute or relative to the workspace root.
   * @param toPath - the destination path, which must not exist and must not lie inside `fromPath`.
   * @param signal - caller cancellation.
   * @returns the destination's metadata and workspace path; an existing destination fails with `workspace-file/exists`.
   */
  @Remote
  async copy(
    workspaceFileScope: WorkspaceFileScope,
    fromPath: string,
    toPath: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileMutation> {
    const { from, to, fromPath: sourcePath, toWorkspacePath } = await this.mutationPair(workspaceFileScope, fromPath, toPath, signal)
    return this.mutateOutcome(
      await this.mutation(this.ctx.fs.copy(from, to, signal), sourcePath),
      toWorkspacePath,
      workspaceFileScope,
    )
  }

  /**
   * Move one entry inside the Session's workspace, a whole subtree included.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param fromPath - the entry to move, absolute or relative to the workspace root.
   * @param toPath - the destination path, which must not exist and must not lie inside `fromPath`.
   * @param signal - caller cancellation.
   * @returns the destination's metadata and workspace path; an existing destination fails with `workspace-file/exists`.
   */
  @Remote
  async move(
    workspaceFileScope: WorkspaceFileScope,
    fromPath: string,
    toPath: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileMutation> {
    const { from, to, fromPath: sourcePath, toWorkspacePath } = await this.mutationPair(workspaceFileScope, fromPath, toPath, signal)
    return this.mutateOutcome(
      await this.mutation(this.ctx.fs.move(from, to, signal), sourcePath),
      toWorkspacePath,
      workspaceFileScope,
    )
  }

  /** Apply the page defaults and caps here, so the request never carries them implicitly. */
  private resolvePage(range: WorkspaceFileRange): { offset: number; limit: number } {
    const offset = range.offset === undefined ? 1 : integerAtLeast(range.offset, 1, 'offset')
    const limit = range.limit === undefined ? this.config.maxLines : integerAtLeast(range.limit, 1, 'limit')
    if (limit > this.config.maxLines) {
      throw new RemoteError('gateway/bad-request', `limit must be at most ${this.config.maxLines}`, {})
    }
    return { offset, limit }
  }

  /** Apply the byte-window defaults and cap; a window above the cap is refused, not shortened. */
  private resolveWindow(range: WorkspaceByteRange, path: string): { offset: number; length: number } {
    const offset = range.offset === undefined ? 0 : integerAtLeast(range.offset, 0, 'offset')
    const length = range.length === undefined ? this.config.maxBytes : integerAtLeast(range.length, 1, 'length')
    if (offset + length > Number.MAX_SAFE_INTEGER) {
      throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
    }
    if (length > this.config.maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `${length} bytes of "${path}" exceed the ${this.config.maxBytes} byte cap`,
        { path, limit: this.config.maxBytes },
      )
    }
    return { offset, length }
  }
  /**
   * Inspect the requested path itself before resolution follows its final
   * component. Directory containment is checked separately by `list`.
   */
  private async inspect(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ root: FsTarget; workspaceRoot: string; entry: FsPathInfo }> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})
    const { workspaceRoot } = workspaceFileScope
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    // Gate on the path itself before anything follows it.
    const entry = await this.ctx.fs.lstat(path, { cwd: workspaceRoot }, signal)
    if (entry === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    return { root, workspaceRoot, entry }
  }

  /** Resolve an inspected path and refuse it unless the workspace contains it. */
  private async confine(root: FsTarget, workspaceRoot: string, path: string, signal: AbortSignal): Promise<FsTarget> {
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('workspace-file/outside-workspace', `"${path}" is outside the workspace`, { path })
    }
    return target
  }

  /**
   * The workspace root and the resolved target of one existing entry. The
   * target is confined by the same rule `list` uses, so a mutation can never
   * reach outside the Session's workspace however its path is spelled.
   *
   * Separate from {@link inspect} because it also needs `root` and the
   * workspace-relative form of the target, which only the mutating verbs use.
   */
  private async confinePath(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ root: FsTarget; workspaceRoot: string; target: FsTarget; workspacePath: string }> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})
    const { workspaceRoot } = workspaceFileScope
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    const entry = await this.ctx.fs.lstat(path, { cwd: workspaceRoot }, signal)
    if (entry === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    const target = await this.confine(root, workspaceRoot, path, signal)
    return { root, workspaceRoot, target, workspacePath: workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(target)) }
  }

  /**
   * The confined destination of a copy or move, which does not exist yet. The
   * workspace path follows the caller's own spelling, because a destination
   * that is not there has no canonical form to report.
   */
  private async confineDestination(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ target: FsTarget; workspacePath: string }> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})
    const { workspaceRoot } = workspaceFileScope
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    // `resolve` realpaths the deepest existing ancestor, so a destination
    // reached through a symlinked-out directory resolves outside the workspace
    // and is refused by the containment check below.
    const target = await this.confine(root, workspaceRoot, path, signal)
    return { target, workspacePath: path.replace(/\\/gu, '/') }
  }

  /** Resolve one entry and remove it, after re-checking the fence on the target actually removed. */
  private async removeContained(
    root: FsTarget,
    target: FsTarget,
    options: { recursive: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('workspace-file/outside-workspace', `"${target.displayPath}" is outside the workspace`, { path: target.displayPath })
    }
    await this.mutation(
      this.ctx.fs.remove(target, options, signal),
      workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(target)),
    )
  }

  /** Await one backend mutation, classifying its refusal into the wire vocabulary. */
  private async mutation<T>(operation: Promise<T>, path: string): Promise<T> {
    try {
      return await operation
    } catch (error: unknown) {
      throw this.mutationRefusal(error, path)
    }
  }

  /** Everything the create verbs need: a confined parent directory and the child path inside it. */
  private async childPath(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ created: string; workspacePath: string; workspaceRoot: string }> {
    const segment = requireSegment(name, 'name')
    const parent = await this.confinePath(workspaceFileScope, path, signal)
    const parentDirectory = await this.ctx.fs.lstat(path, { cwd: workspaceFileScope.workspaceRoot }, signal)
    if (parentDirectory?.type !== 'directory') {
      const kind = parentDirectory?.type ?? 'other'
      throw new RemoteError('workspace-file/not-directory', `"${path}" is a ${kind}`, { path, kind })
    }
    // The child is built from the confined parent's PROCESS path plus one
    // validated segment, so no spelling of `name` can move the result out of
    // that parent.
    return {
      created: joinProcessPath(this.ctx.fs.processPath(parent.target), segment),
      workspacePath: joinWorkspacePath(parent.workspacePath, segment),
      workspaceRoot: workspaceFileScope.workspaceRoot,
    }
  }

  /** Both ends of a copy or move: the confined source, and a destination that is outside it. */
  private async mutationPair(
    workspaceFileScope: WorkspaceFileScope,
    fromPath: string,
    toPath: string,
    signal: AbortSignal,
  ): Promise<{ from: FsTarget; to: FsTarget; fromPath: string; toWorkspacePath: string }> {
    const source = await this.confinePath(workspaceFileScope, fromPath, signal)
    if (source.workspacePath === '') {
      throw new RemoteError('gateway/bad-request', 'the workspace root cannot be copied or moved', {})
    }
    const destination = await this.confineDestination(workspaceFileScope, toPath, signal)
    // Nesting the destination inside the source would copy the copy into
    // itself, or move a directory into its own subtree and detach it.
    if (this.ctx.fs.contains(source.target, destination.target)) {
      throw new RemoteError('gateway/bad-request', `"${toPath}" lies inside "${fromPath}"`, {})
    }
    return {
      from: source.target,
      to: destination.target,
      // The wire reports workspace paths, so a refusal names the source the
      // caller addressed rather than the backend's absolute process path.
      fromPath: source.workspacePath,
      toWorkspacePath: destination.workspacePath,
    }
  }

  /** The wire result of one create-like verb, from the backend's outcome and the workspace path it produced. */
  private async mutateOutcome(
    outcome: { target: FsTarget },
    workspacePath: string,
    workspaceFileScope: WorkspaceFileScope,
  ): Promise<WorkspaceFileMutation> {
    const info = await this.ctx.fs.stat(outcome.target)
    if (info === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${workspacePath}"`, { path: workspacePath })
    }
    const root = await this.ctx.fs.resolve(workspaceFileScope.workspaceRoot)
    return {
      ...this.statOf(outcome.target, info),
      path: workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(outcome.target)),
    }
  }

  /**
   * Classify a backend mutation refusal into the wire vocabulary. A refusal
   * this method does not recognize passes through unchanged, because a backend
   * may fail for a reason the wire has no code for.
   */
  private mutationRefusal(error: unknown, path: string): unknown {
    const code = fsErrorCodeOf(error)
    if (code === 'FS_NOT_FOUND') return new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    if (code === 'FS_ALREADY_EXISTS') return new RemoteError('workspace-file/exists', `"${path}" already exists`, { path })
    if (code === 'FS_NOT_EMPTY') return new RemoteError('workspace-file/not-empty', `"${path}" is not empty`, { path })
    if (code === 'FS_NOT_DIRECTORY') return new RemoteError('workspace-file/not-directory', `"${path}" is not a directory`, { path, kind: 'file' })
    return error
  }

  private statOf(target: FsTarget, info: FsInfo): WorkspaceFileStat {
    return {
      absolutePath: this.ctx.fs.processPath(target),
      version: info.version,
      ...info.size === undefined ? {} : { bytes: info.size },
    }
  }

  /**
   * All gates for a regular file, ending in the one stat that names its version
   * and size. The stat re-checks what `lstat` saw: the file may have gone or
   * changed kind in between.
   */
  private async locateFile(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ target: FsTarget; info: FsInfo }> {
    const { workspaceRoot, entry } = await this.inspect(workspaceFileScope, path, signal)
    if (entry.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${entry.type}`, { path, kind: entry.type })
    }
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    if (info.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${info.type}`, { path, kind: info.type })
    }
    return { target, info }
  }

  /** Stream the file as text and cut the page, classifying the backend's non-text refusal. */
  private async cutPage(target: FsTarget, offset: number, limit: number, signal: AbortSignal, path: string): Promise<Page> {
    try {
      return await cutPage(await this.ctx.fs.streamText(target, signal), offset, limit, this.config.maxBytes, path)
    } catch (error: unknown) {
      if (isNotTextRefusal(error)) {
        throw new RemoteError('workspace-file/not-text', `"${path}" is not UTF-8 text`, { path }, { cause: error })
      }
      throw error
    }
  }
}

/**
 * The backend's non-text refusal, recognized by its code alone: the error class
 * belongs to whichever `dsh-fs` instance the provider loaded, so no class
 * identity is shared across the package boundary.
 */
function isNotTextRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_NOT_TEXT'
}

export default WorkspaceFiles
