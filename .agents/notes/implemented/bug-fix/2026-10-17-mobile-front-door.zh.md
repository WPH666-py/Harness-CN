# Agent Note: 配对成功的手机打不开刚配对的那个应用

Status: implemented

[English](2026-10-17-mobile-front-door.md) | 中文

## Problem

手机扫面板上的二维码，配对 POST 返回 201，浏览器跳到 `https://192.168.1.16:3443/` —— 然后就停在那里。用户看到的要么是手机浏览器自己的「网站暂时无法打开」，要么是一张白页写着 `Failed to load plugins / client-modules: window.__DSH_BOOT__ is missing or not an object`。此后再重启桌面端，手机上还会多出一次「您的连接不是私密连接」，因为网关每次启动都重签服务器证书。

用户的原话依次是「成功了，但为什么打不开页面呢？」和「二维码呢？」—— 配对「成功」了，但它背后的应用从来没打开。

## Cause

三个互不相干的缺陷叠在同一张页面上：

1. **上游指错。** `loopbackTemplate(loaded, ctx.webServer.port)` 用 Host 的私有监听端口拼 `activeUpstreamOrigin`。桌面版的应用其实由外壳的前门提供，那个端口不提供首页：`/` 回 404，于是网关取首页失败，所有代理页面变成 `502 upstream_unavailable`。
2. **换 cookie 太严。** `exchangeUpstreamCookie` 只认 `303` 加带 `Max-Age` 的 `Set-Cookie`。前门回的是 `200` 和不带 `Max-Age` 的会话 cookie，于是即使 cookie 完全可用，交换也抛错。
3. **传输覆盖冲突。** 注入的 `MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP` 开头是 `if (window.__DSH_TRANSPORT__ !== undefined) throw new Error('DSH Mobile cannot replace an existing transport override')`。外壳自己的页面先装了传输覆盖，于是这段内联启动脚本在 `globalThis["__DSH_BOOT__"] = …` 执行之前就抛错；随后加载的 client-modules 找不到 boot 对象。

在这三个问题背后，`materializeManagedSetup` 每次启动都无条件调用 `refreshManagedServerCertificate`，手机刚接受的那张证书在下一次访问之前就被换掉了。

## Evidence

- `harness.log` 里交换失败是 `status=404 pair=null maxAge=NaN location= cookies=null`，代理请求的栈停在 `HttpError: upstream_unavailable at MobileAccessGateway.exchangeUpstreamCookie (lib/index.mjs:6329:177)`。
- 运行中应用的端口矩阵：`127.0.0.1:49242/`（Host）→ 404，`/?token=…` → 200 + `set-cookie: hcn=…`；`127.0.0.1:52317/`（外壳前门）→ 200 且是应用首页的 HTML；网关监听在 `192.168.1.16:3443`，而 `ctx.webServer.port` 指向 Host。
- 用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 捕获到的页面错误：`Uncaught Error: DSH Mobile cannot replace an existing transport override`，紧接着 `client-modules: window.__DSH_BOOT__ is missing or not an object`。
- 同一次运行里，返回的 HTML 中 `globalThis["__DSH_BOOT__"] = {…}` 明明存在，而 `typeof window.__DSH_BOOT__` 是 `undefined` —— 说明赋值语句根本没执行。
- `mobile-access/tls/server-cert.pem` 在 21:24:33 与 22:16:57 各被重写一次（每次启动一次），而 `ca.pem` 从 18:34:25 起没变。

## Decision

- 外壳导出自己的前门地址：`apps/desktop-shell/src/shell-main.ts` 在 `listen` 握手之后、Host 启动之前执行 `process.env.DSH_SHELL_ORIGIN = running.origin`，子进程直接继承。
- `apps/desktop/scripts/patch-mobile-session.mjs` 在已安装产物上再加四处改写：
  - `loopbackTemplate` 优先读 `DSH_SHELL_ORIGIN`（校验为带端口的 `http:` origin），没有就退回原来的 loopback 形式；
  - 换 cookie 时同时接受 `200` 与 `303`，不带 `Max-Age` 的 cookie 按一小时计；
  - 传输覆盖改成「只有不存在时才安装」，不再抛错；
  - `materializeManagedSetup` 在现有 leaf 仍覆盖网卡地址、且距到期超过七天时直接复用。
- 校验器把新增标记（`DSH_MOBILE_TRANSPORT_BOOTSTRAP`、`DSH_MOBILE_DESKTOP_UPSTREAM`、`DSH_MOBILE_CERT_REUSE`）也纳入断言：seed 产物里少了任何一项，构建就失败，而不是悄悄发出去。

## Alternatives considered

- **让 Host 也提供首页。** 等于把外壳的静态服务与 `/api` 代理再实现一遍；前门已经存在，而且是唯一同时带着桌面自身会话 cookie 的 origin。
- **让手机直接连 Host 的端口。** 那个端口没有界面也没有静态资源，是内部 RPC 面。
- **允许移动端覆盖外壳的传输。** 外壳的传输正是桌面版把 `/api` 转给 Host 的通道，换掉它只是把一张坏页面换成另一张。
- **让用户每次启动都重新接受证书。** 每次重启都回来的警告，与网站坏掉没有区别。

## Consequences

- 配对现在直接落到应用上：页面能通过 `https://192.168.1.16:3443/` 渲染出「探索未至之境」、工作区列表和会话输入框。
- 信任过 CA 的手机重启后继续信任：只有网卡地址变化、或证书距到期不足七天才重签。
- 没有 `DSH_SHELL_ORIGIN` 时网关仍按 Host 端口走，所以同一份产物在独立的（非桌面）DSH 安装里行为不变。
- 打过补丁的模块变成 719 220 字节（sha256 `fe62eef1a93e0e7db21168785a19ae7f4dd9935bd5a4ae984323159b61134ae2`）；上游改动任何一处字面量都会让 `prepare-seed` 明确失败，而不是悄悄退化。
