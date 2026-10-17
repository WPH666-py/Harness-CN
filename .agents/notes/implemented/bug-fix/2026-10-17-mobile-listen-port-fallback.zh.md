# Agent Note: 局域网端口被占用会拖垮整棵插件树，dsh-mobile 现在回退到空闲端口

Status: implemented

[English](2026-10-17-mobile-listen-port-fallback.md) | 中文

## Problem（问题）

已安装的桌面版开启「局域网访问」后，每次重启都弹出「Harness-CN 启动失败」：

```
dsh desktop: plugin tree failed to load: failed to apply loader entry
mobile-access (dsh-mobile): listen EADDRINUSE: address already in use 192.168.1.16:3443
```

面板点「完成配置」时把 `listenPort: 3443` 写进了 `~/.harness-cn/mobile-access/setup.json`，把 `{"enabled":true}` 写进了 `control.json`，此后插件每次启动都去绑这个地址。可该端口被同机的另一个程序占着——另一个桌面应用（DSH NEXT）在同一台主机、同一端口上也跑着同一个 `dsh-mobile` 插件并开着局域网访问。同一产品的两个应用在一台机器上共存是正常用法；它应当只让插件降级，而不是让整个应用起不来。

## Cause（原因）

`mobile-access` 这个 loader 条目在插件树加载阶段就启动网关（`apply` → `startGateway` → `startRuntime`）。`startRuntime` 只容忍「网卡选择」类错误，其余一律重抛：

```ts
if (!isNetworkSelectionError(error)) throw error;
```

`server.listen` 抛出的 `EADDRINUSE` 是普通 Node 错误，不属于网卡选择错误，于是重抛到 loader 层面变成 `failed to apply loader entry mobile-access (dsh-mobile)`，整棵树随之中止。

绑定端口处本身也没有回退：`MobileAccessGateway.start()` 直接调用 `server.listen(this.config.listenPort, this.config.listenHost, …)`，失败就上抛。上游 0.6.10 对局域网端口依旧没有处理——它只把 cloudflared/caddy 分支的 `EADDRINUSE` 映射成 `409 listen_port_in_use`——所以升级 dsh-mobile 并不是修法。

## Evidence（证据）

- 失败的那次启动在 `C:/Users/admin/AppData/Local/com.harnesscn.desktop/logs/harness.log` 记下：`[shell] startup failed: dsh desktop: plugin tree failed to load: failed to apply loader entry mobile-access (dsh-mobile): listen EADDRINUSE: address already in use 192.168.1.16:3443`。
- `netstat -ano` 显示 `192.168.1.16:3443` 属于另一个桌面应用，而它自己的 `C:/Users/admin/.dsh/mobile-access/setup.json` 也写着 `listenPort: 3443`。
- 另一个应用继续占着 3443 时，打过补丁的构建（`714 003` B，sha256 `ad6af19b470c524b46bd8eab1d24d01348491c81818b3ec5f4505cca4783074a`）正常启动，日志输出 `(node:24452) [DSH_MOBILE_LISTEN_PORT_FALLBACK] Warning: DSH Mobile: 192.168.1.16:3443 is already in use; listening on 192.168.1.16:3444 instead.`，监听在 `192.168.1.16:3444`，并把 `setup.json` 改写为 `listenPort: 3444`。
- 面板随后显示「局域网访问已开启」与 `https://192.168.1.16:3444`，`https://192.168.1.16:3444/` 返回 `401 {"error":"authentication_failed"}`——TLS 监听已就绪，等配对。

## Decision（决定）

在打包期给内嵌的插件打补丁：`apps/desktop/scripts/patch-mobile-listen.mjs`，复用既有 `patch-rule-engine.mjs` / `patch-wechat-*.mjs` 的机制——改 profile `node_modules` 里的插件源码、校验、锚点漂移就让打包失败。

补丁做两件事。

1. 网关启动前，`pickFreeLanPort` 在配置端口空闲时保持不变，否则依次试后 20 个端口（最后退到临时端口 `0`），同时改写配置里的 `publicOrigin`/`listenPort`，并在 setup 由 managed 托管时把实际端口写回 `setup.json`，保证二维码与配对链接带的是真正监听的端口。
2. 启动 catch 里把 `EADDRINUSE` 和 `EADDRNOTAVAIL` 降级为非致命告警，这样即便搜遍候选端口仍被占，也只是插件降级而非应用失败。

每处改写都由 `DSH_MOBILE_LISTEN_PORT_FALLBACK` 标记守护，并在临时副本上跑 `node --check` 校验；`prepare-seed` 给 materialize 出来的 profile 打完补丁后会断言标记存在，`verifyOfflineInstallation` 在标记缺失时让构建失败（`desktop seed: the profile the seed produced has no patched dsh-mobile`），避免将来 dsh-mobile 升级挪了锚点却悄悄发出未打补丁的产物。

## Alternatives considered（备选方案）

- **升级 dsh-mobile。** 0.6.10 仍然无条件绑定配置端口，并把启动时的 `EADDRINUSE` 当作致命错误，升级不会改变结果。
- **让用户关掉另一个应用的局域网访问。** 一次有效，但两个应用本就该能同时使用；只要任意一方先占住 3443，失败就会重现。
- **在 `startRuntime` 里吞掉所有启动错误。** 会把真正的故障（TLS 材料损坏、配置非法）一起藏进同一条静默告警里。
- **把修复推给上游。** 长期看那才是它该待的地方，但本分支现在就要发版；保留标记便于上游自行回退后移除补丁。

## Consequences（影响）

- 两个应用可以同时开局域网访问：后启动的一方顺延到下一个空闲端口，并告诉用户该用哪个地址配对。
- 持久化的 `listenPort` 跟着真正起来的监听走，后续启动会优先用上次成功的端口；收藏了旧端口地址的客户端需要重新配对。
- 打包从此依赖插件的 `startGateway` 与启动 catch 这两个锚点。dsh-mobile 升级改动它们时，seed 构建会带着具名错误失败，而不是静默发出未打补丁的插件。
- 补丁会在运行日志里留下 `[DSH_MOBILE_LISTEN_PORT_FALLBACK]` 告警，支持人员可以据此区分「端口被挪动」与「真的坏了」。
