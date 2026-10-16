# Agent Note: Desktop vision plugin mounting and the absent configForms service

Status: implemented

English | [中文](2026-10-16-desktop-vision-plugin-config-forms.zh.md)

## Problem

The 0.1.5-rc.27 desktop shell opened on the Client's failure screen instead of the chat:

```text
Failed to load plugins
web boot: 2 entries did not activate
@lp181818/dsh-vision-plugin: pending (waiting for service: configForms)
```

`apps/desktop/src/bundled-plugins.ts` listed the vision plugin as an active row, so the profile's `dsh.profile.bundles` composed the insert its own `cordis.patch.yml` carries, the host loaded the row, and `packages/client/modules` created a browser entry for it because the package declares `dsh.client`. That browser half declares `inject = ['slots', 'locale', 'configForms']` and reads `ctx.configForms.get('vision-plugin')` at the top of `apply`, before the `settings.section` seat it registers at the end of the same function. `configForms` is the 0.1.7-line plugin config-form service; nothing in this profile provides it, and Cordis leaves an unsatisfied service inject pending with no timeout. The Client turns exactly that state into the message above (`packages/client/web/src/boot.ts`), renders it as `Failed to load plugins` (`packages/client/web/src/boot-page.ts`), and abandons the boot — one third-party row took the whole Web GUI down with it.

The service this line does have is the same feature under another name, not a missing capability: `SettingsScopeBinder` (`packages/client/ui-settings/src/client/settings-scope.ts`) binds a `settingsScope` controller per namespace with `getSnapshot`, `subscribe`, and `mutate`, which is the contract the plugin's own duck-typed adapter calls — `scope.getSnapshot().value`, `scope.getSnapshot().revision`, `scope.subscribe(publish)`, and `scope.mutate(ops)` with `{ op: 'set', path: [field], value }` operations. It also registers into `settings.section`, the slot this line's own settings packages register into. So this is not a package the line cannot host; it is a package whose browser half asks for a later line's service name.

## Decision

The plugin stays installed, stays pinned at `1.2.3`, and stops being listed: `active: false` in `apps/desktop/src/bundled-plugins.ts`, with the reason and the evidence above in the entry's own comment, and with the `active` doc comment naming this as the fourth kind of installed-but-unlisted entry.

Unlisting is what removes the wait, because the bundle list is the only thing that mounts the row. `createSeedMetadata` writes the seed manifest's `dependencies` from `bundledPluginDependencies()` (every entry, active or not) and its `dsh.profile.bundles` from `bundledPluginNames()` (active entries only), and `loadProfileDirectory` (`packages/boot/app-boot/src/profile.ts`) composes rows from that list alone. `materializeProfile` then copies the seed's metadata over a staged profile and never restores a bundled name as a user plugin, so both a fresh profile and one rebuilt from a release seed carry the shorter list. The plugin's own patch is not reached by any other layer: `apps/desktop-host/config/desktop.cordis.patch.yml` names no vision row.

Nothing else about the activation check changes. The failure screen still reports a pending entry with the service it waits for; what this change removes is the wait.

## Alternatives considered

**Provide a `configForms` service from this line's Client.** Rejected, because it is not a neutral compatibility seam: a bundled plugin already probes for that name. `dsh-chat-import` `0.17.1`, listed active, reads `ctx.get('configForms')` on the client root and, when that service exists, refuses to register its own `settings.section` page — the newer host moves plugin settings into the `plugins.bundle.config` slot, which this line's Client does not declare. Providing the name would therefore remove a working plugin's settings page so that another one could have a page of its own, and keeping both would mean implementing the newer `plugins.bundle.config` slot and its per-plugin config surface in this line — a capability far larger than the defect it would fix. The service name also belongs to a line this product does not carry, and any shim over `settingsScope` would have to be re-derived against each upstream release that renames or extends it.

**Patch the published bundle so it stops naming the service.** Rejected for the reason the [DeepSeek account note](../feature/2026-10-16-desktop-deepseek-account-and-bonus-credits.md) already recorded about `"configForms"` in the same inject list: such a patch has to be re-verified against every upstream release of a package this repository does not own. It is also the wrong shape here — the inject list and the `ctx.configForms` read are one module, so dropping the name means rewriting the read as well, and the plugin would then need a binding to this line's settings service anyway.

**Remove the plugin from `BUNDLED_PLUGINS` entirely.** Rejected: the entry is the pin and the record. Without it the package is no longer installed by the seed, nothing in the tree says why it must not be mounted here, and `assertNotBundled` stops refusing the name — a user could install `1.2.3` by hand into the same profile and reproduce the failed boot, with no note in the source to explain it.

**Move the pin back to an earlier release whose browser half asks only for `slots` and `locale`.** Not taken: no earlier release is present in the profile's `node_modules`, so the version that would work cannot be identified from this tree, and choosing one needs a registry round trip and a re-warm of the seed store — for a capability whose settings page this line can render only through an adapter the unlisted entry already leaves one line away.

## Consequences

The desktop boot no longer waits on `configForms`, and the vision plugin's Settings page is absent from the app until a later line provides that service or the package stops injecting it. The capability is not gone from the machine: the package keeps its files in the seed store and in every installed profile, exactly like the three companions that ship installed but unlisted, and its host half is a row the profile no longer composes.

`apps/desktop/tests/bundled-plugins.spec.ts` pins both halves of the state: the plugin is installed and pinned while `bundledPluginNames()` leaves it out, and a seed manifest written by `createSeedMetadata` carries it in `dependencies` while `dsh.profile.bundles` omits it.

The fix reaches a user only through a rebuilt desktop bundle. The seed manifest is what a profile copies its bundle list from, so an installed rc.27 profile keeps the row until it installs a build whose seed omits it; the installer, the archived pnpm store, and the profile manifest move together in that build.

This note partially supersedes [the bundled plugin set note](../feature/2026-10-16-desktop-bundled-plugin-set-and-offline-package-size.md), which counted the vision plugin among the entries that activate. That note stays active for the set, the pins, and the seed-size decision it owns, and now points here for this entry.
