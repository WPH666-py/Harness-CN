/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section, and the path-changing
 * operations — are the local implementation's, verbatim; this package adds only
 * the per-call POLICY fence on the mutations. Reads pass through untouched:
 * every mode permits reading.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. This is containment, not a security
 * boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job
 * (`@deepseek-ai/dsh-bash-sandbox`). The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area from the shared `writableRoots` policy;
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED`. An operation with two ends — copy and move — is fenced
 * on both of them, so neither end can reach outside the writable roots: a
 * removal and a move may not delete or relocate something the policy does not
 * cover, and a copy may not write outside it.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsByteWriteOutcome,
  FsCopyOutcome,
  FsCreateDirectoryOptions,
  FsCreateOutcome,
  FsEditOutcome,
  FsEditRequest,
  FsMoveOutcome,
  FsRemoveOptions,
  FsRemoveOutcome,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the byte write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content, written verbatim.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsByteWriteOutcome> {
    return super.writeBytes(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Fence the creation by the per-call policy, then delegate to the inherited
   * `mkdir`. See {@link checkedTarget}.
   * @param target - the resolved directory target to create.
   * @param options - whether missing ancestors are created as well.
   * @param signal - aborts before the directory is published.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the creation outcome from the inherited backend.
   */
  override async createDirectory(
    target: FsTarget,
    options?: FsCreateDirectoryOptions,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsCreateOutcome> {
    return super.createDirectory(await this.checkedTarget(target, sandboxPolicy), options, signal)
  }

  /**
   * Fence the creation by the per-call policy, then delegate to the inherited
   * exclusive create. See {@link checkedTarget}.
   * @param target - the resolved file target to create.
   * @param signal - aborts before the file is published.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the creation outcome from the inherited backend.
   */
  override async createFile(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsCreateOutcome> {
    return super.createFile(await this.checkedTarget(target, sandboxPolicy), signal)
  }

  /**
   * Fence the removal by the per-call policy, then delegate to the inherited
   * removal. A removal is fenced on the entry it removes, so it can never
   * delete anything the policy does not cover, and `recursive` cannot widen
   * that: the fence decides the root of the removal, not its depth.
   * @param target - the resolved file or directory target to remove.
   * @param options - whether a non-empty directory is removed with its contents.
   * @param signal - aborts before the removal starts.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the removal outcome from the inherited backend.
   */
  override async remove(
    target: FsTarget,
    options?: FsRemoveOptions,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsRemoveOutcome> {
    return super.remove(await this.checkedTarget(target, sandboxPolicy), options, signal)
  }

  /**
   * Fence both ends by the per-call policy, then delegate to the inherited
   * copy. Containment applies to the DESTINATION, which is the only end this
   * operation writes; the source is merely read, and reads pass through
   * untouched in every mode.
   * @param from - the resolved source target.
   * @param to - the resolved destination target, which must not exist.
   * @param signal - aborts between entries of a directory copy.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the copy outcome from the inherited backend.
   */
  override async copy(
    from: FsTarget,
    to: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsCopyOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    this.deniedByMode(policy.mode, to)
    const [checkedFrom, checkedTo] = await this.containedPair(from, to, policy)
    return super.copy(checkedFrom, checkedTo, signal)
  }

  /**
   * Fence BOTH ends by the per-call policy, then delegate to the inherited
   * move. The source end is fenced as well because a move removes it: without
   * that check, a move would be a way to delete an entry the policy protects,
   * and a move into the workspace would import one from outside it.
   * @param from - the resolved source target.
   * @param to - the resolved destination target, which must not exist.
   * @param signal - aborts between entries of a cross-filesystem fallback copy.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the move outcome from the inherited backend.
   */
  override async move(
    from: FsTarget,
    to: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    this.deniedByMode(policy.mode, from)
    const [checkedFrom, checkedTo] = await this.containedPair(from, to, policy)
    return super.move(checkedFrom, checkedTo, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    this.deniedByMode(policy.mode, target)
    const [checked] = await this.containedTargets([target], policy)
    /* v8 ignore next 3 -- containedTargets answers one checked target per input, so a short result is a defect in this file */
    if (checked === undefined) {
      throw new Error('fs-sandbox: containedTargets returned fewer targets than it was given')
    }
    return checked
  }

  /**
   * The two checked ends of a copy or a move, as a pair the caller can destructure.
   * @param from - the resolved source target.
   * @param to - the resolved destination target.
   * @param policy - the per-call mode and workspace root.
   * @returns both targets, re-canonicalized and contained.
   */
  private async containedPair(
    from: FsTarget,
    to: FsTarget,
    policy: SandboxExecutionPolicy,
  ): Promise<[FsTarget, FsTarget]> {
    const [checkedFrom, checkedTo] = await this.containedTargets([from, to], policy)
    /* v8 ignore next 3 -- containedTargets answers one checked target per input, so a short result is a defect in this file */
    if (checkedFrom === undefined || checkedTo === undefined) {
      throw new Error('fs-sandbox: containedTargets returned fewer targets than it was given')
    }
    return [checkedFrom, checkedTo]
  }

  /** Refuse the mutation outright when the effective mode permits none. */
  private deniedByMode(mode: SandboxMode, target: FsTarget): void {
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
  }

  /**
   * Re-canonicalize every target NOW and require each to sit under a writable
   * root. All targets are checked before any is returned, so a two-ended
   * operation never starts with one end already validated and the other not.
   * `danger-full-access` returns the caller's targets unfenced.
   */
  private async containedTargets(
    targets: readonly FsTarget[],
    policy: SandboxExecutionPolicy,
  ): Promise<FsTarget[]> {
    if (policy.mode === 'danger-full-access') return [...targets]
    const roots = writableRoots(policy)
    const checked: FsTarget[] = []
    for (const target of targets) {
      // workspace-write: containment on the FRESH canonical path (catches a
      // symlink ancestor swapped since the tool resolved this target), and the
      // mutation delegates with THIS fresh target — never the stale one.
      const fresh = await this.resolve(target.displayPath)
      let contained = false
      for (const root of roots) {
        if (await isPathUnder(fresh.targetKey, root)) {
          contained = true
          break
        }
      }
      if (!contained) {
        throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
      }
      checked.push(fresh)
    }
    return checked
  }
}

export default SandboxedFileSystem
