---
description: "The right Sidebar's file-tree tab type for the dsh web client: the session workspace root listed one level at a time over the wire, opening files into the Sidebar by resource address and creating, removing, copying, or moving entries."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

English | [中文](README.zh.md)

## Summary

The right Sidebar's navigator tab type: the session's workspace root as a tree, listed one level at a time over the wire, opening files into the Sidebar, and the file operations a file manager adds on top of that listing. It is a page type reached from the guide and claims no address; it opens files by address for the `dsh-resource://file` viewers to claim — nothing in `ui-sidebar-right` knows this package.

## Table of Contents

- [What it registers](#what-it-registers)
- [The tree](#the-tree)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `files`, id `@deepseek-ai/dsh-client-ui-sidebar-files`, band `builtin`, no patterns, and one guide entry (order 10, its title and description from the `sidebarFiles` namespace, its glyph the shared folder icon) that opens the type.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: a header row under the strip, then the tree. The header row is the document preview's (`ui-sidebar-documentpreview`): the root path, its directories greyed and its last segment in full ink, never ellipsized (a path wider than the row keeps its end and fades its start), with the file operations and reload at its right. The row is copied rather than shared because a plugin bundle shares runtime code only through the platform modules; once the artifact and slot surfaces settle, one copy in `ui-primitives` could serve every pane header.
- **The chip title** — the keyed `sidebar.right.pane.tab.title` seat under that id: a shared `FileTypeIcon` folder glyph at 16px before the type's label. The tree's own rows never draw this sheet.
- **The header control** — the list-addressed `conversation.session.header.utilities` seat under id `workspace-files`: `FilesToggleAction`, one glyph that opens the tree into the right column, or folds the column away when the file tree is already the tab it shows. The column's own service is read when the gesture happens, so the control keeps no state.

Eight source files under `src/client/`: `definition.tsx` (the type), `store.ts` (what it keeps), `face.ts` (how it lists and changes entries, Remote binding included), `FilesBody.tsx` (what it draws, with its ordering, failure-line, and destination helpers), `FilesTitle.tsx` (the chip title), `FilesToggleAction.tsx` (the Session-header control), `locales.ts` (what it says), and `index.ts` (the wiring).

<a id="the-tree"></a>
## The tree

The root is the session's working directory, read from `useSessions().byId[sessionId].cwd`, and split for the header row by `pathPartsOf` from `@deepseek-ai/dsh-util-workspace-path`. Every level is keyed by absolute path; a child's path is its parent's joined with the entry name by `/`. A level is listed when it is first expanded, through `remote.workspaceFiles.list(sessionId, absolutePath)` on the `@deepseek-ai/dsh-api-workspace-files` namespace; the adapter keeps the listing's entries and truncation flag and drops its workspace-relative path. Rows are ordered directories first, then by natural, case-insensitive name; dotfiles are shown like any other entry.

| Entry type | Row |
|---|---|
| `directory` | Toggles; the level is fetched the first time it opens and kept while collapsed. |
| `file` | Opens `dsh-resource://file/session/<sessionId>/<encoded path relative to the root>`, built by `fileAddressFor` from `@deepseek-ai/dsh-util-workspace-path` from the entry's absolute path and the tree's root, through `useTabInfo().tab.actions.openResource`, landing in the tab's own pane. |
| `other` | Shown greyed and not clickable, so the directory is reported whole. |

A level cut by the endpoint's entry cap ends with a marker; an empty level says so; a level that failed shows one line per code — `workspace-file/not-found`, `outside-workspace`, `not-directory` — and the transport's own message otherwise. Reload drops every listed level and asks again for the expanded ones; collapsed levels are fetched again when they next open. A session without a working directory shows a single line instead of a tree.

The rows are a file manager's too: the reader selects one row, and the header's controls act on that selection — the directory it names when it is a directory, and the tree's root when it is a file or nothing. A right-click opens the same operations on that one row: open (open or toggle), copy, cut, paste (directories only), and delete. New shows an inline name input under the parent directory, committing on Enter and cancelling on Escape or focus leaving; the input stays open until the Host accepts the name, so a refused name keeps what the reader typed. Delete asks for confirmation in the pane before it calls the Host, and a directory goes with everything inside it.

A create, a delete, and a paste each name their own destination: a created entry lands under the chosen directory, a removed entry is named by its row, and a paste places the source's basename there. The Host refuses a destination that already exists, so nothing is overwritten or merged, and a paste that lands re-lists what it changed — the destination, and the directory a cut left. A landed cut releases the clipboard and forgets the removed subtree's levels, expansion, and selection; a copy stays on the clipboard. A refused gesture shows its line above the tree — `workspace-file/exists`, `workspace-file/not-empty`, `workspace-file/not-found` — instead of doing nothing.

State lives in the type's own store, bucketed by tab id: `root`, `levels` (loading / ready / failed per absolute path), `expanded`, the reader's `selected` row, the `clipboard` the next paste places, the `draft` name input, and the last gesture's `notice`. The owner's `signal` ends a bucket: on abort the tab is forgotten and a listing or a mutation that settles afterwards writes nothing.

<a id="model-experience"></a>
## Model Experience

None, as this package draws a workspace file tree in the browser and registers nothing model-facing.

#### KV Cache effect

None; directory listings travel over the Remote and assemble no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Listing and file operations only.** No search, artifact filter, drag-and-drop, rename, highlight of the file the viewer is showing, or filesystem watching; a level changes only through reload or a gesture this pane performed.
- **One root.** The tree is rooted at the session's working directory; there is no way to browse above it, and the Host refuses paths outside the workspace root anyway.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The tree's only runtime state is one Slot store per tab, written by the body that owns it and forgotten on the tab's abort signal; there is no second observation of it to compare against.
