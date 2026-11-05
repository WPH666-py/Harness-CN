# @deepseek-ai/dsh-client-ui-workstation

The document-workspace seat: a file tree beside a multi-tab file editor, in the
frame's first column, opened and closed from the Conversation header.

## What it does

One control in `conversation.session.header.utilities` — the row that already
holds the folder button — swaps the frame between two presentations:

| Presentation | Column 1 | Centre | Column 3 |
| --- | --- | --- | --- |
| conversation (default) | sidebar | Conversation | rightbar |
| workstation | file tree + editor | Conversation | hidden |

The Centre never changes occupants. `ui-layout` only changes which grid tracks
are laid out (`display: none` on the columns it steps aside, never unmount), so
the Conversation keeps its draft and its scroll position across the toggle in
both directions.

## Editing

Opening a file from the tree adds a tab (or focuses the tab already open for
that path). Each tab is named for the file's basename and carries a close
button; the tree keeps the Session's working directory as its root — or, while a
remote server is current, that server's `/` — and at most eight tabs stay open —
when a ninth arrives, the oldest clean tab is closed first, while a tab with
unsaved edits is never evicted.

The active tab is a plain `<textarea>` under a line-number gutter: monospace, two
spaces per Tab insertion, no autoformatting and no syntax highlighting. Lines
never wrap — a long line scrolls inside the editor, and the gutter stays pinned
to the left and scrolls only vertically — and a translucent band marks the line
holding the caret, following clicks, arrow keys, selections, and scrolling.
`dirty` means the buffer differs from the last saved copy.

- **Ctrl/Cmd+S** saves the active tab.
- **The close button saves first.** Closing a dirty tab calls the write verb and
  only drops the tab once the host accepts it; a refused write keeps the tab open
  and prints the failure in the tab's status line, so a click on `×` can never
  lose the buffer. A clean tab closes at once.
- **Image preview.** For `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`
  and `.avif`, the viewer reads the file's bytes and draws them with
  `object-fit: contain`; the header shows the file's size. The blob URL is
  created when the image tab becomes active and revoked when it closes.
- **A file that is not UTF-8 still opens.** The text verb refuses anything that is
  not UTF-8, so the viewer falls back to the byte verb and decodes the bytes
  itself: a byte order mark names UTF-8, UTF-16LE, or UTF-16BE; without one,
  strict UTF-8 is tried, then strict GB18030. UTF-8 stays editable; a UTF-16 or
  GB18030 tab opens read-only, with the header naming the encoding, because the
  write verb only reproduces UTF-8. Bytes no encoding accepts — or bytes carrying
  a NUL outside a UTF-16 byte order mark — are binary: the tab shows the file's
  size instead of an editor and still closes like any other.

Tabs, buffers, and the active tab live in the in-memory store beside the tree
levels: a reload starts from an empty strip. Nothing is written except through
the explicit save gestures above.

## A remote server

The seat follows the server manager instead of keeping its own idea of the
target. `remote.ts` polls `GET /remote-ssh-ops/v1/hosts` every two seconds while
the seat is mounted and publishes `{ currentHostId, hosts }`; a failed poll is
dropped, never shown, because the server manager is where an unreachable host is
dealt with.

While a host is current — the 使用 button in the 「服务器管理」 window makes it
current — both panes switch to it. The tree hangs from `/`, levels come from
`GET /hosts/:id/files?path=`, the viewer reads `GET /hosts/:id/file?path=`, and a
save is `PUT /hosts/:id/file` carrying the version the read reported as
`expected_version`, so a file someone else changed is refused instead of
overwritten. The local workspace is not shown beside it. Clearing the current
host in that window brings the workspace back on the next poll; with no Session
open either, the seat asks for a Session again.

The tree header grows a magnifier while a server is current. It opens an input,
waits 250 ms after the last keystroke, and asks
`GET /hosts/:id/search?q=&root=` for files whose *name* contains the query. The
answer is a flat list of absolute paths, each row showing its directory, and a
click opens the file in the viewer. Escape — or the button again — clears the
search and restores the tree. Local workspaces get no search control: the
`workspace-files` verb set has no search operation in this build.

These calls are plain same-origin `fetch` against the plugin's routes. Importing
the plugin's client module would make this package depend on another feature
plugin's values, which the client package rules forbid. Every failure — a host
that stopped answering, a route that refused, a body this package cannot read —
lands in the pane that asked for it, in the copy the locale owns.

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
- Text files: `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`,
  paged to the end of the file and joined into one buffer.
- Bytes: `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)`, for an
  image or for a text read the text verb refused as not UTF-8.
- Saves: `remote.workspaceFiles.write(sessionId, path, text, signal)`.
- With a server current: `GET /remote-ssh-ops/v1/hosts/:id/files`,
  `GET …/file`, `PUT …/file`, and `GET …/search` on the same origin, through
  `remote.ts`.

Paths are workspace-relative (`''` is the workspace root), which is how the
Remote API addresses them, so the seat never needs the Session's absolute
working directory.

Every list, read, and byte read is generation-guarded per path: a newer request
for the same path retires the in-flight one, so a fast click never paints an
older answer. Saves are guarded the same way, per path.

`write` is declared structurally in this package's Remote slice: it is part of
the editor's contract even on a host build whose generated verbs do not carry it
yet. On such a host the call throws, and the tab's status line reports that the
save failed instead of pretending it succeeded.

## Not here

No virtualisation, no syntax highlighting, no autoformatting, no bracket
matching. The editor is a textarea over the whole file; the tree is a flat
per-level list. Files larger than one read page arrive as joined pages, and the
seat holds the whole buffer in memory.
