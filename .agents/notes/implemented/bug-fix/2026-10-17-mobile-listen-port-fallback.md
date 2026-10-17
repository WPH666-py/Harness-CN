# Agent Note: An occupied LAN port aborted the whole plugin tree, so dsh-mobile now falls back to a free port

Status: implemented

English | [中文](2026-10-17-mobile-listen-port-fallback.zh.md)

## Problem

After 局域网访问 was enabled in the installed desktop app, every restart opened `Harness-CN 启动失败` with:

```
dsh desktop: plugin tree failed to load: failed to apply loader entry
mobile-access (dsh-mobile): listen EADDRINUSE: address already in use 192.168.1.16:3443
```

The panel's 完成配置 had written `listenPort: 3443` into `~/.harness-cn/mobile-access/setup.json` and `{"enabled":true}` into `control.json`, so from then on the plugin tried to bind that exact address during boot. The port was held by another program on the same machine — the other desktop app (DSH NEXT) runs the same `dsh-mobile` plugin with LAN access enabled on the same host and port. Two applications of the same product legitimately coexist on one machine; that must degrade the plugin, not the application.

## Cause

The `mobile-access` loader entry starts its gateway while the plugin tree loads (`apply` → `startGateway` → `startRuntime`). `startRuntime` tolerates only a network-selection error and rethrows everything else:

```ts
if (!isNetworkSelectionError(error)) throw error;
```

An `EADDRINUSE` from `server.listen` is a raw Node error, not a network-selection error, so the rethrow reached the loader as `failed to apply loader entry mobile-access (dsh-mobile)` and aborted the whole tree.

The listen site itself had no fallback: `MobileAccessGateway.start()` called `server.listen(this.config.listenPort, this.config.listenHost, …)` and surfaced the failure. Upstream 0.6.10 still has no LAN-port handling — it only maps `EADDRINUSE` to a `409 listen_port_in_use` for the cloudflared/caddy paths — so upgrading dsh-mobile is not a fix.

## Evidence

- The failing boot logged, at `C:/Users/admin/AppData/Local/com.harnesscn.desktop/logs/harness.log`: `[shell] startup failed: dsh desktop: plugin tree failed to load: failed to apply loader entry mobile-access (dsh-mobile): listen EADDRINUSE: address already in use 192.168.1.16:3443`.
- `netstat -ano` showed `192.168.1.16:3443` owned by the other desktop app, whose own `C:/Users/admin/.dsh/mobile-access/setup.json` also declared `listenPort: 3443`.
- With the other app still holding 3443, the patched build (`714 003` B, sha256 `ad6af19b470c524b46bd8eab1d24d01348491c81818b3ec5f4505cca4783074a`) started normally, logged `(node:24452) [DSH_MOBILE_LISTEN_PORT_FALLBACK] Warning: DSH Mobile: 192.168.1.16:3443 is already in use; listening on 192.168.1.16:3444 instead.`, listened on `192.168.1.16:3444`, and rewrote `setup.json` to `listenPort: 3444`.
- The panel then rendered `局域网访问已开启` with `https://192.168.1.16:3444`, and `https://192.168.1.16:3444/` answered `401 {"error":"authentication_failed"}` — the TLS listener is up and waiting for pairing.

## Decision

Patch the vendored plugin at packaging time, in `apps/desktop/scripts/patch-mobile-listen.mjs`, reusing the mechanism of the existing `patch-rule-engine.mjs` / `patch-wechat-*.mjs` steps: rewrite the plugin source in the profile's `node_modules`, verify it, and fail packaging if the anchors moved.

The patch does two things.

1. Before the gateway starts, `pickFreeLanPort` keeps the configured port when it is free and otherwise walks the next 20 ports (finally an ephemeral `0`), rewriting both `publicOrigin`/`listenPort` in the config and the persisted `listenPort` in `setup.json` when the setup is managed, so the QR and pairing links carry the port that actually listens.
2. In the boot catch, `EADDRINUSE` and `EADDRNOTAVAIL` become non-fatal warnings, so even a fully exhausted search downgrades the plugin instead of the app.

Each rewrite is guarded by the `DSH_MOBILE_LISTEN_PORT_FALLBACK` marker and validated with `node --check` on a temporary copy; `prepare-seed` patches the profile it materialises and then asserts the marker is present, and `verifyOfflineInstallation` fails the build (`desktop seed: the profile the seed produced has no patched dsh-mobile`) if a future dsh-mobile release moves those anchors.

## Alternatives considered

- **Upgrade dsh-mobile.** 0.6.10 still binds the configured port unconditionally and treats `EADDRINUSE` as fatal at boot, so an upgrade would not change the outcome.
- **Ask the user to disable the other app's LAN access.** It works once, but the two applications are meant to be usable side by side, and the failure returns the moment either one holds 3443 first.
- **Swallow every boot error in `startRuntime`.** It would hide genuine failures (bad TLS material, invalid config) behind the same silent warning.
- **Send the fix upstream.** It is the right long-term home, but the fork has to ship now; the marker keeps the patch removable once upstream falls back on its own.

## Consequences

- Two apps can expose LAN access at the same time: the second one moves to the next free port and tells the user which address to pair with.
- The persisted `listenPort` follows the listener that actually started, so a later boot prefers the port that worked last; a client that bookmarked the old port has to re-pair.
- Packaging now depends on the plugin's `startGateway` and boot-catch anchors. When a dsh-mobile upgrade changes them, the seed build fails with a named error instead of silently shipping an unpatched plugin.
- The patch is visible in the run log as a `[DSH_MOBILE_LISTEN_PORT_FALLBACK]` warning, so support can tell a moved port from a broken one.
