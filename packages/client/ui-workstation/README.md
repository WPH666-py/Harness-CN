# @deepseek-ai/dsh-client-ui-workstation

The document-workspace seat: a file tree beside a file viewer, in the frame's
first column, opened and closed from the Conversation header.

## What it does

One control in `conversation.session.header.utilities` — the row that already
holds the folder button — swaps the frame between two presentations:

| Presentation | Column 1 | Centre | Column 3 |
| --- | --- | --- | --- |
| conversation (default) | sidebar | Conversation | rightbar |
| workstation | file tree + viewer | Conversation | hidden |

The Centre never changes occupants. `ui-layout` only changes which grid tracks
are laid out (`display: none` on the columns it steps aside, never unmount), so
the Conversation keeps its draft and its scroll position across the toggle in
both directions.

## Persistence

The mode is **in-memory**: it lives in `layoutInfo.workstation`, part of the
same layout store that already holds the sidebar and rightbar sizes, and it is
gone after a reload.

That is deliberate. Persisting it would need a new surface (a saved-layout row
or a preference key) which this package does not own, and the mode is a
per-session working posture rather than a global preference — coming back to a
full-width editor after a restart is more surprising than coming back to the
conversation. If the frame ever grows a real saved-layout surface, this flag
belongs in it unchanged.

## Files fetched

- Tree levels: `remote.workspaceFiles.list(sessionId, path, signal)`.
- File pages: `remote.workspaceFiles.read(sessionId, path, { offset: lines }, signal)`.

Paths are workspace-relative (`''` is the workspace root), which is how the
Remote API addresses them, so the seat never needs the Session's absolute
working directory.

Every list and read is generation-guarded per path: a newer request for the same
path retires the in-flight one, so a fast click never paints an older answer.

## Not here

No virtualisation, no syntax highlighting, no editing, no drag-resize. Lines are
a `<pre>`-shaped list with a gutter; the tree is a flat per-level list. The seat
is a reader, and the pieces it would need to become an editor belong to other
packages.
