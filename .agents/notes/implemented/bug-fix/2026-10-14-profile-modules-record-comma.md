# Agent Note: the profile's pnpm record keeps its commas

Status: implemented

English | [中文](2026-10-14-profile-modules-record-comma.zh.md)

## Problem

Rebuilding a desktop profile after installing 0.1.5-rc.22 failed with

```
dsh shell: prebuild failed: desktop project: pnpm exited with 1:
[ERROR] missed comma between flow collection entries (1812:3)
```

The rebuild materializes the published profile tree and then has pnpm restore the desktop
plugins into it. Before that second step, `recordInstalledPnpmPaths` in
`apps/desktop/src/seed-store.ts` points the tree's pnpm record (`node_modules/.modules.yaml`)
at the store and profile the tree really occupies. It replaced the whole `storeDir` and
`virtualStoreDir` line, and the replacement text ended without a comma — so the record lost
the comma separating that entry from the next one, and pnpm refused the tree.

Because the rewrite runs inside the materializer, the damage is repeated on every attempt, and
a seed built by an affected release carries the damaged record with it. The failure surfaces
far from its cause: a plugin restore step reports `pnpm exited with 1`, and the app keeps
starting from the profile it could not replace.

## Decision

Keep the line ending when rewriting, and repair a record that already lost it:
`rewriteRecordedPath` reuses the comma the replaced line ended with, and
`restoreRecordedComma` puts the comma back when the line is followed by another quoted key.
Both run in `apps/desktop/src/seed-store.ts` before the record is written, so a tree
materialized from an affected seed is usable again.

`apps/desktop/tests/seed-store.spec.ts` holds both cases: the rewritten record keeps the commas
ending its two path lines, and a record whose path lines lost their commas is repaired while
the neighbouring entry stays as it was.

## Alternatives considered

- Parse the record and re-serialize it. The file is YAML that only looks like JSON, so a JSON
  round trip would reject shapes pnpm legitimately writes, and a YAML dependency would be added
  to a module that deliberately owns two facts of that file.
- Leave the record alone and let pnpm correct it. pnpm refuses to operate on the tree at all,
  which is the failure being fixed.
- Fix only the writer. Seeds built by earlier releases already carry the damaged record, so an
  installed app would keep failing until a new seed was built and published.

## Consequences

Upgrading an affected installation works again, and a tree built from an rc.21-era seed is
repaired while it is materialized. The module still rewrites exactly two facts and still does
not own pnpm's record format; the repair is limited to a line that ends without its comma
before another quoted key, which is invalid YAML in any case.
