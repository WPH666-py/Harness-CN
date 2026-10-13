# Agent Note: An installed profile restores only the plugins its user added

Status: implemented

English | [中文](2026-10-13-profile-upgrade-plugin-restore.zh.md)

## Problem

Rebuilding a desktop profile while updating an existing install failed at the step that puts back
the plugins a user had added:

```
dsh shell: prebuild failed: desktop project: pnpm exited with 1
```

The rebuild materializes the released tree, then runs `pnpm add <plugins> --save-exact --offline` in
the staging profile to restore what the user had installed. Two things about that step were wrong.

It ran before activation. A materialized tree's dependencies are linked from the profile's final
location, so pnpm refuses the virtual store the staging path implies
(`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`) — the step could not succeed where it stood.

It also read the wrong plugin set. `materializeProfile` selected the plugins a profile records with
`bundled[plugin.name] !== plugin.version`, so a bundled plugin whose recorded version differed from
the one this release bundles was read as a user's choice. A profile written by rc.21 records
`dsh-wechat` 0.8.0 while rc.22 bundles 0.10.0, so every upgrade of an existing install tried to
restore a package the seed already carried, offline, from a registry the step is not allowed to use.

Both defects sit on the same path as the missing comma in the pnpm record
(`2026-10-14-profile-modules-record-comma.md`): that one stopped pnpm first, and this one stopped it
again once the first was repaired.

## Decision

`materializeProfile` restores only the plugins this release does not bundle
(`bundled[plugin.name] === undefined`): the version recorded in a profile is the pin of the release
that wrote it, not a user's choice, and the tree already carries the version this release ships.

`rebuildRuntime` restores the user's plugins after activation, where the tree is where its own links
say it is, and reports a failure instead of failing a launch that already succeeded — the profile
works without that plugin either way.

## Alternatives considered

Restoring plugins against the final profile path before activation (rejected: the install would
mutate the profile that is still running, and a rebuild that fails halfway would leave it half-moved).

Reading the user's plugin set from `dsh.profile.bundles` (rejected: the bundles list also names the
plugins this release activates, so it cannot separate a user's additions from ours; the recorded
dependency version can).

Treating a differing version as a user upgrade and installing it from the desktop registry
(rejected: the rebuild runs offline by design, and a pinned bundled plugin is the release's decision,
not a request to fetch something else).

## Consequences

An existing install upgrades in one pass: the plugins this release bundles come from the seed, and
only the plugins the user added are restored — after the tree is active, where pnpm agrees with its
links. `project-manager.spec.ts` covers a bundled plugin recorded at an older pin next to a user's
plugin, and asserts that only the user's plugin reaches pnpm.
