# Agent Note: A paired phone could not open the app it had just paired with

Status: implemented

English | [中文](2026-10-17-mobile-front-door.zh.md)

## Problem

A phone scanned the panel's QR code, the pairing POST returned 201, and the browser landed on `https://192.168.1.16:3443/` — and stopped there. The user saw either the phone browser's own 「网站暂时无法打开」 page or a white page reading `Failed to load plugins / client-modules: window.__DSH_BOOT__ is missing or not an object`. After that, every restart of the desktop added a fresh 「您的连接不是私密连接」 warning on the phone, because the gateway re-signed its leaf certificate at each start.

The user's reports, in order: 「成功了，但为什么打不开页面呢？」 and 「二维码呢？」 — pairing "worked" while the app behind it never opened.

## Cause

Three independent defects met on the same page:

1. **Wrong upstream.** `loopbackTemplate(loaded, ctx.webServer.port)` built `activeUpstreamOrigin` from the Host's private listener. In a desktop install the app is served by the shell's front door, not by that listener: the Host port answers 404 for `/`, so the gateway's index fetch failed and every proxied page became `502 upstream_unavailable`.
2. **Cookie exchange too strict.** `exchangeUpstreamCookie` required `303` plus a `Max-Age`-bearing `Set-Cookie`. The front door answers `200` with a session cookie that carries no `Max-Age`, so the exchange threw even when the cookie was perfectly usable.
3. **Transport override conflict.** The injected `MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP` began with `if (window.__DSH_TRANSPORT__ !== undefined) throw new Error('DSH Mobile cannot replace an existing transport override')`. The shell's own page installs a transport override before the mobile bundle runs, so the inline boot script threw before `globalThis["__DSH_BOOT__"] = …` executed; the client-modules bundle then found no boot object.

And behind all three, `materializeManagedSetup` called `refreshManagedServerCertificate` unconditionally on every start, so the certificate a phone had accepted was replaced before the next visit.

## Evidence

- `harness.log` carried the exchange failure as `status=404 pair=null maxAge=NaN location= cookies=null`, and the proxied request stack ended at `HttpError: upstream_unavailable at MobileAccessGateway.exchangeUpstreamCookie (lib/index.mjs:6329:177)`.
- Port matrix on the running app: `127.0.0.1:49242/` (Host) → 404, `/?token=…` → 200 + `set-cookie: hcn=…`; `127.0.0.1:52317/` (shell front door) → 200 with the app's HTML; the gateway listened on `192.168.1.16:3443` while `ctx.webServer.port` pointed at the Host.
- Page-level errors captured with `Page.addScriptToEvaluateOnNewDocument` over CDP: `Uncaught Error: DSH Mobile cannot replace an existing transport override` followed by `client-modules: window.__DSH_BOOT__ is missing or not an object`.
- The same run reported `globalThis["__DSH_BOOT__"] = {…}` present in the served HTML while `typeof window.__DSH_BOOT__` was `undefined` — the assignment never ran.
- `mobile-access/tls/server-cert.pem` was rewritten at 21:24:33 and again at 22:16:57, once per launch, while `ca.pem` stayed at 18:34:25.

## Decision

- The shell exports its front door: `process.env.DSH_SHELL_ORIGIN = running.origin` in `apps/desktop-shell/src/shell-main.ts`, right after the `listen` handshake and before the Host starts, so the child inherits it.
- `apps/desktop/scripts/patch-mobile-session.mjs` grows three more edits on the installed bundle:
  - `loopbackTemplate` prefers `DSH_SHELL_ORIGIN` (validated as an `http:` origin with a port) and falls back to the old loopback form;
  - the cookie exchange accepts `200` as well as `303`, and gives a cookie without `Max-Age` one hour;
  - the transport bootstrap installs `__DSH_TRANSPORT__` / `__DSH_FILE_UPLOAD__` only when they are absent instead of throwing;
  - `materializeManagedSetup` keeps an existing leaf while it covers the interface address and remains valid for more than seven days.
- The patch verifier now asserts the new markers (`DSH_MOBILE_TRANSPORT_BOOTSTRAP`, `DSH_MOBILE_DESKTOP_UPSTREAM`, `DSH_MOBILE_CERT_REUSE`) in the seed-produced profile, so a seed that skipped them fails the build instead of shipping.

## Alternatives considered

- **Make the Host serve the index.** It would duplicate the shell's static serving and `/api` proxying; the front door already exists and is the only origin that also carries the desktop's own session cookie.
- **Point the phone at the Host's port directly.** That port has no UI and no assets; it is an internal RPC surface.
- **Let the mobile transport overwrite the shell's.** The shell's transport is what routes `/api` to the Host on a desktop; replacing it would trade one broken page for another.
- **Tell users to re-accept the certificate after every launch.** A warning that returns on every restart is indistinguishable from a broken site.

## Consequences

- Pairing now ends on the app itself: the page renders 探索未至之境, the workspace list and the session composer through `https://192.168.1.16:3443/`.
- A phone that trusts the CA keeps trusting it across restarts; the leaf is only re-signed when the interface address changes or the certificate is within a week of expiry.
- The gateway still prefers the Host listener when `DSH_SHELL_ORIGIN` is absent, so the same bundle keeps working for a standalone (non-desktop) DSH install.
- The patched module grows to 719 220 bytes (sha256 `fe62eef1a93e0e7db21168785a19ae7f4dd9935bd5a4ae984323159b61134ae2`); an upstream release that changes any of these literals fails loudly in `prepare-seed` rather than degrading silently.
