# Agent Note: Harness-CN GitHub release channel

Status: implemented

English | [中文](2026-10-07-harness-cn-github-release-channel.zh.md)

## Problem

Harness-CN distributes an unsigned Windows build of the Electron shell. The shell already carried a complete update flow — an automatic check ten seconds after the workspace opens, a localized **Check for Updates…** menu item, a native confirmation dialog, and the `updates` IPC face — but in this build it could never fire. The coordinator was driven by `electron-updater` and gated on `app-update.yml` existing in `process.resourcesPath`, and packaging omits the `publish` block entirely for an unsigned build, so the file is never emitted and the gate is always false. The origin it would have used is upstream's own deployment, which this fork does not operate. The result was a capability that looked present in the code and reported "up to date" forever, and published release notes that told users to upgrade by hand.

The distribution channel that does exist is the fork's own GitHub Releases: an installer is uploaded as a release asset there. Nothing in the product read it.

## Decision

**One backend seam.** `DesktopUpdateCoordinator` no longer depends on `electron-updater`. It drives a `DesktopUpdateBackend` — `check()`, `download(request)`, `install()` — and keeps everything else it already owned: the coalescing of in-flight checks and installs, the `DesktopUpdateState` it publishes to every window, the `beforeRestart()` step, and the ordering download → `beforeRestart` → installer → exit. `electron-updater` remains one implementation of that interface, used when a build does carry `app-update.yml`; it is no longer the only one.

**A GitHub Releases channel is the implementation this fork uses**, selected when no `app-update.yml` is present. It lists `https://api.github.com/repos/WPH666-py/Harness-CN/releases` with the `accept` and `user-agent` headers GitHub requires, and considers a release only when it is not a draft, its tag parses as a semantic version once a leading `v` is stripped, and it carries an asset named `Harness-CN-<version>-win-x64-setup.exe`. The newest qualifying release is offered only when it is strictly newer than the running version.

**A release that cannot be installed is never announced.** The asset requirement is part of choosing the release, not a later step: a release with no matching installer is skipped and the search continues, so an older release that *is* installable still wins over a newer one that is not. `download()` keeps its own refusal as a backstop for an asset that disappears between the check and the download.

**The releases list, not the "latest" release.** GitHub omits releases it flags as prereleases from `/releases/latest`. This fork ships release candidates — `0.1.5-rc.1` — and the flag is not reliably set on them, so depending on that endpoint would silently stop delivering updates the day someone ticked the box. Listing releases and filtering drafts is the behaviour that cannot be turned off by a release-time checkbox.

**Prereleases are offered to stable users on purpose.** The prerelease part of the version is kept, so semver orders `0.1.5-rc.2` above `0.1.5-rc.1` and `0.1.6-rc.1` above `0.1.5`, and neither side's prerelease status is filtered. For a fork whose every release is a candidate, filtering would mean never updating.

**Integrity is checked, and its absence is reported rather than hidden.** The asset is downloaded into a directory under the platform temporary directory and hashed in the same pass that writes it, so the ~194 MB file is read once. The result is compared against the `sha256:` digest the GitHub API reports for that asset; a mismatch deletes the file and refuses to run it. A release whose asset carries no digest — GitHub only began exposing the field recently — is installed unverified, and the update state says so instead of implying a check that did not happen.

**The installer upgrades in place.** Installation starts the NSIS installer with its silent `/S` switch and lets it replace the previous version. The shell never uninstalls first: if the install then failed, the user would be left with neither version.

**Exit is explicit and injected.** The old implementation got the process exit for free from `electron-updater`'s `quitAndInstall`. The new backend deliberately does only the spawn, so the coordinator takes a `requestExit` callback and calls it after the installer has started, on the success path only. The shell flushes its log and calls `app.quit()` rather than `app.exit()`, because the installer is about to touch files that a clean teardown stops holding open.

**Skipping is remembered per version.** The skip button persists the version it was pressed for, and that version is suppressed for the *automatic* check only. A manual **Check for Updates…** still asks about it — the user explicitly asked — and a strictly newer release is offered again.

## Alternatives considered

- **`electron-updater`'s GitHub provider.** Rejected: it resolves an update through channel metadata such as `latest.yml` published beside the installer, and the trigger here is "an installer was uploaded to the release". Requiring a second generated file to be uploaded correctly is a silent-failure surface with no benefit for a fork that already names its asset after the version.
- **Emitting `publish` for the unsigned build so `app-update.yml` exists.** Rejected: it would declare a channel nothing serves, and enabling the block also arms electron-builder's own publishing, which this build must not do.
- **Uninstall, then install.** Rejected for the reason recorded above: a failure between the two steps leaves the machine with nothing.
- **`app.exit()` after starting the installer.** Rejected: it skips the `before-quit` teardown, which is exactly what must run before the installer replaces the files.
- **Treating "no digest" as a hard failure.** Rejected: it would make every release created through a path that omits the field permanently uninstallable, when the field's absence says nothing about the bytes. The state reports the weaker guarantee instead.

## Consequences

- The update flow now works in the unsigned build, which is the only build this fork ships, without code signing, without `publish`, and without a second uploaded metadata file.
- The channel is a repository identity, not configuration: `WPH666-py/Harness-CN` is a constant, and a build that checks elsewhere is a different product build.
- The release-time invariant is now load-bearing: **the uploaded asset must be named after the same version as the release tag.** A mismatch makes the release uninstallable, which the asset requirement degrades to "no update offered" rather than a prompt that fails after the download. The fork's upload script names the installer from a hardcoded filename while the tag comes from elsewhere, so the two can drift.
- GitHub's unauthenticated API ceiling is 60 requests per hour per address. One check per launch is far inside it, and a 403 or 429 is classified as throttling rather than a broken channel; the automatic path stays silent on every failure.
- The download comes from `github.com`, which is slow or unreachable from some networks. The transfer therefore carries a stall timeout, an overall deadline, and progress reporting, and a manual check surfaces a real error instead of appearing to hang.
- macOS and Linux builds of this fork are unaffected: the channel is Windows-only and is only selected where the unsigned path is taken.

## Testing

`apps/desktop/tests/update-github-backend.spec.ts` covers version choice in both directions, the asset requirement and its fall-through to an older installable release, the releases-list-over-latest decision, digest agreement and mismatch, the absence of a digest, the stall and overall bounds on the transfer, and the refusal to download a version the check did not retain. `apps/desktop/tests/update-coordinator.spec.ts` covers the backend seam: the download → `beforeRestart` → install → exit ordering, that a successful install exits exactly once, that a failed install does not exit, and that the skip record suppresses only the automatic path. Every fake fetch honours `init.signal`, because a stub that ignores it makes a deadline test pass vacuously rather than fail.

Beyond the unit tests, the channel was exercised against the real GitHub API: version choice, asset lookup, and digest parsing were run against the live release, and a range request against the real asset URL returned `206` with an `MZ` executable header. That proves every link except the full interactive round trip, which needs a second published release to observe.

## Related

- [Electron Desktop packaging and updates](2026-08-25-electron-desktop-packaging-and-updates.md) owns the signed release unit, the seed transport, and the electron-updater path this note adds a second backend beside.
