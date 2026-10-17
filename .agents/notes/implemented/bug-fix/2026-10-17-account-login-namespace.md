# Agent Note: The account section mounts its own Remote namespace and reads it back through the wrong context

Status: implemented

English | [中文](2026-10-17-account-login-namespace.zh.md)

## Problem

The settings dialog of the rc.28 desktop build rendered 账号与余额 with `充值余额 登录后查看`, `赠金余额 登录后查看` and a **登录** control that did nothing: clicking it left the control disabled and no account state ever arrived. The Harness log held no `[deepseek-account]` line at all, so no request had reached the Host — the browser sign-in flow never started, even though the platform, the controller and the section are all present in the payload.

The section is otherwise complete: `startSignIn` on the Host posts `/auth-api/v0/dsh/auth_init` and yields the platform authorize URL, the shell opens that URL in the system browser, and the callback exchanges the code. Only the first step — the plugin reaching its own namespace — was broken.

## Cause

`packages/client/ui-settings-account-harness/src/client/index.ts` declares `export const inject = ['slots', 'locale', 'remote']` and installs `remote.account` from its own `apply` body:

```ts
const unmount = await ctx.remote.$mount(accountRemote)
```

The state store then read the installed namespace back through the injected projection, `this.ctx.remote.account` (`account-store.ts`). Cordis resolves dotted service names on `ctx.remote` through the service proxy, and that proxy refuses any name the fiber did not declare in `inject`:

```text
RemoteError: cannot get property "remote.account" without inject
```

The plugin cannot declare `remote.account`: it installs that service itself, so its fiber would wait for its own contribution and never start. Every account call therefore threw — the state stream's `open` callback produced the failed stream (so the section kept its signed-out defaults), and `signIn()` set `busy` before resolving the namespace, leaving the row busy forever and the control disabled.

## Evidence

- The shipped rc.28 client threw `cannot get property "remote.account" without inject` inside the dialog; captured over the WebView2 debugging port together with the section's default markup.
- `harness.log` had zero `[deepseek-account]` entries for the whole run. After reading the namespace from the registry instead, one click produced `POST /auth-api/v0/dsh/auth_init` → `200` (`code: 0`) and the section switched to `请在浏览器中继续` with a cancel control and the authorize link — `https://platform.deepseek.com/dsh/authorize?authorize_id=…`.
- The browser hop needed no change: the authorize anchor already carries `target="_blank" rel="noreferrer"`, and the desktop shell denies in-window navigation away from `127.0.0.1` while routing non-loopback new windows to the system browser (`apps/desktop-shell/src-tauri/src/main.rs`, `open_in_browser`), so the platform page opens in Edge.
- Every workspace package that consumes a namespace another plugin mounted declares it in `inject` (`packages/api/workspace-controller/src/client/index.ts:38`, `packages/client/ui-settings/src/client/index.ts:43`, and the other settings sections), which is exactly what a self-mounting package cannot do.

## Decision

Read the service the plugin installed from the registry, and make local failures visible:

- `AccountSectionController.account()` now returns `this.ctx.get('remote.account')`, and throws a named error when it is absent instead of relying on the projection guard. The doc comment records why `inject` cannot name it.
- `signIn()`, `cancelSignIn()` and `signOut()` restore `busy` and set `failed` when resolving the namespace throws, so a local failure renders the failed arm instead of stranding the row disabled.
- The spec harness installs the fake namespace in a registry that backs `ctx.get` (and no longer through `remote.account`), plus one regression case that drives `signIn()` with the namespace absent and asserts `busy: false`, `failed: true`, and that no Remote call was attempted.

## Alternatives considered

**Declare `'remote.account'` in `inject`.** Deadlock: the service is contributed by this same fiber's `apply`, so the fiber waits on itself and the section never mounts.

**Move the mount into an ancestor plugin and inject the dotted name.** This is how the other settings sections consume namespaces, and it would let the UI package use the ordinary projection. Rejected for now: the account contribution comes from an npm package that only the desktop seed installs, so the ancestor would be the desktop client patch, which would then own a host-only dependency and a mount that is meaningless without the section. The registry read keeps the mount and the consumer in the package that owns both.

**Pass the namespace object down from `apply` instead of reading the context.** The controller also serves effects registered later (bonus notices, logout), and threading the object through them adds plumbing for no additional safety.

## Consequences

A plugin that installs a Remote namespace from its own `apply` must read it back through `ctx.get`, because the dotted projection is gated by a static `inject` declaration, not by runtime visibility. The published rc.28 installer carries the defect and cannot sign in; the fix ships with the next desktop payload.
