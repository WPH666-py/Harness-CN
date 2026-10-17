# Agent Note: The desktop carrier answered unclaimed `/api` requests with 404, so plugin routes under `/api` never ran

Status: implemented

English | [中文](2026-10-17-desktop-api-fallback.zh.md)

## Problem

The installed rc.30 desktop app's 局域网访问 panel (dsh-mobile) opened with `请求失败：SyntaxError: Unexpected token 'o', "not found" is not valid JSON` on both tabs, and 远程 → 当前连接 showed `Tailscale Funnel 未启用` above the same failure. Every control endpoint the panel uses (`/api/mobile-access/lan/control`, `/diagnostics`, `/lan/setup`, `/remote/control`, …) answered `404` with a plain `not found` body from the window origin, so the client's `response.json()` threw before anything could render.

The same endpoints answered `200` JSON when requested directly from the host's webserver listener, and a webserver route outside `/api` (`/wechat/qr`) worked through the very same desktop pipe.

## Cause

`apps/desktop-host/src/index.ts` hands a request to the composed webserver only when the transport did not claim it: `unclaimedRequestOwner` treats `/api` as transport-owned, and anything else as a webserver asset or API. `connection.createSharedFetchHandler('/api')` claimed the whole `/api` prefix and answered every path it had no exact route for with `new Response('not found', { status: 404 })` (`packages/client/connection/src/rpc-host.ts`).

dsh-mobile registers its admin surface on the webserver (`ctx.webServer.register`), not on the connection, so every `/api/mobile-access/*` request was absorbed by the transport's 404 and never reached the plugin handler. The failure is in the desktop carrier's dispatch, not in the plugin; upgrading dsh-mobile cannot fix it.

## Evidence

- From the installed app over the WebView2 debugging port, `fetch('/api/mobile-access/lan/control')` in the window origin returned `404 text/plain` with body `not found`; the host's own listener answered the same path with `200 {"configured":false,"restartRequired":false,"running":false}`.
- `/wechat/qr` (a webserver route, not under `/api`) returned `200` through the same sidecar pipe, so the pipe itself was sound.
- `dsh-mobile/lib/index.mjs` declares `inject: ['webServer', 'commands', 'connection']` and registers `mobile-access` through `ctx.webServer.register`, which is why the panel's endpoints live in the webserver.
- After the change, the same in-page fetch returns `200 application/json`, and the panel renders 局域网 / 远程 with `电脑当前网络 以太网 · 192.168.56.1, WLAN · 192.168.1.16 · 推荐`; neither `请求失败` nor `SyntaxError` appears anywhere in the page.
- `packages/client/connection/tests/fetch-routes.host.spec.ts` pins the new behavior: a request no exact route claimed reaches the carrier fallback, and without a fallback the handler still answers `404`.

## Decision

`createSharedFetchHandler(channel, fallback?)` takes an optional `ConnectionFetchFallback` (`(request: Request) => Promise<Response>`). A path that matches no exact route is handed to `fallback` when the carrier supplied one; otherwise the previous `404 not found` stands, so the browser and CLI carriers keep their behavior unchanged.

The desktop host passes its plugin-route dispatcher as that fallback, so a `/api` path the transport does not own falls through to the same webserver dispatch that already serves the rest of the origin. Declaration order matters: `pluginRoutes` is created before the shared handler is composed, and the fallback closes over it.

Exact routes still win. The transport answers its own endpoints without consulting the fallback, so browser authentication, envelopes, and the Trust interceptor never leave the carrier.

## Alternatives considered

**Mount the admin panel on the webserver's own listener origin.** It needs a second origin (or reopening the Host fence) and a separate cookie story, and the panel would stop being same-origin with the app it administers.

**Move dsh-mobile's routes onto the connection.** It turns a plugin contract into a desktop-only escape hatch and forces every plugin that uses `ctx.webServer` to learn a second registration path.

**Answer unclaimed `/api` paths with `200 {}`.** It hides real 404s from plugins and from the transport, and the client's error path would silently render an empty panel instead of a route that does not exist.

## Consequences

Plugin webserver routes under `/api` are reachable from the desktop window again, and an unknown `/api` path now reaches the webserver's own 404 (JSON, with the host's logging) instead of the transport's flat `not found`. The desktop host and the connection library both changed, so the fix ships with a new desktop payload; the browser and CLI carriers are untouched.
