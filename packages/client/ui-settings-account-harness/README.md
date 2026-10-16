---
description: "Desktop-only DeepSeek account settings row for the dsh web client: sign-in with live phase status, two balance rows, an acknowledged granted-bonus notice, and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account-harness

English | [中文](README.zh.md)

## Summary

**Account & balance** is the DeepSeek account surface for the desktop distribution: a single Settings section row that signs in, shows both balance rows, surfaces granted bonus credits, and signs out. It registers one `settings.section` contribution through `ctx.slots.inject()`, so it appears only where the desktop host rows provide `remote.account` and applies nothing elsewhere. The row is the whole interface — no heading, description, or standing copy — and every view it renders, including a live sign-in phase and the notice card, is a snapshot subscription that the section's own mount owns.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The **Account & balance** row is one line in Settings and the whole account surface on the desktop distribution: it is the interface, with no heading, description, or other standing copy, so it renders only the state it currently holds and the single action that state offers.

### Signed out

Signed out, the row offers sign-in, which calls `startSignIn(client, window.location.origin, 'desktop')` — the current page origin becomes the return address and `'desktop'` selects the desktop client kind. While an attempt reports a phase (`initializing`, `waiting-browser`, `exchanging`, `committing`, `expired`), a status line replaces the action and a cancel is offered in its place; with no attempt in flight the row shows the sign-in action alone. When an attempt reaches `waiting-browser` the row opens its `authorizeUrl` once in a new window — the account service produces the URL but nothing else opens it — and keeps an `open` link beside the status line for a carrier that refuses the automatic request.

### Signed in

Signed in, the row shows two balance rows — topped-up balance and granted balance — with granted wallets filtered to a positive balance, then the platform links carried by the account state (`usageUrl`, `topUpUrl`), then sign-out. Sign-out asks the host's `hasRunningAccountTasks()` first and picks one of three confirmation texts from the answer, so a sign-out click never claims more than the host can confirm.

### The granted-bonus notice

Unnotified granted credits are read once when the account enters the signed-in state and once when the section mounts — never on a timer. The first one renders as a non-modal card whose text is the server's own `message`; a notice whose `expiresAt` has already passed is dropped rather than shown late. Showing the card queues exactly one acknowledgement per order (`ackBonusNotified(accountId, orderId, client)`), and a successful acknowledgement refreshes the balance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The section is a pure render of one snapshot: `src/client/AccountSectionController` owns a `SnapshotStore<AccountSectionState>` and subscribes to the account state stream, so the view cannot drift from the state it was handed.

### Registration

The browser plugin registers one localized `settings.section` contribution with id `account`, `order: -10`, and `locale: 'settings.account'`; its label is the `nav` key. Registration goes through `ctx.slots.inject('settings.section', ...)` with `inject = ['slots', 'locale', 'remote', 'remote.account']`, so it follows late declaration, redeclaration, locale changes, and teardown without importing the section owner. There is no product gate: where the account host packages are absent, `remote.account` never appears and the plugin applies nothing. The upstream Client package (`@deepseek-ai/dsh-client-ui-settings-account`) registers into `settings.launcher`, `settings.models.sign-in`, and `shell.quota-notice`, none of which this line's slot registry declares, which is why this line owns its own browser half.

### State and lifecycle

`AccountSectionState` carries `view`, `profile`, `balance`, `failed`, `busy`, and `notice`; the controller feeds it from `ctx.remote.$stream` over `account.watch`. The section renders that snapshot and holds only one piece of local state, the sign-out confirmation. Every subscription lives in the plugin's injected callbacks, so unmounting the section cancels its stream and its retries.

### Acknowledgement

Acknowledgement is a retry loop owned by the mount: `ackBonusNotified` is attempted while the section stays mounted, with the delay doubling from 1000 ms to a 60 000 ms cap.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the Settings domain this row registers into, the Remote surface behind it, the sibling rows it sits beside, and the locale layer its copy resolves through.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section`.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `account.watch`, `startSignIn`, and `ackBonusNotified`.
- [ui-settings-general](../ui-settings-general/README.md) — sibling Settings rows built from the same primitives and locale conventions.
- [locale](../locale/README.md) — the dictionary layer the `settings.account` copy resolves through.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings row that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe how the row behaves on the desktop distribution; they are current package constraints.

- **External links in the Electron development shell** — the shipped Tauri shell answers a page's new-window request by handing the address to the platform browser (only `http` and `https`, never loopback), so the `authorizeUrl` the row opens once an attempt reaches `waiting-browser` and the `usageUrl`/`topUpUrl` links open normally in the shipped app; the Electron shell used for development denies every new window, automatic or clicked, so the attempt page never appears there and the `open` link beside the status line is the only thing left.
- **Best-effort acknowledgement** — a failed `ackBonusNotified` is retried only while the section stays mounted, so closing the section early leaves the credit unnotified (the safe direction).
- **Sign-out confirmation depends on a host read** — when `hasRunningAccountTasks()` fails, the unknown case asks the same question with a weaker claim rather than blocking sign-out.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The host rows that provide `remote.account` — `authorization`, `deepseek-account`, and `account-controller`, at `0.1.7-rc.2` — are inserted by `apps/desktop-host/config/desktop.cordis.patch.yml`, the desktop patch layer rather than a bundle patch, because those packages are installed only by the Desktop seed; `deepseek-account` derives `desktopPlatform` from `process.platform`.

</details>

**Runtime invariant:** No companion is published. This package owns a desktop-only Settings contribution.
