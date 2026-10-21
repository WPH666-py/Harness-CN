# Agent Note: Two desktop products, two homes

Status: implemented

English | [中文](2026-10-18-two-products-one-home.zh.md)

## Problem

An installed rc.33 refused to start on a machine that also runs the DSH desktop product:

```
desktop project: the Harness-CN runtime at C:\Users\admin\.dsh\profiles\desktop is in use and could not be moved;
close every Harness-CN window and any other program using this home, then start again
  [cause]: Error: EBUSY: resource busy or locked,
  rename 'C:\Users\admin\.dsh\profiles\desktop' -> 'C:\Users\admin\.dsh\desktop\rollback\profile'
```

The directory it tried to move was not Harness-CN's: it was the live profile of the other product, whose Host process was running out of exactly that path.

## Cause

`adoptHarnessCnHome` treated any non-empty `DSH_HOME` as an instruction. That variable belongs to the DSH product and is commonly exported machine-wide — a shell, a launcher, or the other product's own environment carries it into every child process. A packaged Harness-CN launched from such an environment therefore resolved the shared `~/.dsh` as its home, and `DesktopProjectManager.activate` then did what it always does with *its* runtime: move `profiles/desktop` into `rollback/profile` before staging the release it ships with. When the other product held that directory, the rename failed; had the other product been idle, the move would have gone through and taken its profile with it.

## Decision

A packaged launch resolves `~/.harness-cn` and never reads `DSH_HOME`:

1. `HARNESS_CN_HOME` names this product's home and outranks everything, packaged or not.
2. A packaged launch (`app.isPackaged` in the Electron main, `HARNESS_CN_PACKAGED=1` for the Tauri sidecar, set by the shell when it spawns it) ignores an inherited `DSH_HOME` and adopts the product default.
3. Development and CLI launches keep honouring `DSH_HOME`, where the variable is the developer's own instruction rather than a neighbour's environment.

## Alternatives considered

- **Keep honouring `DSH_HOME` and add a busy-profile guard.** Rejected: the guard only covers the locked case. Idle, the same code moves the other product's profile into `rollback/`, and both products still share sessions, storages, and credentials — one home for two products is the defect, not its symptom.
- **Rename everything to `HARNESS_CN_HOME` and stop supporting `DSH_HOME` at all.** Rejected: the repository's development and CLI flows set `DSH_HOME` deliberately, and `@deepseek-ai/dsh-home-paths` owns that precedence for them. Only the packaged entry points need the narrower rule.
- **Detect the other product and pick a per-product profile (`profiles/harness-cn`).** Considered as a second line of defence, not as the fix: a profile name does not stop the two products from sharing a store, a credentials file, or a session directory.

## Consequences

- A user who set `DSH_HOME` on purpose to move Harness-CN's home must use `HARNESS_CN_HOME`; the run log names the home this launch adopted, so the change is visible rather than silent.
- The one-time copy of user data an earlier Harness-CN left in `~/.dsh` still runs, and still refuses to copy anything when the legacy home carries the other product's artifacts.
- The installed sidecar and the Electron main make the same choice from the same two variables, so neither half can drift into the shared home on its own.
