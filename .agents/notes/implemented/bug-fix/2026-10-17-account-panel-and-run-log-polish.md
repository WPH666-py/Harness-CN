# Agent Note: The sign-in row kept its start control, and the run-log window could open onto a blank list

Status: implemented

English | [中文](2026-10-17-account-panel-and-run-log-polish.zh.md)

## Problem

Two post-release corrections on the rc.29 desktop payload, both reported against the installed app.

**Account panel.** After the browser sign-in flow started, 设置 → 账号与余额 rendered 请在浏览器中继续 with the row `[登录] [取消] [打开浏览器]`: the control that starts a sign-in stayed beside the one that ends it, even though a second start can only replace the attempt the browser is already holding.

**Run log.** 运行日志 opened onto a window with every label from the locale, an empty list, no status line and no error notice. The shell's snapshot endpoint answered `/shell-api/logs` with 207 entries when probed from the main window at the same moment, so the data existed and the page simply never showed it.

## Cause

**Account panel.** `AccountSection.tsx` rendered the 登录 button unconditionally in the signed-out arm and only filtered the cancel control by `ACTIVE_PHASES`. The button's `disabled` state comes from `state.busy`, which is false between the `startSignIn` answer and the browser callback, so the panel looked ready to start while the attempt was running.

**Run log.** `main()` in `apps/desktop-shell/rsc/log-viewer.js` attached the live stream (`subscribeEvents`, a long-lived SSE request) *before* reading the snapshot. Both go to the same loopback origin, and Chromium allows six connections per origin; the app's own page holds several long-lived streams, and the plugin-manager window holds another. When the stream takes the last slot, the snapshot request queues behind it and the page sits at `await readSnapshot()` with nothing on screen. The window's own comment already named this failure mode from the other side: "without a deadline the labels appear, the list stays empty, and the window claims this run logged nothing."

## Evidence

- The installed app, driven over the WebView2 debugging port: clicking 登录 produced 请在浏览器中继续 with `buttons: [取消]` after the change, and `hasSignIn: false`; cancelling returned the idle panel with the 登录 control and no attempt.
- Reproducing the viewer page in an iframe inside the running app rendered `显示 1 条，内存保留 1 条，已丢弃 0 条。` and one row, so the page's own logic was sound and the failure was the request ordering, not the snapshot.
- After the reorder, a freshly opened window rendered `显示 65 条，内存保留 65 条，已丢弃 0 条。  C:\Users\admin\AppData\Local\com.harnesscn.desktop\logs\harness.log` with 65 rows.
- `readSnapshot()` already retries (`SNAPSHOT_ATTEMPTS = 4`, `SNAPSHOT_TIMEOUT_MS = 5000`) and reports each failure above the list, which is why a queued read leaves a blank window for the first five seconds and only then starts explaining itself.

## Decision

- The signed-out arm renders the 登录 control only when no attempt is active (`attempt === null || !ACTIVE_PHASES.includes(attempt.phase)`); an active attempt renders the cancel control and the authorize link. The row wraps instead of overflowing, and the link carries a little horizontal padding so it lines up with the buttons.
- `log-viewer.js` reads the snapshot first and only then attaches the live stream. `merge()` already drops anything the snapshot carried by sequence number, so the later attach loses nothing.

## Alternatives considered

**Attach the stream only while the window is visible.** The stream is exactly what keeps the list current while the window is open, and visibility can change at any moment; the ordering fix removes the dependency without making the stream conditional.

**Raise `SNAPSHOT_TIMEOUT_MS`.** It would turn a five-second blank window into a longer one — the queue, not the deadline, is the problem.

**Drop the live stream and poll.** Correct but heavier: one request per interval instead of one connection for the window's lifetime, and the snapshot path is already the thing that must not wait.

## Consequences

A window whose first request is the snapshot always paints, regardless of how many long-lived connections the other windows hold; live lines still arrive once the stream attaches. The account row no longer offers two contradictory controls at once, and the specs pin both: the phase matrix now asserts the start control is absent for every active phase, and the gesture spec clicks 登录 in the idle panel before the attempt exists.
