# Agent Note: Workspace file mutations

Status: implemented

English | [中文](2026-09-10-workspace-file-mutations.zh.md)

## Problem

Workspace Files can read a file but cannot change one. A file manager in the web GUI needs to create a directory or an empty file, remove an entry, copy a subtree, and move or rename one, and no Host verb and no filesystem primitive exists for any of them: the `FileSystem` service definition exposes `writeText`, `writeBytes`, and `editText` only, so a mutation that is not a whole-content write has no implementation to call.

The operations also raise a policy question the read path never had to answer. [Workspace file read authority](2026-09-09-workspace-file-read-authority.md) decided that reads inherit the Session filesystem backend's authority, so a preview may name a file outside the workspace. A removal or a move that behaved that way would let the client delete or relocate files the Session may only read.

## Decision

The `@deepseek-ai/dsh-fs` service definition adds five operations: `createDirectory`, `createFile`, `remove`, `copy`, and `move`. Each takes an `FsTarget` resolved by `resolve()`, an optional options object, an optional trailing `AbortSignal`, and an optional per-call `SandboxExecutionPolicy`, and each returns an outcome naming the kind of entry it produced or removed.

The `FsErrorCode` set gains two members. `FS_ALREADY_EXISTS` reports an occupied destination for a create, a copy, or a move; the existing `FS_NOT_OBSERVED` means a guarded write onto an unread file and `FS_STALE_VERSION` means a version the caller held has moved, so neither expresses a plain destination conflict. `FS_NOT_EMPTY` reports a directory removal without `recursive` that found entries beneath the target. Folding either into `FS_IO_ERROR` would leave every caller matching message text.

The catalog decides four contracts. A create whose destination is occupied fails rather than merging or overwriting. `copy` and `move` require an absent destination. `remove` removes a non-empty directory only with `recursive`, and a symbolic link at the target is refused rather than unlinked. A move within one filesystem is one rename; across two it is a copy followed by a removal of the source, which is not atomic and may leave the source in place when the removal fails. That last fact is stated in the JSDoc and in every provider README, because it is the one outcome a caller cannot retry blindly.

`dsh-fs-local` implements all five over `node:fs/promises` in `src/fsio.ts`, including a recursive copy that reproduces links as links instead of following them, so a link inside a copied subtree cannot pull content in from outside it. A test hook overrides the rename boundary, which is how the cross-device fallback is covered without a second mounted filesystem.

`dsh-fs-sandbox` fences every one of the five. Containment applies to the entry a removal removes, to the destination of a copy, and to BOTH ends of a move: without the source check a move would be a way to delete an entry the policy protects, and a move into the workspace would import one from outside it. All ends of a multi-ended operation are re-canonicalized and checked before any of them is returned, so a two-ended move never starts with one end validated.

`dsh-fs-e2b` maps the five onto the controller's `makeDir`, `write`, `remove`, and `rename`, building the cross-device fallback from a read-and-write walk. E2B exposes only a recursive directory create, so the non-recursive case verifies the parent and the existing target before delegating, and a non-recursive removal of a non-empty directory is refused from a listing the provider takes itself rather than from the controller's error text.

The Host `WorkspaceFiles` service adds `createDirectory`, `createFile`, `remove`, `copy`, and `move` as Typert Remote verbs over the same `workspaceFiles` namespace and the same `workspaceFileScope` lookup the read verbs use. Every one is workspace-contained: the Session's workspace root is resolved from that lookup, the target is resolved against it, and the answer must satisfy `ctx.fs.contains(root, target)`. Containment reuses the predicate `list` already used, so the service has one containment mechanism rather than two. A path outside the root is refused with the existing `workspace-file/outside-workspace`, and the two new backend codes map to `workspace-file/exists` and `workspace-file/not-empty`.

A create names a parent directory plus one path segment. The segment must match `^[^/\\]+$`, must not be `.` or `..`, and must carry no surrounding whitespace; the child path is then built from the confined parent's process path and that segment. Validating the segment before the join is what keeps a name from reaching a parent directory, another volume, or a `..` escape, and it holds on both path conventions because the wire never says which platform the other end runs. `copy` and `move` refuse a destination that the confined source contains, which would otherwise copy a subtree into itself or detach a moved directory from its own parent.

The three refusal paths the Client branches on are `gateway/bad-request` for a malformed name, a malformed path, the workspace root as a copy or move source, and a destination nested inside its own source; `workspace-file/outside-workspace` for anything that resolves outside the root; and the two new codes above.

## Alternatives considered

**Expose one generic `mutate` verb with a discriminated operation field.** A single verb would put a four-arm discriminant on the wire and make every caller's parameters optional, when the five operations share no arguments beyond the path. Five verbs keep each argument list required and each error mapping local.

**Reuse `writeBytes` for `createFile`.** Creating an empty file is a legitimate guarded write (`createIfAbsent` with empty content), but it cannot be a Remote verb unless the client also sends content and an intent, and the file manager's contract is "create this name, fail if it is taken". A distinct `createFile` states that contract once, in the operation that enforces it.

**Contain reads the way mutations are contained, for symmetry.** Rejected by the read-authority decision above, whose consumer — previewing a file the Session may read — is unaffected by these verbs. The asymmetry is the point: navigation and mutation describe the workspace, a named read does not.

**Let a copy merge into an existing destination directory, as `cp -r` does.** Merging makes the outcome depend on what was already there, so a partial failure is indistinguishable from a successful merge, and the Client cannot tell the user what changed. An occupied destination is refused, and the caller decides whether to remove it first.

**Follow symlinks inside a copied subtree on the local provider.** Following would copy the target's content and produce a tree whose content came from outside the copied root, which is exactly what a workspace-confined caller must not receive. Links are reproduced as links.

## Consequences

The filesystem seam is no longer read-plus-whole-file-write; a new backend must implement five more members, and the abstract class makes that a compile error rather than a silent gap. Four test fakes outside these packages had to implement them as well.

A cross-device move is not atomic, and a copy is not atomic over a subtree. The JSDoc states both, and `remove` is documented as one operation that either completes or fails, with a failed recursive removal able to leave the subtree partially removed. No backend can undo entries it already deleted, so the alternative was a rollback promise the filesystem cannot keep.

`WorkspaceFiles.remove` refuses the workspace root itself. Clearing the root is `contentsOnly`, which removes what the root contains and keeps the root, so the Session's workspace root cannot be deleted through this service.

The three provider READMEs and the two package READMEs state the operation set, the two new codes, and the non-atomic move. The `dsh-fs` README no longer says the seam has thirteen primitives with no delete, rename, or copy.

## Related

- [Workspace file mutation gestures](2026-09-10-workspace-file-mutation-gestures.md) — the file tree's create, delete, copy, cut, and paste gestures over these verbs, and the Session-header control that opens the tree.
