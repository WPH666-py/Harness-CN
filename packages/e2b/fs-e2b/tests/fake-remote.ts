/**
 * The in-memory E2B controller shared by the filesystem provider's suites: an
 * entry tree with the SDK methods the provider calls, plus the injection points
 * a test uses to make one boundary fail.
 */
import { Buffer } from 'node:buffer'
import { dirname, posix } from 'node:path'
import { CommandExitError, FileNotFoundError, FileType, type EntryInfo, type Sandbox } from '@deepseek-ai/dsh-e2b'
import { vi } from 'vitest'

interface RemoteNode {
  type: FileType
  data: Uint8Array
  mode: number
  modified: number
  metadata?: Record<string, string>
  symlinkTarget?: string
}

/**
 * Encode a value as the bytes an entry stores.
 * @param value - text, explicit byte values, or the buffer a byte write carries.
 * @returns the entry's bytes.
 */
export function bytes(value: string | readonly number[] | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value)
}

/**
 * Build a command failure with the exit code and stderr a real controller reports.
 * @param exitCode - the command's exit status.
 * @param stderr - the command's captured error output.
 * @returns the SDK's command error.
 */
export function commandError(exitCode: number, stderr = ''): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr, error: stderr })
}

/** An in-memory sandbox whose filesystem calls mutate {@link FakeRemote.nodes}. */
export class FakeRemote {
  readonly nodes = new Map<string, RemoteNode>()
  readonly writes: Array<{ path: string; data: string; metadata?: Record<string, string> }> = []
  readonly writeParentModes: number[] = []
  readonly renames: Array<{ from: string; to: string }> = []
  readonly links: Array<{ from: string; to: string }> = []
  readonly removals: string[] = []
  readonly commands: string[] = []
  readonly reads: Array<{ path: string; format: 'bytes' | 'stream' }> = []
  streamChunks: Uint8Array[] | undefined
  streamKeepOpen = false
  // Spelled with its own signature: the bare `vi.fn()` infers a type that
  // names vitest's internal `Procedure`, which this project cannot emit.
  readonly streamCancel = vi.fn<() => void>()
  nextCommandError: unknown
  nextMakeDirResult: boolean | undefined
  nextInfoError: unknown
  nextListError: unknown
  nextReadError: unknown
  nextRenameError: unknown
  nextRemoveError: unknown
  canonicalOutput: string | undefined
  abortAfterRename: AbortController | undefined
  competitorBeforeLink:
    | { path: string; kind: 'file'; data: string }
    | { path: string; kind: 'directory' }
    | undefined
  guardedLinkOutput: string | undefined
  disappearOnInfo = new Set<string>()
  private clock = 1

  constructor() {
    this.dir('/')
    this.dir('/workspace')
  }

  dir(path: string): void {
    // The controller's `makeDir` creates missing ancestors, so a fixture path
    // is usable as soon as it is named.
    const segments = path.split('/').filter(segment => segment.length > 0)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      if (!this.nodes.has(current)) {
        this.nodes.set(current, { type: FileType.DIR, data: bytes(''), mode: 0o755, modified: this.clock++ })
      }
    }
  }

  file(path: string, data: string | readonly number[], mode = 0o644): void {
    this.nodes.set(path, { type: FileType.FILE, data: bytes(data), mode, modified: this.clock++ })
  }

  other(path: string): void {
    this.nodes.set(path, { type: 'other' as FileType, data: bytes(''), mode: 0o600, modified: this.clock++ })
  }

  symlink(path: string, target: string): void {
    this.nodes.set(path, {
      type: FileType.FILE,
      data: bytes(''),
      mode: 0o777,
      modified: this.clock++,
      symlinkTarget: target,
    })
  }

  mutate(path: string, data: string): void {
    const node = this.required(path)
    node.data = bytes(data)
    node.modified = this.clock++
  }

  private required(path: string): RemoteNode {
    const node = this.nodes.get(path)
    if (node === undefined) throw new FileNotFoundError(`missing: ${path}`)
    return node
  }

  private followed(path: string): { path: string; node: RemoteNode; link?: RemoteNode } {
    const node = this.required(path)
    if (node.symlinkTarget === undefined) return { path, node }
    return { path: node.symlinkTarget, node: this.required(node.symlinkTarget), link: node }
  }

  private info(path: string): EntryInfo {
    if (this.disappearOnInfo.delete(path)) throw new FileNotFoundError(`missing: ${path}`)
    return this.rawInfo(path)
  }

  private rawInfo(path: string): EntryInfo {
    const followed = this.followed(path)
    const node = followed.node
    return {
      name: posix.basename(path),
      path,
      type: node.type,
      size: node.data.byteLength,
      mode: node.mode,
      permissions: 'rw-------',
      owner: 'user',
      group: 'user',
      modifiedTime: new Date(node.modified),
      ...(node.metadata !== undefined ? { metadata: { ...node.metadata } } : {}),
      ...(followed.link?.symlinkTarget !== undefined ? { symlinkTarget: followed.link.symlinkTarget } : {}),
    }
  }

  private checkAbort(options: { signal?: AbortSignal } | undefined): void {
    if (options?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
  }

  readonly sandbox = {
    sandboxId: 'fake',
    files: {
      makeDir: async (path: string, options?: { signal?: AbortSignal }): Promise<boolean> => {
        this.checkAbort(options)
        if (this.nextMakeDirResult !== undefined) {
          const result = this.nextMakeDirResult
          this.nextMakeDirResult = undefined
          return result
        }
        if (this.nodes.has(path)) return false
        this.dir(path)
        return true
      },
      getInfo: async (path: string, options?: { signal?: AbortSignal }): Promise<EntryInfo> => {
        this.checkAbort(options)
        if (this.nextInfoError !== undefined) {
          const error = this.nextInfoError
          this.nextInfoError = undefined
          throw error
        }
        return this.info(path)
      },
      read: async (path: string, options: { format: 'bytes' | 'stream'; signal?: AbortSignal }): Promise<Uint8Array | ReadableStream<Uint8Array> | string> => {
        this.checkAbort(options)
        this.reads.push({ path, format: options.format })
        if (this.nextReadError !== undefined) {
          const error = this.nextReadError
          this.nextReadError = undefined
          throw error
        }
        const data = this.followed(path).node.data
        if (options.format === 'bytes') return data.slice()
        // Pinned-SDK fidelity: a content-length-0 response returns '' even in stream format.
        if (data.length === 0 && this.streamChunks === undefined) return ''
        const chunks = this.streamChunks ?? [data.slice()]
        return new ReadableStream<Uint8Array>({
          start: (controller) => {
            for (const chunk of chunks) controller.enqueue(chunk)
            if (!this.streamKeepOpen) controller.close()
            // SDK fidelity: an abort of the request signal fails the open stream.
            options.signal?.addEventListener('abort', () => { controller.error(new DOMException('aborted', 'AbortError')) }, { once: true })
          },
          cancel: () => { this.streamCancel() },
        })
      },
      list: async (path: string, options?: { depth?: number; signal?: AbortSignal }): Promise<EntryInfo[]> => {
        this.checkAbort(options)
        if (this.nextListError !== undefined) {
          const error = this.nextListError
          this.nextListError = undefined
          throw error
        }
        this.required(path)
        return [...this.nodes.keys()]
          .filter(candidate => candidate !== path && dirname(candidate) === path)
          .map(candidate => this.rawInfo(candidate))
      },
      write: async (
        path: string,
        data: string | ArrayBuffer,
        options?: { metadata?: Record<string, string>; signal?: AbortSignal },
      ): Promise<object> => {
        this.checkAbort(options)
        const parent = dirname(path)
        if (!this.nodes.has(parent)) this.dir(parent)
        this.writeParentModes.push(this.required(parent).mode)
        this.nodes.set(path, {
          type: FileType.FILE,
          data: bytes(data),
          mode: 0o644,
          modified: this.clock++,
          ...(options?.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
        })
        this.writes.push({ path, data: typeof data === 'string' ? data : new TextDecoder().decode(bytes(data)), ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}) })
        return {}
      },
      rename: async (from: string, to: string, options?: { signal?: AbortSignal }): Promise<EntryInfo> => {
        this.checkAbort(options)
        if (this.nextRenameError !== undefined) {
          const error = this.nextRenameError
          this.nextRenameError = undefined
          throw error
        }
        const node = this.required(from)
        this.nodes.delete(from)
        this.nodes.set(to, node)
        this.renames.push({ from, to })
        this.abortAfterRename?.abort('after commit')
        this.checkAbort(options)
        return this.info(to)
      },
      remove: async (path: string): Promise<void> => {
        this.removals.push(path)
        if (this.nextRemoveError !== undefined) {
          const error = this.nextRemoveError
          this.nextRemoveError = undefined
          throw error
        }
        for (const candidate of this.nodes.keys()) {
          if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate)
        }
      },
    },
    commands: {
      run: async (
        command: string,
        options?: { envs?: Record<string, string>; signal?: AbortSignal },
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        this.checkAbort(options)
        const home = options?.envs?.HOME
        if (home === undefined || !/^\/\.dsh-e2b-control-/.test(home)) {
          throw new Error(`unexpected control environment: ${String(home)}`)
        }
        this.commands.push(command)
        if (this.nextCommandError !== undefined) {
          const error = this.nextCommandError
          this.nextCommandError = undefined
          throw error
        }
        const realpathPrefix = 'set -o pipefail; realpath -mz -- '
        const realpathSuffix = ' | base64 -w0'
        if (command.startsWith(realpathPrefix) && command.endsWith(realpathSuffix)) {
          const quoted = command.slice(realpathPrefix.length, -realpathSuffix.length)
          const input = quoted.slice(1, -1).replaceAll(String.raw`'"'"'`, '\'')
          const node = this.nodes.get(input)
          const canonical = `${node?.symlinkTarget ?? input}\0`
          return {
            exitCode: 0,
            stdout: this.canonicalOutput ?? Buffer.from(canonical).toString('base64'),
            stderr: '',
          }
        }
        const chmod = /^chmod ([0-7]+) -- '([^']+)'$/.exec(command)
        if (chmod !== null) this.required(chmod[2]!).mode = Number.parseInt(chmod[1]!, 8)
        const guardedLink = new RegExp(
          "^if ln -T -- '([^']+)' '([^']+)'; then printf created; "
          + "elif test -e '[^']+' \\|\\| test -L '[^']+'; then printf exists; else exit 1; fi$",
        ).exec(command)
        if (guardedLink !== null) {
          const from = guardedLink[1]!
          const to = guardedLink[2]!
          if (this.guardedLinkOutput !== undefined) {
            const stdout = this.guardedLinkOutput
            this.guardedLinkOutput = undefined
            return { exitCode: 0, stdout, stderr: '' }
          }
          if (this.competitorBeforeLink?.path === to) {
            if (this.competitorBeforeLink.kind === 'directory') this.dir(to)
            else this.file(to, this.competitorBeforeLink.data)
            this.competitorBeforeLink = undefined
          }
          if (this.nodes.has(to)) return { exitCode: 0, stdout: 'exists', stderr: '' }
          this.nodes.set(to, this.required(from))
          this.links.push({ from, to })
          this.abortAfterRename?.abort('after commit')
          return { exitCode: 0, stdout: 'created', stderr: '' }
        }
        const move = /^mv -f -- '([^']+)' '([^']+)'$/.exec(command)
        if (move !== null) {
          if (this.nextRenameError !== undefined) {
            const error = this.nextRenameError
            this.nextRenameError = undefined
            throw error
          }
          const node = this.required(move[1]!)
          this.nodes.delete(move[1]!)
          this.nodes.set(move[2]!, node)
          this.renames.push({ from: move[1]!, to: move[2]! })
          this.abortAfterRename?.abort('after commit')
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Sandbox
}
