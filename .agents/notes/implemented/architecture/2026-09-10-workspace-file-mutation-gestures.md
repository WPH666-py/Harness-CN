# Agent Note: Workspace file mutation gestures

Status: implemented

English | [中文](2026-09-10-workspace-file-mutation-gestures.zh.md)

## Problem

The Host can change workspace files: [Workspace file mutations](2026-09-10-workspace-file-mutations.md) ships five workspace-contained verbs that create a directory or an empty file, remove an entry, copy a subtree, and move or rename one. The `files` tab cannot use any of them. It was built to read: its store holds one tab's listing state (`root`, `levels`, `expanded`), its face has three methods that list a directory, and its one control is reload. [Sidebar text preview and file tree](../feature/2026-09-05-sidebar-text-preview-and-file-tree.md) owns why that tree is a page type with a per-level listing store of its own, and leaves the rest of a file manager's gestures deferred.

Connecting the two raises questions neither note answers. Where does the reader's in-hand state live — the selected row, the entry held for a paste, the open name input, the reason the last gesture failed — when a tab's body unmounts as the reader switches tabs and the tree's listing state already lives in a per-tab store? What does a gesture act on when the selection is a file rather than a directory? After a mutation lands, does the Client patch the entry it knows about into its cached level, or ask the Host to list that level again? How does the reader learn that the Host refused, and who confirms a removal that cannot be undone? And how does a Session reach the tree at all, when the tree is one page type among the right column's tabs and the column's own expanded state belongs to another package?

## Decision

`packages/client/ui-sidebar-files` gains a file manager's gestures over the tree it already draws: a toolbar, row selection, a right-click menu, an inline name input, a delete confirmation, and a Session-header control that opens the tree. They are performed through the package's existing store and face, and the five mutating verbs reach the Host through the `workspaceFiles` Remote namespace.

### The reader's working state lives in the tab's bucket

`FilesTabState` gains four members beside the listing state: `selected`, the absolute path of one row or `null`; `clipboard`, a `FilesClipboard` (`{ mode: 'copy' | 'cut'; path }`) or `null`; `draft`, a `NewEntryDraft` (`{ parent; kind: 'file' | 'directory' }`) naming the new entry still waiting for its name, or `null`; and `notice`, the `RemoteFailure` the last gesture settled with, or `null`. `start` seeds all four empty, and `selected`, `clipboarded`, `drafted`, `noticed`, and `pruned` write them.

They live in the store rather than in the body's local state because they outlive the body. A tab's body mounts and unmounts as tabs switch, and a reader who picks an entry up in one visit to the tree pastes it in the next; the name input must survive the switch it was open across. Two facts stay in component state precisely because they must not outlive the body: the open context menu (`menu`, carrying the row it acts on and the pointer position it was asked for) and the removal awaiting confirmation (`removing`). Each is one overlay that closes with the body, and a menu restored after a switch would be anchored to a pointer position that no longer means anything.

`selected` also clears `notice`: selecting another row is the reader moving on, so the line about the gesture they left behind stops being shown.

### A gesture acts on the selected row's directory, or the root

`destinationOf(state)` answers where the header's create and paste controls land: the selected row when it is a directory, and the tree's root when the selection is a file, an `other` entry, or nothing. It reads the selection out of that row's listed level, so a selection whose level is no longer listed, or whose entry the level no longer holds, falls back to the root instead of naming a directory the tree cannot see.

The right-click menu carries the row it was asked about rather than reading the selection, and offers paste only on a directory, because only a directory holds anything to paste into. `open` performs what the row's own click performs: a directory toggles, a file opens through the owner's `tabActions`. Create shows the inline input under the destination directory and opens that directory first when it was collapsed, since a collapsed directory draws no rows for the input to appear among. The header's paste control keeps its place in the toolbar and is disabled while the clipboard is empty, so the row of controls does not change width as the reader copies and pastes.

### A landed mutation re-lists the level it changed

`createEntry` re-lists the directory it created in. `removeEntry` forgets the removed path and re-lists the directory that held it. `pasteEntry` re-lists the destination, and a landed `cut` also re-lists the directory the entry left, unless that directory is the destination. Each re-listing goes through the face's `load`, which retires the listing still in flight for that level, so a refresh and the reader's own expand gesture cannot both write to it.

The level is listed again rather than patched in place because the listing is the authority on everything the tree draws: each entry's `type`, the level's truncation flag, and the endpoint's order, which the tree re-sorts. A spliced row would have to reproduce all three, and the paste case shows the tree cannot: `FilesClipboard` records a mode and a path, and `copy` and `move` answer with the produced entry's `absolutePath`, `version`, `bytes`, and workspace path — never its `type` — so after a paste lands the Client still does not know whether the entry it placed is a directory, a file, or something else. Nothing watches the filesystem either, so this re-listing is also the only way a level learns what else changed on disk.

`pruned` forgets the removed path's level, every level under it, the expanded paths that pointed at them, and a selection inside the removed subtree. A later entry may reuse the path, and it must not draw the removed subtree's listing or hold a gesture aimed at what is gone.

### Copy keeps the clipboard; a cut releases it

A paste composes its destination as the destination directory joined with the source's basename (`childPath(destination, baseName(clipboard.path))`) and calls `copy` for a `copy` clipboard and `move` for a `cut` one. A landed `cut` clears the clipboard; a landed `copy` leaves it, and a refused paste of either mode leaves it.

A cut's source is gone from the path the clipboard names, so a second paste would ask the Host to move a path that no longer exists: the clipboard would be holding a gesture that can only fail. A copy leaves its source in place, so one pick-up places the entry in as many directories as the reader pastes it into, which is what copying it asked for. Keeping the clipboard through a refusal is the same reasoning from the other side: the reader picks another destination instead of picking the entry up again.

Paste keeps the entry's own name because the gesture places an entry, it does not name a new one. No rename ships with this change, and a paste that asked for a name would be a rename wearing a paste's label. The Host refuses an occupied destination, so a paste whose name is already there — including a cut entry pasted back into the directory it came from — fails with `workspace-file/exists` and says so, instead of overwriting or merging.

### A refused gesture is stated above the tree

`gestureLine` maps the three refusals this package branches on to lines about the gesture: `workspace-file/exists`, the destination already holds that name so nothing was overwritten; `workspace-file/not-empty`, the directory still holds something so it was not deleted; and `workspace-file/not-found`, the entry is gone so it may have been moved or deleted. Every other failure shows its own `message`, because a carrier error or an unclassified Host code leaves the tree nothing useful to add to it. The line sits under the header and above the tree's scroller, so it stays where the reader is reading. Selecting another row drops it.

The name input stays open until the creation lands, so a refused name keeps what the reader typed next to the line saying why. A blank name is never sent: Enter on an empty input would produce a round trip about a segment the reader never meant to type. Escape, or focus leaving the input, closes it without asking the Host for anything.

### Delete is confirmed in the pane

A delete from the context menu opens a `Modal` that names the entry — with "and everything inside it" for a directory — and calls `removeEntry` only when the reader confirms. Cancelling, or closing the modal, calls nothing. A file is removed with `recursive: false` and a directory with `recursive: true`, so the entry's own kind decides the option and the reader's wording does not.

The confirmation belongs to the pane, not to the Host. `remove` is one of the five mutating verbs on `ctx.workspaceFiles`, and its callers include non-interactive ones; a Host that asked before every removal would make each of them wait on a reader that may not exist. The pane is also the only place that knows which click was a decision — the right-click that opened the menu is not one — and the entry can be named there in the reader's own language.

### The five verbs are derived from the generated client

`WorkspaceFilesMutations` is `Pick<ClientRemote['workspaceFiles'], 'createDirectory' | 'createFile' | 'remove' | 'copy' | 'move'>`, and the bound face is that type plus the tree's own narrowed `list`. The verbs are declared once, by the Host's generated client, so a Host verb that gains, loses, or reorders a parameter is a compile error in this package rather than a call that passes the wrong argument. A structural type written out here would compile against a stale argument list and fail on the wire.

Each mutating verb forwards its call instead of capturing the method, so a `workspaceFiles` namespace that remounts hands the tree the live method on its next gesture. Only `list` narrows, because the tree keeps the entries and the truncation flag and drops the endpoint's workspace-relative path. Every mutating verb returns without calling for a record whose `signal` has already aborted, and a settlement after that abort writes nothing.

### The Session-header control is stateless

The package registers one more contribution: `conversation.session.header.utilities` under id `workspace-files`, drawing `FilesToggleAction`, a folder glyph whose accessible name is the namespace's `toggle.label`. That seat is a list cell addressed by id, so a caller can replace exactly this control without disturbing its neighbours.

The component holds no state. The inject face closes over `ctx.sidebarRight`, and at the moment of the gesture it asks the column whether it is expanded and whether the active tab is the `files` kind: when both hold it folds the column with `toggleExpanded()`, and otherwise it opens the tree with `openTab('files')`. The answer is not stored because the column's state is not this package's to read. `sidebarRight` declares its own store, this package declares the tree's, and a component receives its data through the four props shares rather than from another package's store. Asking at the gesture is also the only answer that is true then, since the column expands and collapses through controls this package never sees. `openTab` reveals the column in the same step, so a collapsed column needs no second call. `sidebarRight` joins the package's `inject` list.

### The new copy is locale-owned

The gestures add their strings to the `sidebarFiles` namespace: the toolbar's three labels, the five menu rows, the two name-input labels, the confirmation's title, sentence, action, and cancel, the control's label, the three gesture refusal lines, and the line for a failure the tree cannot classify. `zh` is the key set's source of truth and `en` is `satisfies Record<SidebarFilesKey, string>`, so a key the English dictionary lacks fails to compile.

## Alternatives considered

**Keep the reader's working state in the body's local state.** The clipboard, the selection, and the name input would then be declared where they are drawn, which is fewer store members. Rejected because the body is not the owner of a fact that spans visits: it unmounts as tabs switch, so the reader would lose the entry they picked up by looking at another tab, and the name input would close under them. The store is this registration's declared write set, and a shared gesture fact belongs to it.

**Patch the cached level with the entry the mutation produced.** A create or a paste could insert a row without a round trip, which is one request cheaper per gesture. Rejected because the tree would have to invent the facts the listing carries: a paste's result names a path and a version but no entry `type`, the level's truncation flag would have to be guessed, and the endpoint's order is not the row's place anyway. The first listing afterwards would then contradict what was drawn, and a name that is a directory here may be a file there.

**Clear the clipboard on a landed copy as well, for symmetry with a cut.** Rejected as a symmetry that costs a capability: a copy's source is still there, so the two modes are not the same gesture and the reader who copied an entry to place it in two directories would have to copy it twice. The asymmetry is the point, and it is stated where the modes are declared.

**Let a paste ask the reader for the destination name.** Rejected: the gesture places an entry the reader is already holding, and the common case is placing it under its own name in another directory; a name prompt would turn one gesture into a dialogue and would be a rename introduced under a paste's label. `move` is the verb a future rename would use, and it is reachable today only through a paste.

**Confirm a removal in the Host, before `remove` runs.** Rejected: `remove` is an ordinary workspace verb shared with callers that have no reader to ask, and an interactive step inside it would either block them or need a per-caller flag that makes the contract two contracts. The confirmation is the pane's because the pane is where destructive intent is distinguishable from the click that opened the menu.

**Give `FilesToggleAction` a store, or read the column's expanded state out of `sidebarRight`'s.** A control that knew the column's state could draw itself pressed or swap its glyph. Rejected: the right column's store belongs to `ui-sidebar-right`, this package's registration declares the tree's state and nothing else, and a component's data arrives through the props shares rather than from a second store. The service answers at the gesture, which is the only moment the toggle's answer is used.

**Reach the tree only through the guide entry it already registers.** The `files` type is already one capsule on the guide, so this control adds a second way in. Rejected: the guide is a page the reader has to open first, so the tree would be two gestures away from every Session, and the column would hold a page whose only job is to hand its tab over. The header control makes the tree one gesture from the Session it belongs to.

## Consequences

The tree's face and store are a file manager's now, not a listing's: a mutation and its refresh are two requests, and a gesture that changes two directories (a cut) issues one verb and two listings. A reader who creates ten files issues ten creates and ten listings; nothing coalesces them.

The refresh is not live. No level watches the filesystem, so a level shows what it last listed plus whatever the reader's own gestures refreshed; a change made by the agent, by another reader, or outside the product appears on reload or on the next open of that level.

Paste cannot rename and cannot place an entry beside one that already has its name. The refusal is `workspace-file/exists`, so the reader must remove or move the occupant first, and a cut entry pasted back into the directory it came from fails the same way — a gesture that reads as a no-op is reported as a refusal.

A refused gesture leaves the tree as it was: no level is re-listed, nothing is forgotten, and the clipboard is kept, so the reader can retry against another destination without repeating the pick-up. The line saying why is the only trace it leaves, and selecting another row clears it.

The reader's working state is per tab and gone with the tab. Nothing is persisted across a page reload, and the context menu and the confirmation are gone with the body that opened them.

The Session-header control names the `files` kind rather than an implementation, so a product whose extension takes that kind over gets the replacement page from the same button; the control is a way to the tree, not a way to `ui-sidebar-files`' component.

## Testing

`tests/store.client.spec.ts` covers the new write set: one selection at a time and its clearing, one clipboard entry and its release, the draft, the notice and its clearing by selection, and `pruned` forgetting a subtree's levels, expansion, and selection. `tests/face.client.spec.ts` covers what each gesture reaches and what a settlement writes: `createEntry` through `createFile` or `createDirectory` with the parent and name, the input staying open until a creation lands and reopening nothing when one is refused, `removeEntry` with the entry's own `recursive`, each paste mode through `copy` or `move` at the composed destination, the two-directory refresh of a cut and the one-directory refresh when it lands where it came from, the clipboard released by a cut and kept by a copy or a refusal, `pruned` for a removed subtree, and no mutating request at all for a record whose signal already aborted. `tests/files-body.client.spec.tsx` covers the drawn behavior: the selection mark and its survival across a re-listing, the inline input's create, cancel, blank-name, and refused-name paths, paste from the toolbar and from the menu, the menu's rows per kind, the confirmation calling the Host only when confirmed and cancelling for free, the refusal lines, `destinationOf`'s four fallbacks, and `gestureLine`'s mapping. `tests/files-toggle-action.client.spec.tsx` covers the control's accessible name and that it performs one gesture. `tests/apply.client.spec.ts` covers the four registrations, the `workspace-files` id, their removal on dispose, and the three branches of the toggle: not expanded, expanded on the tree, expanded on another tab.

## Related

- [Workspace file mutations](2026-09-10-workspace-file-mutations.md) — the five Host verbs, their error codes, and workspace containment.
- [Sidebar text preview and file tree](../feature/2026-09-05-sidebar-text-preview-and-file-tree.md) — the tree's type registration, per-level listing store, row rules, and reload control.
- [Right Sidebar tab types and navigation](2026-09-05-sidebar-tab-types-and-navigation.md) — `openTab`, `openResource`, and the seats these registrations use.
- [Workspace Files service](2026-09-05-workspace-files-service.md) — the `workspaceFiles` Remote namespace and the listing's entry cap.
- [Locale-owned client UI copy](2026-08-23-locale-owned-client-ui-copy.md) — the `t` seat and the typed dictionary rule the new copy follows.
