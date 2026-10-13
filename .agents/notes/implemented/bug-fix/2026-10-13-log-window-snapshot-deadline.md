# Agent Note: The run-log window reports a snapshot read that never answers

Status: implemented

English | [中文](2026-10-13-log-window-snapshot-deadline.zh.md)

## Problem

`log-viewer.js` writes the rows, the status line, and the empty-list line only after its snapshot
read settles. Until then the only text on the page is the locale labels. A read that neither
resolves nor rejects therefore leaves a window that shows the toolbar and nothing else — the same
picture as a run that logged nothing, which is the one thing that window exists to distinguish.

A user reported exactly that against 0.1.5-rc.21: the window had localized labels, no rows, no
status line, no empty-list line, and no failure notice, while `harness.log` held the run's lines.
The same page, loaded from a fresh Chromium client against the same shell, rendered the retained
lines and its status line, so the page, the shell API, and the fetch path all work; the observed
window is the state a read that never settles produces.

`log-viewer-boot.js` cannot cover this case. It stops waiting as soon as the module starts, and the
module sets the page title before it reads anything, so a module that starts and then stalls is
precisely the state the guard treats as success.

## Decision

`readSnapshot()` reads the snapshot through a deadline and retries it. Each attempt races `getLogs()`
against `SNAPSHOT_TIMEOUT_MS` (5000 ms); a failed or timed-out attempt is retried, up to
`SNAPSHOT_ATTEMPTS` (4) attempts, waiting `SNAPSHOT_RETRY_DELAY_MS` (500 ms) times the attempt number
between them. While a retry is pending, the page shows a failure notice naming the attempt and the
reason. When the read finally succeeds, `main()` drops that notice after the list is rendered; the
last failure, when every attempt fails, propagates to the existing `main().catch`, which reports it.

Notices live in a keyed map (`bootNotices`) instead of a single element write, so dropping a
recovered retry notice cannot erase an unrelated failure such as an unavailable live log stream.
`reportBootFailure(text, key)` keeps its old one-argument behaviour for those callers.

## Alternatives considered

**Let `log-viewer-boot.js` report the stall.** The guard stops waiting when the module starts, and
the module sets the title before it reads. Covering this case there would mean moving the start
signal after the first render, which then reports a stall of the snapshot read as a module that never
ran.

**Put the deadline inside `shell-api.js` `request()`.** Every shell window shares that helper; a slow
endpoint elsewhere is not this window's failure, and the log window is the one surface where silence
is indistinguishable from an empty run.

**Show a progress indicator instead of a notice.** A progress indicator is the same silence with
motion. The read's rejection carries the information the user needs, so the window shows it.

## Consequences

The window now always ends in one of three visible states: rows, the empty-list line naming the log
file, or a failure notice. A shell that stalls costs up to four attempts (about 23 seconds with the
configured values) before the final notice, and the retry renders as soon as a transient stall
clears.

The window's client module gains a timer per attempt. Nothing else in the shell changes: the server
endpoint, the ring buffer, and the live stream keep their behavior.

`node --check` parses the changed module. Coverage in this repository has no lane that loads the
shell's `rsc/` client modules, so the page is verified in a real Chromium engine over the DevTools
protocol against a running shell: the retained lines and the status line render, and with the log
endpoint held open the window shows the retry notice instead of staying empty.
