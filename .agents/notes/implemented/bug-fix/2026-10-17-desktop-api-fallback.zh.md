# Agent Note：桌面载体把没有路由认领的 `/api` 请求一律答成 404，插件挂在 `/api` 下的路由从未执行

Status: implemented

[English](2026-10-17-desktop-api-fallback.md) | 中文

## Problem（问题）

已安装的 rc.30 桌面版里，设置中的「局域网访问」面板（dsh-mobile 提供）两个页签都显示 `请求失败：SyntaxError: Unexpected token 'o', "not found" is not valid JSON`，远程页签的「当前连接」在同一处失败上方还显示 `Tailscale Funnel 未启用`。面板用到的每个控制接口（`/api/mobile-access/lan/control`、`/diagnostics`、`/lan/setup`、`/remote/control` 等）在窗口 origin 下都返回 `404`，响应体就是纯文本 `not found`，于是客户端的 `response.json()` 先抛错，界面什么都渲染不出来。

同样这些接口，直接从宿主的 webserver 监听端口请求时是 `200` JSON；而 webserver 上不在 `/api` 下的路由（`/wechat/qr`）走同一条桌面管道是正常的。

## Cause（原因）

`apps/desktop-host/src/index.ts` 只在传输层没有认领请求时才把它交给组合好的 webserver：`unclaimedRequestOwner` 把 `/api` 整段视为传输层所有，其余视为 webserver 的静态资源或 API。而 `connection.createSharedFetchHandler('/api')` 认领了整个 `/api` 前缀，对任何没有精确匹配路由的路径一律返回 `new Response('not found', { status: 404 })`（`packages/client/connection/src/rpc-host.ts`）。

dsh-mobile 把它的管理面注册在 webserver 上（`ctx.webServer.register`），而不是注册在 connection 上，因此每个 `/api/mobile-access/*` 请求都被传输层的 404 吞掉，从未到达插件处理器。问题出在桌面载体的分发，不在插件；把 dsh-mobile 升级到新版本也修不好。

## Evidence（证据）

- 在已安装的应用上通过 WebView2 调试端口执行 `fetch('/api/mobile-access/lan/control')`，窗口 origin 下返回 `404 text/plain`，响应体为 `not found`；同一路径由宿主自己的监听端口回答时是 `200 {"configured":false,"restartRequired":false,"running":false}`。
- `/wechat/qr`（webserver 路由，不在 `/api` 下）经同一条 sidecar 管道返回 `200`，说明管道本身没问题。
- `dsh-mobile/lib/index.mjs` 声明 `inject: ['webServer', 'commands', 'connection']`，并通过 `ctx.webServer.register` 注册 `mobile-access`；面板的接口本来就在 webserver 里。
- 改动之后，同样在页面内发起 fetch 返回 `200 application/json`，面板正常渲染 局域网 / 远程，并显示 `电脑当前网络 以太网 · 192.168.56.1、WLAN · 192.168.1.16 · 推荐`；整页不再出现 `请求失败` 或 `SyntaxError`。
- `packages/client/connection/tests/fetch-routes.host.spec.ts` 固定了新行为：没有精确路由认领的请求会落到载体提供的 fallback；不提供 fallback 时仍然返回 `404`。

## Decision（决定）

`createSharedFetchHandler(channel, fallback?)` 增加可选的 `ConnectionFetchFallback`（`(request: Request) => Promise<Response>`）。没有精确匹配路由的路径，在载体提供 fallback 时交给 fallback；没有提供时保持原来的 `404 not found`，因此浏览器与 CLI 载体的行为完全不变。

桌面宿主把自己派发插件路由的函数作为 fallback 传进去：传输层不拥有的 `/api` 路径于是落回那条已经服务同源其余请求的 webserver 分发。声明顺序有要求：`pluginRoutes` 先创建，组合共享处理器时闭包引用它。

精确路由仍然优先。传输层回答自己的端点时不会询问 fallback，浏览器鉴权、请求/响应信封和 Trust 拦截器都不会离开载体。

## Alternatives considered（备选方案）

**把管理面板挂到 webserver 自己的监听 origin 上。** 这需要第二个 origin（或重新放开 Host 限制）和另一套 cookie 方案，而且面板将不再与它管理的应用同源。

**把 dsh-mobile 的路由改注册到 connection 上。** 这等于把插件契约改成一个桌面专用的后门，还会逼所有使用 `ctx.webServer` 的插件再学一套注册方式。

**把没有认领的 `/api` 路径答成 `200 {}`。** 这会把插件和传输层真实的 404 藏起来，客户端错误分支还会把「路由不存在」静默渲染成空面板。

## Consequences（影响）

`/api` 下的插件 webserver 路由重新可以从桌面窗口访问；未知的 `/api` 路径现在会走到 webserver 自己的 404（JSON，带宿主日志），而不是传输层那句干巴巴的 `not found`。桌面宿主与 connection 库都改了，所以修复随新的桌面产物发布；浏览器与 CLI 载体不受影响。
