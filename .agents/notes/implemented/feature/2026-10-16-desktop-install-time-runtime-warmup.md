# Agent Note: Setup warms the desktop runtime before the first launch

Status: implemented

English | [中文](2026-10-16-desktop-install-time-runtime-warmup.zh.md)

## Problem

The 2026-10-16 startup report left the healthy launch path at about 87 s, and the shell's own share of it is at most 3.2 s. The app log splits the rest into 70.1 s between `desktop runtime already matches the bundled release` and the first line the backend prints, then the ~15.8 s WeChat QR round trip before `backend ready`. Probes of the same profile split the silence into a loader phase and a plugin and webserver phase that together took 9.1 s when the runtime's files were already in the OS cache, while one run of the same probe on the same profile and environment measured 62.1 s for the phase the next run finished in 9.1 s. The V8 compile cache was ruled out as the variable: `desktop/node-compile-cache` held the identical 32 files and 2 651 144 bytes before and after both runs.

What remains is the cold first touch of the installed tree: 30 110 files, each paying a Windows open plus whatever the antivirus does on first sight, against DSH NEXT booting the same engine in 4.96 s from one packed 181 MB `app.asar`. Nothing in the product paid that price where it could be hidden. `--prebuild` installs the release, verifies the tree structurally and deliberately never booted it, so every user paid the whole cold cost on their first launch with the splash screen in front of them.

## Decision

`apps/desktop-shell/src/shell-main.ts` gains `warmRuntime`, and `prebuild` calls it once the release is in place. It starts a `DesktopHostProcess` from the active profile with the same compile cache directory `main` uses, waits for the host to report ready, logs `desktop runtime warmed: dsh <version> in <n> s`, and stops it again. A failure is logged as `desktop runtime warm-up failed: <message>` and changes nothing else: the installer still exits 0, and a first launch behaves exactly as it did before.

The warm-up is deliberately not part of `applyRelease`'s `healthCheck` hook. That hook verifies a staged tree before activation; the warm-up runs on the activated runtime after the transaction has committed, so it cannot influence activation or rollback.

The JSDoc on `prebuild` recorded the opposite decision ("The Host is deliberately not started: composing the runtime is the long part, and booting it here would cost the fifty seconds the structural check exists to avoid") and now records this one: setup is the only place where the first touch of every runtime file can be paid while nobody is watching a splash screen.

## Alternatives considered

- Leave setup as it was and pay the cold cost on first launch. It is correct, and each file is only cold once per machine, but that once lands in front of the user at the moment they are judging the product.
- Boot the staged tree inside `healthCheck`. That hook already boots a staged runtime for plugin mutations, but using it here would put a minute of first-touch work inside a transaction that can roll back, and it would charge every release install for a check the structural verification already performs.
- Warm the runtime from `main` instead. The launch path owns the splash screen and a waiting user; the installer owns neither.
- Ship the runtime packed, the way DSH NEXT ships one 181 MB `app.asar`. That attacks the per-file price at its root and is the only route near 5 s, but it changes how the desktop profile is materialized and is not a decision this change can carry.
- Prewarm the V8 compile cache with a separate compile-only pass. Measured and rejected: the cache held identical contents across a 62.1 s cold boot and a 9.1 s warm boot, so it is not what the silence is made of.
- Defer the third-party WeChat QR login out of the readiness path. Measured: skipping `bridge.start()` moved readiness from 18.6 s to 15.3 s on the same profile, so at most about 3.3 s, and `dsh-wechat` is a third-party bundle that only the seed-time patch scripts may touch.

## Consequences

Setup now spends about 15 s booting and stopping the runtime, and the first user launch starts from a tree whose files the OS has already opened once. On the profile used for these measurements the same host reported ready in 15 s when warm against 70.1 s of cold silence in the app log, and the warm-up run itself printed `desktop runtime warmed: dsh 0.1.5-rc.25 in 15 s`.

Installation takes that much longer before the installer reports success. The NSIS hook already allows 20 minutes for the whole `--prebuild` invocation, so the added boot is not a new timeout risk.

The warm-up is not a health check and must not be read as one. It proves only that the runtime booted; a failure changes nothing except one log line, and no rollback, staging cleanup or journal entry depends on it.

One failure mode is worth naming because it was observed while verifying this note: when the runtime's own `node.exe` runs under a file sandbox that denies the OS temp directory, `@deepseek-ai/dsh-spill-local` fails its `mkdtemp` with `EPERM` and the boot dies. A `node.exe` copied into a sandboxed workspace could not create directories in `%TEMP%` while the identical binary outside it could, and the warm-up logged the failure and exited 0 exactly as designed.

The first launch still pays the WeChat QR round trip and still opens a 30 110-file tree; this note moves the first touch earlier instead of removing it. The install and activation path the new hook sits in stays owned by [Electron desktop packaging and updates](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md), the profile it boots by [the product home note](../bug-fix/2026-10-16-desktop-product-home-and-activation-recovery.md), and the rebuild measured beside it by [the seed store note](../simplification/2026-10-16-desktop-seed-store-concurrent-merge.md).
