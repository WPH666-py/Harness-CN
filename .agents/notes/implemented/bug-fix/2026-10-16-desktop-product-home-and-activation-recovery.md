# Agent Note: Harness-CN starts from its own home and never deletes a running runtime

Status: implemented

English | [中文](2026-10-16-desktop-product-home-and-activation-recovery.zh.md)

## Problem

On 2026-10-16 a Harness-CN 0.1.5-rc.25 launch on a machine that also runs DSH NEXT showed `已用时 157 秒` and then failed with `EPERM, Permission denied: \\?\C:\Users\admin\.dsh\profiles\desktop` (the shell log ends with `startup failed: EPERM, Permission denied: …`). Healthy launches on the same machine were still ~87–90 s.

The log accounts for the 157 s: seed download 57 s, store unpack 32 s, the pnpm link of 30110 files 38 s, staged verification 4.8 s, and a 17 s activation retry. The shell's own work is under 3.2 s in every run. Two defects produced that sequence.

First, both products resolved the same home. `resolveDshHome` in `packages/util/home-paths` answers `$DSH_HOME || ~/.dsh`, so Harness-CN shared `~/.dsh` with DSH NEXT. DSH NEXT had rewritten `~/.dsh/profiles/desktop/package.json` with its `desktopNextPlugins` fields and owned the shared package store, so `DesktopProjectManager.profileMatchesRelease` could never match and every launch rebuilt the profile from the seed. Its running Host also held files inside `~/.dsh/profiles/desktop`, so the activation rename could not move that directory aside and Windows answered EPERM.

Second, `activate()` deleted the runtime it was replacing. Its catch ran `if (existsSync(this.paths.profile)) removeOwnedDirectory(this.paths.profile)` before checking whether the move-aside had happened at all, so the EPERM surfaced as a cleanup failure and a working profile was destroyed. The journal was left at step `active-moved` with an empty staging tree beside it, and `recover()` could no longer restore anything.

## Decision

Harness-CN owns its own home. `apps/desktop/src/product-home.ts` exports `adoptHarnessCnHome(env)`, called by both entries before any desktop path is resolved — `apps/desktop-shell/src/shell-main.ts` in `prebuild` and `main` (through the local `adoptHome` helper) and `apps/desktop/src/main.ts` — which points `DSH_HOME` at `%USERPROFILE%\.harness-cn` when the variable is unset or blank and returns `resolveDshHome(undefined, env)`. An explicit `DSH_HOME` still wins, and `packages/util/home-paths` keeps `~/.dsh` as the engine default.

Legacy user data is copied once. `migrateLegacyHarnessHome` copies credentials, settings files, sessions, storages and attachments from `~/.dsh` into the new home — never `desktop/`, `profiles/`, `logs/`, `recovery/`, `electron-user-data/` or any other runtime tree — and only when the legacy home shows no DSH NEXT trace (`logs/desktop-next*`, `profiles/desktop/desktop-next*`, or a profile manifest containing `desktopNext`). The legacy home is never deleted or moved, a file that already exists in the new home is never overwritten, and `home-migration.json` is written only after the copy succeeded, so a skipped or partial migration is retried on the next launch.

Activation publishes each journal step only after the action it records: `prepared` before the move-aside, `active-moved` after it, and `staging-activated` after the replacement booted. The catch now calls `settleActivation(activeMoved)`, which returns the moved-aside runtime to the profile, and it removes the profile path only when `activeMoved` proves this transaction put something there. If a process still holds that path, the repair is left to the next launch, which repeats it from the journal. A rename refused with EPERM, EACCES or EBUSY is reported by `renameConflictError` as `desktop project: the Harness-CN runtime at <path> is in use and could not be moved; close every Harness-CN window and any other program using this home, then start again`.

`recover()` returns a `DesktopRecoveryReport` instead of nothing, `describeDesktopRecovery` renders it, and both entries log it, so a restored or discarded runtime is visible instead of silent. A `staging-activated` journal discards the superseded copy beside the committed profile; an earlier step restores the moved-aside runtime.

`apps/desktop/tests/product-home.spec.ts` covers adoption, migration, no-overwrite and DSH NEXT trace detection, and `apps/desktop/tests/project-manager.spec.ts` gains four cases, including `keeps the active profile when the replacement cannot move it aside` (the defect above) and a Windows-only case where an open handle keeps the profile in place and the error names it.

## Alternatives considered

- Change the engine default in `packages/util/home-paths` to a product directory. That resolver is the single ground truth shared with the upstream product developed in the same repository, so moving it would move DSH NEXT's data too.
- Keep the shared home and detect the other product, for example by reading `~/.dsh/logs/active-run.json` or writing a pid marker of our own. That makes this product a reader of another one's private files, and a pid marker is a second source of truth that goes stale and cannot see processes that are not Harness at all; the directory rename already answers "is it in use" with EPERM.
- Keep the catch's profile deletion but guard it with `existsSync(this.paths.rollback)`. The journal step and the in-memory `activeMoved` flag are the facts that matter, and `existsSync(profile)` is true both for a profile this transaction moved and for one it never touched.
- Replace the move-aside with a copy. Copying a 30000-file runtime doubles peak disk use and lengthens the window in which the installed profile is inconsistent, on every install and every update.
- Localize the new in-use message. Every other `DesktopProjectManager` failure reaches the startup dialog as its own English text today, so one translated message would be the odd one out; the gap is recorded below.

## Consequences

Two products can be installed side by side; each has its own home, package store and profile, so neither can invalidate or hold the other's runtime. A user who already ran Harness-CN gets credentials, sessions and settings copied into `~/.harness-cn` on the first launch of the new version, and `~/.dsh` keeps its contents, so disk use grows by the copied user data only.

The first launch after this change sees an empty home, so it rebuilds the runtime once — 65 s on the machine in the report with a cached seed, and about 100 s if the seed still has to be downloaded — unless the legacy home was Harness-CN-only.

A failed activation can no longer destroy a working runtime, and a launch that cannot move the profile says which path is in use instead of replacing the cause with a cleanup error. Recovery stays idempotent: it only moves directories and removes the journal at the end.

The in-use message and the recovery lines are English in a product whose shell copy is otherwise owned by `apps/desktop/src/locale.ts`. Localizing them is deferred because these paths run before the Host and their text reaches a MessageBox rather than a locale-aware surface.

That first launch also installs a runtime only this release can boot. The 0.1.5-rc.25 seed's `desktop.cordis.patch.yml` does not disable the `directory-picker-mobile-host` and `directory-picker-mobile-surface` rows, so a bundled plugin replaces the stock picker row and inserts its own browse pair while the patch inserts the native pair, both registering the single `directoryPicker` service; the second registration fails the whole plugin tree with `service "directoryPicker" has been registered at <BrowseDirectoryPicker>`. The patch in this tree disables those two rows, and a fresh home built from this tree booted with the same seed and no picker conflict, which is why the empty-home first launch is safe.

The healthy startup costs in the report are unchanged by this note: the runtime is still a 30110-file directory tree, the Host still takes ~87–90 s to report ready, and the installer still ships no seed. The rebuild path that the first launch pays is shorter by one concurrent store merge ([the seed store merge note](../simplification/2026-10-16-desktop-seed-store-concurrent-merge.md)); shortening the rest is separate work.

This decision partially supersedes [one harness home resolver](../architecture/2026-07-24-single-harness-home-resolver.md): its precedence rule and its refusal of split roots stand for the engine, while the Harness-CN desktop product now pins `DSH_HOME` at its own entries. Under this product the layout recorded in [Electron desktop packaging and updates](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) starts at `~/.harness-cn/` instead of `~/.dsh/`; that note's profile ownership, activation journal and lock decisions are unchanged.
