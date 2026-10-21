# Agent Note: The shell serves the GUI itself to a phone

Status: implemented

English | [中文](2026-10-17-lan-door-serves-the-gui-itself.zh.md)

## Problem

The desktop build shipped `dsh-mobile` as its phone access: a second HTTPS listener on port 3443, a private CA, a proxy in front of the loopback front door, and a rewritten page. Keeping it working took three build-time patches to the installed package (`patch-mobile-listen.mjs`, `patch-mobile-session.mjs`, `patch-mobile-panel.mjs`), and every fix uncovered the next failure: the phone refused the self-signed certificate; a browser that accepted it once kept the refusal across restarts because the leaf certificate was re-signed on every launch; the proxy fetched the page from the Host's private port, which answers `404`; the rewritten boot script overwrote `window.__DSH_TRANSPORT__` and threw; a one-year session lifetime overflowed `setTimeout`. rc.33 removed the plugin, and with it the access it provided.

## Cause

`dsh-mobile` models phone access as *a second origin that proxies the first*. Everything that can go wrong between two origins is therefore in the path: certificate trust, HSTS, cookie exchange, page rewriting, and upstream addressing. `D:\Claudecode-CN` does the opposite in `packages/bridge/src/remote.mjs` and `packages/bridge/src/webhost.mjs`: the bridge process *is* the web server, on plain HTTP, on the LAN interface, and it serves the app's own `dist/` at the origin the phone sees. Its source records the tradeoff it chose instead of a certificate: a phone will not trust a self-signed certificate without an install step, so there is no TLS; a cookie minted by a pairing step gates the app, and the page learns it was served by the bridge from `/bridge-origin.js`.

That model has one origin, one cookie, and nothing to rewrite. It is also what the shell already had available: `apps/desktop-shell/src/shell-server.ts` was already serving the GUI to the WebView by forwarding to the Host over the pipe transport.

## Evidence

- The removed patches and their wiring are gone from `apps/desktop/scripts/prepare-seed.ts`; `dsh-mobile` is out of `apps/desktop/src/bundled-plugins.ts`.
- `@linxin666/dsh-remote-web-ui@0.4.7` (the mobile half of `dsh-web`) cannot serve this carrier: it computes LAN bases only when `ctx.webServer.host === "0.0.0.0"`, and the desktop Host is pinned to `127.0.0.1:0` by `apps/desktop-host/config/desktop.cordis.patch.yml`, while the GUI the phone would need is served by the shell, not by the Host. Its aggregate `@linxin666/dsh-web-all` also relies on the 0.2.x `plugin:` row convention: on this line `packages/client/modules/src/index.ts` resolves a client row from the row's own module specifier and treats a subpath specifier (`@linxin666/dsh-web-all/remote-web-ui`) as "permanently not a client row", so 14 of its panels register no browser half.
- A harness against the real server (`_work/lan-door-test.mts`, later removed) produced: loopback `/` → `200 host:/` with the `hcn` cookie; `/shell-api/lan` → `200 {"enabled":false,"address":"192.168.1.16",…}`; LAN `/` with the door off → `200` and the `dsh-lan-door=off` notice; enable → a link; LAN `/` without the cookie → `notice=locked`; the link → `302` to `/` with `hcn_lan=…`; LAN `/` with that cookie → `200 host:/`; LAN `/shell-api/lan` → `403` ("answers this computer only"); `/shell-api/lan/qr` → SVG; rotate → the old cookie is refused; disable → `notice=off`.
- A second probe installed only `@linxin666/dsh-remote-web-ui@0.4.7` into a scratch profile on this line and opened the GUI: the header `200` carried the row, and the boot graph listed it, but the page never painted. Its `apply` injects `configForms`, a service this line does not provide (the 0.1.7-line plugin-configuration form registry; the local equivalent is `settingsScope`, which cannot stand in because `dsh-chat-import` probes that name and refuses its own settings page when it finds it). A pending entry makes the boot audit fail the whole page, so shipping that package here turns "no phone access" into "no GUI". The aggregate hides the same gap differently: its rows are subpath specifiers, so the client scan registers no browser half and nothing pending appears at all.

## Decision

`startShellServer` binds `0.0.0.0` and decides per request who may read the GUI, so the WebView and the phone reach the same listener and the same Host behind it:

- A loopback peer is the WebView: it gets the GUI, the `hcn` control cookie, and the control surface.
- A non-loopback peer is a phone. It gets the control surface never (`403`), and the GUI only when the door is on and its cookie matches.
- The door is `LanAccess` (`apps/desktop-shell/src/lan-access.ts`): a 32-byte secret in `state/lan-access.json`, offered as `/__lan?key=<secret>`; a matching key answers `302 /` with `hcn_lan`, an `HttpOnly`, `SameSite=Lax` cookie good for a year. Rotating the secret invalidates every phone at once; disabling the door refuses every phone while leaving the secret intact for the next enable.
- A phone with no valid cookie receives a small notice page that names the state (`off` or `locked`) and says where the link comes from. The page carries no GUI code and no credential, so a scanner that finds the port learns nothing it can replay.
- The QR is drawn by the shell process (`qrcode`, `GET /shell-api/lan/qr`), so the window needs no encoder of its own; the new **移动访问** window (`apps/desktop-shell/src-tauri/resources/shell/lan.html`) is one switch, one code, one link.

## Alternatives considered

**Keep patching `dsh-mobile`.** Each patch answered one failure and exposed the next; the list above is the sequence, not a sample. The architecture guarantees more.

**Ship `@linxin666/dsh-remote-web-ui` and let the Host bind the LAN.** That would move the GUI away from the shell (the Host serves no index on this line), duplicate the shell's own door, and still fails on the client half.

**Rewrite the Host's desktop patch to bind `0.0.0.0` with a LAN pairing plugin.** It changes the Host's security posture for every desktop launch, including the ones where the user never turns phone access on.

## Consequences

Phone access needs no certificate install and no pairing code: the link is the credential. Traffic on the LAN is plain HTTP, which is the tradeoff `D:\Claudecode-CN` records for the same reason — a phone will not trust a self-signed certificate without an install step — and it is stated in the window rather than discovered by a user who cannot get past a browser warning.

The control surface stays loopback-only, so a paired phone can use the GUI but cannot install plugins or updates. Turning the door off, or rotating the link, ends every phone session on the next request.
