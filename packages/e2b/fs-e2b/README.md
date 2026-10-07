---
description: "File operations inside the shared remote sandbox: what the agent can do with files there, when to use it, and what to expect — for deployments and maintainers of the E2B family."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-e2b

English | [中文](README.zh.md)

## Summary

`dsh-fs-e2b` runs the agent's file operations inside the remote sandbox: read files, list directories, write, overwrite or edit, create directories, remove entries, copy subtrees, move or rename entries, and read accurate metadata — all in the same remote world where its commands run. It needs no configuration: mounting it moves file work off the host. Use it with `dsh-e2b` and `dsh-subprocess-e2b` so files and commands share one remote working directory. The host's files are never touched, and results reach the model as local file results do. Choose the local filesystem package when files should live on the host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the agent's file work — reading, writing, editing, listing — should happen inside the remote sandbox rather than on your machine. It is the filesystem half of the E2B family: what the agent writes here is what its commands can read in the same sandbox.

### When to choose it

Choose it when a composition already uses the E2B sandbox and you want file operations to run there. Choose the local filesystem package when files should stay on the host. There is no configuration to tune.

### Mounting it

Load the sandbox owner first, then this package; after that, file features operate on the sandbox:

```yaml
- name: '@deepseek-ai/dsh-e2b'
- name: '@deepseek-ai/dsh-fs-e2b'
```

Mounting it does not copy or mirror your local files — the sandbox's working directory starts empty and fills as the agent works.

### Reading files

The agent can read a file's whole contents, stream large files, or read raw bytes up to a size cap or as one byte window. Binary files and files that are not valid UTF-8 text are refused with a clear message instead of being garbled; reads past the size cap fail with a message naming the limit.

### Writing and editing files

The agent can create files, overwrite them, or edit them by replacing a literal piece of text (optionally every occurrence), and can ask for a file to be created only if it does not exist yet. A write lands completely or not at all — a failed write never leaves a partial file. If the file changed since the agent last read it, the write is refused rather than clobbering the newer content, so two processes cannot overwrite each other's work unseen.

### Creating, removing, copying, and moving

The agent can create a directory or an empty file, remove a file or a directory, copy a file or a whole subtree, and move or rename one. A create, a copy, or a move whose destination is occupied is refused and changes nothing. A directory removal without `recursive` is refused when the directory still has entries. A copy reproduces a link as a link instead of following it, so nothing outside the copied subtree is pulled in. A move inside one remote filesystem is one rename; when the source and the destination are on different filesystems the sandbox copies the subtree and then removes the source, so the destination is complete before the source is touched and a failure of that removal leaves both present.

### Paths in the sandbox

Relative paths resolve against the caller's working directory or the sandbox's shared working directory, and are reported as the POSIX paths they are in the sandbox — what the agent reads and writes matches exactly what its commands see.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One remote world.** Paths and contents stay in the sandbox; the host workspace is never copied, mounted, or reconciled.
- **Atomic publication.** Every mutation commits through same-filesystem rename or a guarded link, and the returned version comes from the committed entry, so no fallible metadata request follows the commit point.
- **Strict transport framing.** Canonical paths and contents cross the SDK as ASCII base64 with NUL framing, so newline and multibyte data survive arbitrary decoding boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `E2BFileSystem` provider, canonicalization, reads, atomic writes, the create/remove/copy/move operations, error mapping |
| — | No runtime invariant companion is published; each operation returns the E2B controller's committed result directly, with no independent event or cache to cross-check. |

### Canonical paths and transport framing

Relative paths resolve as POSIX paths against the caller `cwd` or `ctx.e2b.cwd`; GNU `realpath -mz` supplies canonical target identity without requiring the final file to exist, and ASCII base64 plus strict NUL framing preserves newline and multibyte paths across the decoded SDK transport. `stat`, no-follow `lstat`, and stable one-level directory listings project E2B metadata into the seam; canonical targets expose absolute POSIX process paths, percent-encoded `file:` URIs, and provider-owned containment checks.

### Write path

Writes create a random sibling staging directory, set it to mode `0700` before uploading content, and preserve an existing file's POSIX mode; replacements publish through E2B's same-filesystem atomic rename, and a guarded `createIfAbsent` publishes with `ln -T` so the commit is atomically no-replace even when a directory appears at the destination. The `dsh-version` extended attribute plus the committed entry's metadata form the returned version; literal edits LF-normalize for matching and restore the dominant CRLF style, and mutations serialize per canonical target. Staging-cleanup failures after commit never turn a successful write into a failure.

### Failure and cancellation

E2B not-found, permission, abort, and other controller failures map to the existing `FsError` codes (`FS_NOT_FOUND`, `FS_PERMISSION_DENIED`, `FS_ABORTED`, `FS_IO_ERROR`), while text and byte reads add `FS_NOT_TEXT` and `FS_TOO_LARGE`. Cancellation is checked at SDK request boundaries and immediately before publication, but the signal is never forwarded into the rename or guarded-link commit, so cancellation cannot interrupt atomic publication or turn a committed write into a reported failure.

### Path-changing operations

The controller exposes only a recursive directory create, so `createDirectory` without `recursive` verifies the parent and the target itself before delegating, and an occupied target is `FS_ALREADY_EXISTS` rather than a controller error. `createFile` probes first and then writes empty content, so an occupied name is refused without replacing anything. `remove` decides a non-recursive directory removal from a listing the provider takes itself, which keeps `FS_NOT_EMPTY` from depending on how the controller phrases a recursive remove. `copy` walks the source with the same one-level listing the provider uses elsewhere, creates each directory through `makeDir`, uploads each regular file as bytes, and recreates each link with `ln -s` instead of following it. `move` is the controller's `rename`; when the controller reports a cross-device failure the provider copies the subtree and then removes the source, and any other rename failure is mapped and propagated with the source untouched.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the family composition to the filesystem seam surface and the tools that render it.

- [E2B provider family map](../README.md) — the sandbox owner and the three-package composition.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — the filesystem seam contract and the generated Cordis surface.
- [Filesystem provider contract](../../fs/fs/README.md) — the `FileSystem` interface this provider implements.
- [File tools](../../fs/tool-fs/README.md) — the tools that render filesystem results to the model.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-fs`](../../fs/tool-fs/README.md), which renders remote UTF-8 content, directory results, mutation acknowledgements, and provider errors while E2B identity and transport remain internal.

#### KV Cache effect

No direct invalidation: `dsh-tool-fs` owns any request-prefix changes; the E2B transport never reaches a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No host synchronization** — an empty E2B cwd stays empty until a tool, command, or external process populates it; local files are neither uploaded nor reflected back.
- **Mutation coordination is host-process-local** — `createIfAbsent` preserves a remote creator racing publication, but another harness connection or command can still race replacement; version guards detect only metadata changes represented by E2B.
- **Reads reopen canonical targets by path** — a concurrent remote path replacement between resolution and stream opening is not fenced by a stable file handle; no observed product defect justifies a provider-specific bounded-read protocol in this POC.
- **Whole-file mutation costs remain** — overwrite diffs and literal edits read complete files into host memory, and every operation incurs E2B controller latency.
- **The POC targets E2B's default Linux image** — it relies on GNU `realpath`/`base64`/`chmod`, same-filesystem rename, streaming reads, and metadata extended attributes; custom templates are outside this POC.
- **The controller exposes no non-recursive directory create** — `createDirectory` therefore decides the non-recursive case with its own probes, and the recursive case delegates the whole ancestor walk to the sandbox.
- **A cross-device move and a subtree copy are not atomic** — a move that cannot rename copies and then removes the source, and a copy uploads entry by entry, so either can leave a partial or doubled result that the caller must reconcile.
- **Cross-device detection reads the controller's message** — the pinned SDK exposes no distinct error class for a cross-filesystem rename, so the provider recognizes it from the failure text; a template that rephrases that message would fall back to the copy path only if the text still names the condition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
