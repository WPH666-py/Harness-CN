# Agent Note: Desktop bundled plugin set and the offline package size

Status: implemented

English | [中文](2026-10-16-desktop-bundled-plugin-set-and-offline-package-size.zh.md)

## Problem

A fresh Desktop profile only carries the plugins the release bundles: `apps/desktop/src/bundled-plugins.ts` is the list the seed warms its pnpm store from, the profile manifest is copied from that seed, and `dsh.profile.bundles` activates the rows. Three capabilities users ask for were outside that list, so a first launch without a registry could not load them: white-box long-term memory, image recognition for text-only models, and the WorkBuddy desktop app's own model provider.

Adding them is not free in one dimension the release cares about. The offline package is one archive of the whole seed, it is published as a release attachment, and Gitee caps an attachment at 100 MiB; at rc.26 the build refused to produce an archive past that cap, so a release nobody could download failed at build time rather than at the upload. The memory plugin alone is the largest package this repository bundles by two orders of magnitude — npm reports 42.4 MiB unpacked (44 434 676 bytes) — and the rc.25 seed was already 96.9 MiB (101 604 376 bytes) at zstd level 22.

## Decision

Three entries join the bundled set with exact pins, each documented in place; two of them are listed as active rows:

- `@furongjun1999/dsh-memory` `0.8.1` — a host row plus the knowledge tree its tools read; every package it imports at runtime (`dsh-session`, `dsh-system-prompt`, `dsh-tools`) and every peer it declares is one this profile provides.
- `@lp181818/dsh-vision-plugin` `1.2.3` — image recognition for text-only models, configured from its own Settings page. It is distinct from `@anionex/dsh-vision-toolkit`, which stays inactive because it provisions a Python runtime on first use; this one is 44 KB of JavaScript whose host half imports only `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`. It is installed and pinned without being listed, because its browser half waits on a `configForms` service this line's Client does not have, and the pending wait failed the whole Web boot. [That decision](../bug-fix/2026-10-16-desktop-vision-plugin-config-forms.md) owns the mechanism and the alternatives.
- `dsh-workbuddy-connect` `0.6.5` — the WorkBuddy desktop app's model serving, mounted as an `llm-workbuddy` provider row that starts no OAuth flow and does not change the default model. It is pinned to the last release of its 0.1.5 corridor because 0.7.0 and later fix every dsh peer at `0.2.0-rc.2`, a line this product does not carry, while 0.6.5 accepts `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.1` for the seven seams it needs; its one outside peer, `@earendil-works/pi-ai`, is already installed at exactly the version it asks for, because `dsh-llm-pi-ai` depends on it.

Versions stay exact because three places must agree: the pnpm store `prepare:seed` warms, the profile manifest copied from the seed, and the `dsh.profile.bundles` list. `verifyOfflineInstallation` catches a drifted pin at build time instead of on a user's machine.

The seed-size ceiling stops binding the build. `apps/desktop-shell/scripts/prepare-shell.mjs` still reads `HARNESS_CN_SEED_LIMIT_MB`, but it now defaults to `0` — no ceiling — because the release process answers the publication constraint directly: `scripts/release/split-offline-package.mjs` cuts the archive into fixed-size parts (64 MiB each) plus a manifest carrying every part's sha256 and the whole archive's, GitHub keeps the whole file, and Gitee carries the parts. A release that has to stay publishable as one attachment sets the variable to its host's cap and gets the loud failure back.

## Alternatives considered

**Leave the three unbundled and let users install them.** Rejected: the capability a fresh offline profile does not carry is the capability this change exists to ship, and the memory plugin is exactly the kind of package a user cannot evaluate before the first launch.

**Drop the memory plugin to stay under Gitee's cap.** Rejected: it is the feature. The cap is a publication constraint, not a reason to withhold the package the other two additions are less than a tenth the size of.

**Split the offline package into a core archive and an extras archive.** Not taken: the first-launch path fetches one file and validates one inventory, so splitting the *seed contract* is an architecture change to identity, integrity, and the store merge rather than a release-time choice. What release 0.1.5-rc.27 does instead is split the *attachment*: byte-range parts of one unchanged archive, concatenated before use, which leaves the contract intact and still fits a host that caps one file.

**Raise the zstd level above 22.** Rejected: 22 is the highest standard level the encoder accepts, and the measured gain from 19 to 22 is already spent (rc.24: 124.1 MiB at 19, 97.0 MiB at 22).

**Keep the cap hard and skip publishing the offline package when it is oversized.** Rejected: the installer never carries the seed, so omitting the seed from a release leaves first launch downloading a package that no host offers — a broken release rather than a smaller one.

## Consequences

The rc.26 seed is 122.2 MiB. Release 0.1.5-rc.27 publishes it whole on GitHub and as parts on Gitee, whose per-attachment cap is why the parts exist: a downloader concatenates them in name order and checks the whole-archive digest the manifest carries, and both hosts serve the same installer.

Every installed profile now carries the memory plugin's files and the two smaller additions, and the memory plugin and the WorkBuddy provider load without a registry because the seed store holds their closures; the vision plugin's files ship as well, unlisted and therefore never mounted, for the reason [its own note](../bug-fix/2026-10-16-desktop-vision-plugin-config-forms.md) records. The memory plugin's own bundle patch is a single insert, and the two others carry their own patches, so no Desktop patch layer gained a row for them.

The seed-size guard is opt-in rather than default-on: a build ships whatever it produced unless `HARNESS_CN_SEED_LIMIT_MB` names a ceiling. That is deliberate — the ceiling belongs to a publication decision the build cannot make, and the release process no longer needs one.

The [DeepSeek account and bonus credits](2026-10-16-desktop-deepseek-account-and-bonus-credits.md) note owns the other packages that entered the same seed, including the official client package this release removed, which partly offsets the growth here.
