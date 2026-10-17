# Agent Note: A paired phone fell back to the login page within the hour, so dsh-mobile now keeps a session for a year

Status: implemented

English | [中文](2026-10-17-mobile-pairing-persistence.zh.md)

## Problem

The feature is sold as "scan once, keep using it": 局域网访问 stays enabled, the desktop app stays open, and the phone opens its link whenever the user picks it up. In practice the phone kept asking for things it had already been told:

- after roughly three quarters of an hour of not being used, the app address opened the DSH login page (`/mobile-access/login`) instead of the app;
- the pairing link from the desktop panel's QR code, kept in the phone's browser history, opened `{"error":"not_found"}` a couple of minutes after it was scanned;
- a phone that had not been used for three months stopped renewing altogether and had to be scanned again.

None of these are failures: they are the shipped defaults. They are simply defaults chosen for a demo, not for a desktop app the user leaves running.

## Cause

`dsh-mobile` compiles its three lifetimes into the config parser, so no setup file can raise them:

```js
const deviceTtlMs = integer(value.deviceTtlMs, "deviceTtlMs", 7776e6, 6e4, 316224e5);
const sessionTtlMs = integer(value.sessionTtlMs, "sessionTtlMs", 288e5, 3e4, 864e5);
```

`288e5` is 48 minutes for a session, and the schema caps a session at `864e5` — one day — while a paired device gets 90 days (`7776e6`). The pairing window is worse:

```js
pairingTtlMs: integer(value.pairingTtlMs, "pairingTtlMs", 12e4, 1e4, 6e5),
```

two minutes by default, ten at most. Once it closes, the pair route stops answering:

```js
if (!this.access.pairingStatus().open) throw new HttpError(404, "not_found");
```

The recovery path that exists is sound but narrow: `/mobile-access/login` runs `renderLoginScript`, which POSTs `/mobile-access/auth/renew` with the device cookie and continues to the app when that succeeds. So a lapsed session is recoverable — but only while the 90-day device lives, and only if the user opens the app address rather than the dead pairing link.

## Evidence

- In the installed profile `C:/Users/admin/.harness-cn/profiles/desktop/node_modules/dsh-mobile/lib/index.mjs` (0.6.4), the three literals are at lines 1086 (`deviceTtlMs`), 1087 (`sessionTtlMs`) and 1111 (`pairingTtlMs`); the pair-route gate is at line 5772.
- Opening `https://192.168.1.16:3443/mobile-access/pair` in Edge after the panel's window had closed rendered exactly `{"error":"not_found"}` — the 404 branch above, not a routing problem: `/mobile-access/pair` renders normally while the window is open.
- The patched module parses (`node --check`) and is `717 257` bytes, sha256 `782c1bed7bffcf0508f27533b2a12303ccfee21d579b00ba563d88360f00c9e6`; the seed step reports `patch-mobile-session: patched … (717257 bytes, sha256 782c1bed…)` and exits 0.

## Decision

Patch the vendored plugin at packaging time, in `apps/desktop/scripts/patch-mobile-session.mjs`, the same way `patch-mobile-listen.mjs` and the `patch-rule-engine.mjs` / `patch-wechat-*.mjs` steps do: rewrite the installed bytes while `prepare-seed` builds the seed, verify the result, and fail packaging if an anchor moved.

1. The session and the paired device both default to a year (`31536e6` ms); the session ceiling rises to the device ceiling (`316224e5`), so a phone is never sent back to a login page mid-use and still renews silently after the app restarts.
2. The pairing window defaults to its own ceiling, ten minutes (`6e5`, still clamped to `1e4…6e5`), which is how long walking over with a phone actually takes.
3. A closed pairing window now answers with a page instead of a 404: it retries `/mobile-access/auth/renew` in the background (a paired phone lands in the app immediately), and otherwise says where the QR code lives in the desktop panel and links to `/`.

Each rewrite is guarded by the `DSH_MOBILE_SESSION_LONGEVITY` marker and validated with `node --check` on a temporary copy outside the installed tree; `prepare-seed` patches the profile it materialises and `verifyOfflineInstallation` fails the build (`desktop seed: the profile the seed produced has no long-lived dsh-mobile sessions`) when a future release moves those anchors.

## Alternatives considered

- **Configure the lifetimes instead of patching.** Impossible as shipped: the defaults and ceilings are arguments to `integer(…)` inside `parseGatewayConfig`, and a setup file cannot exceed the compiled ceiling.
- **Persist sessions across restarts.** Larger change to plugin state for the same outcome; the device cookie already renews a fresh session, so a restart only costs one invisible round trip.
- **Keep the 90-day device and only lengthen the session.** The session is what lapses in daily use, but the device is what lapses across a season; lengthening one and not the other moves the annoyance, not removes it.
- **Upgrade dsh-mobile.** Current releases still compile the same three defaults, so an upgrade would not change the outcome.

## Consequences

- A phone that was scanned once keeps working for a year of app restarts, and the link in its history explains itself instead of showing a bare 404.
- The tradeoff is explicit: a paired phone's cookie now outlives its old 90-day window. The panel's device list is the revocation tool, and removing a device still ends its access on the next renew.
- Packaging now depends on three literal anchors plus the pair-route gate. A dsh-mobile upgrade that moves them fails the seed build with a named error instead of quietly shipping the old lifetimes.
- The patch is visible in the seed log as `patch-mobile-session: patched …` (or `already` when a cached tree is reused), so a build that skipped it is identifiable.
