# Agent Note: The desktop seed store merges in concurrent file batches

Status: implemented

English | [中文](2026-10-16-desktop-seed-store-concurrent-merge.zh.md)

## Problem

The 2026-10-16 startup report left the rebuild path as the largest remaining cost. Measured on that machine with a fresh home and a cached 0.1.5-rc.25 seed, one `--prebuild` took 78.7 s: seed verification 1.8 s, the store phase 44.4 s, the profile link pass 27.3 s, staged verification 5.1 s, and activation 0.02 s.

The store phase was almost entirely `copyStoreEntries` in `apps/desktop/src/seed-store.ts`, which walked the 22 399 entries of the extracted seed store and copied each missing one with a synchronous `copyFileSync`. On a fresh home every entry is missing, so the pass was 22 399 hand-serialized copies at roughly 2 ms each. That cost is the per-name work Windows charges for each new file, not the bytes: the same measurement shows the profile link pass paying about 0.9 ms per file for 30 110 links, and DSH NEXT booting the same engine in 4.96 s from one packed `app.asar` instead of a 30 110-file tree.

## Decision

`copyStoreEntries` issues its copies in concurrent batches of `COOPERATIVE_BATCH_ENTRIES` entries, waiting on `Promise.all` over asynchronous `copyFile` calls, reporting progress once per batch, and yielding to the event loop between batches. The pass now matches the two patterns the same file already uses: the batched concurrent link pass in `materializeLinkedProfile`, and the cooperative walk contract in `apps/desktop/src/event-loop.ts`.

Entry-by-entry decisions are unchanged. `needsStoreCopy` still decides whether an entry is copied at all, so an entry already present is still left untouched and a half-written copy is still repaired by size. Two entries in one batch are always two store-relative paths, so a batch cannot race itself, and concurrency stays bounded instead of opening one handle per store entry.

Measured on the same machine, seed and home layout: the store phase fell from 44.4 s to 34.7 s, and the whole `--prebuild` from 78.7 s to 65.3 s.

## Alternatives considered

- Keep the sequential copy loop. It is correct and the store phase is not on the healthy launch path, but it is the largest reducible block of the rebuild, and the sibling link pass in the same file already shows how to overlap it.
- Extract the seed archives straight into the store instead of staging and copying them. That would skip the copy entirely, but the transport contract owns validation: shards are checked for paths, entry types, uniqueness and counts and extracted in an isolated directory before any file may enter writable package state. Changing it is a packaging decision, not a copy-loop one.
- Copy every file in one `Promise.all`. Unbounded concurrency over 22 000 entries risks exhausting handles and starves the event loop that serves the startup window, which is what the cooperative batch bound exists to prevent.
- Skip the staged verification walk or fold it into the link pass. That walk is the independent check that the runtime on disk is complete and that its native modules load; removing it to save 5.1 s would trade a guarantee for a smaller number.
- Raise the batch size for this pass only. The bound is shared with the other walks and exists to keep the shell responsive, so a second constant would need its own justification.

## Consequences

A user whose launch rebuilds the runtime waits about 13 s (17%) less for the store and the profile to be ready, and the win comes from overlapping per-file latency, so slower per-name storage benefits more than faster bulk throughput would suggest.

The phase is no longer strictly ordered, so the progress fraction advances per batch rather than per file; the reported fraction is clamped to 1 because the last batch is counted whole.

Peak handle use during the merge is bounded by the batch size and matches the profile link pass, which already ran at that concurrency.

The remaining rebuild cost is untouched by this note: the 16-shard archive extraction and the SQLite `package_index` merge inside the same phase, the 27.3 s link pass, the 5.1 s verification, and the separate seed download all still pay the same per-file prices. Shortening those, and the 70 s cold first open of the installed runtime tree, remains open work; the store transport and validation rules this pass serves stay owned by [Electron desktop packaging and updates](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md), and the home this store lives in by [the product home note](../bug-fix/2026-10-16-desktop-product-home-and-activation-recovery.md).
