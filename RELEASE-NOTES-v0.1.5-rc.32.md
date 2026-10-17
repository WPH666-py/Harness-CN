# Harness-CN 0.1.5-rc.32

这一版修两个移动访问的问题。一是：开启局域网访问之后，如果配置里那个端口被别的程序占着，应用会在启动阶段直接失败，弹「Harness-CN 启动失败」，连界面都进不去；现在端口被占时会被换到下一个空闲端口，并把实际端口写回配置，应用照常启动。二是：配对过的手机只能用一阵子——闲置约 48 分钟后要重新登录，配对链接两分钟后就只剩 `{"error":"not_found"}`，三个月不用的手机会被要求重新扫码；现在会话与设备都按一年计，配对窗口给到 10 分钟，失效的配对链接也会自己尝试恢复。其余沿用 rc.31 的修复。

## 修复

### 1. 局域网端口被占用会让整个应用起不来

现象：在「局域网访问」面板点过「完成配置」之后，重启应用弹出

```
Harness-CN 启动失败
dsh desktop: plugin tree failed to load: failed to apply loader entry
mobile-access (dsh-mobile): listen EADDRINUSE: address already in use 192.168.1.16:3443
```

点确定之后进程退出，界面根本进不去。把占端口的程序关掉再启动就恢复正常。

原因：面板「完成配置」会把所选的端口（默认 `3443`）写进 `~/.harness-cn/mobile-access/setup.json`，并在 `control.json` 里记下「已开启」，此后每次启动，`dsh-mobile` 的 `mobile-access` 条目都会在插件树加载阶段去绑这个地址。绑定失败抛出的 `EADDRINUSE` 是普通 Node 错误，而插件只把「网卡选择类」错误当作可容忍，其余一律重抛 —— 重抛到 loader 层面就变成「整棵插件树加载失败」。同机上另一个桌面应用（DSH NEXT）跑着同一个 `dsh-mobile` 插件、开着局域网访问并占着 `192.168.1.16:3443`，于是每次启动都撞上。

改法：在打包期给内嵌的 `dsh-mobile` 打一个补丁（`apps/desktop/scripts/patch-mobile-listen.mjs`，与既有的 `patch-rule-engine` / `patch-wechat-*` 同一套机制）：

- 网关启动前先试配置端口，空闲就照旧；被占则依次试后 20 个端口，最后退到系统分配的临时端口，并同步改写配置里的 `publicOrigin`/`listenPort`，托管模式下还把实际端口写回 `setup.json` —— 二维码与配对链接带的因此是真正在监听的端口；
- 启动 catch 把 `EADDRINUSE`、`EADDRNOTAVAIL` 降级为告警，即便候选端口全被占也只是插件降级，不再拖垮应用；
- 补丁带 `DSH_MOBILE_LISTEN_PORT_FALLBACK` 标记、幂等、改完在临时副本上跑 `node --check` 校验；`prepare-seed` 打完补丁后断言标记存在，`verifyOfflineInstallation` 在标记缺失时让构建失败（`desktop seed: the profile the seed produced has no patched dsh-mobile`），将来 dsh-mobile 升级挪了锚点会以具名错误终止打包，而不是悄悄发出未打补丁的产物。

### 2. 配对过的手机不能一直连着

现象：手机扫过一次二维码之后，用一阵子就又被问一遍——闲置大约 45 分钟，再打开应用地址看到的是 DSH 登录页；桌面面板二维码里的那条配对链接留在手机浏览器历史里，过一两分钟再点就只剩 `{"error":"not_found"}`；三个月没用的手机则必须重新扫码。

原因：`dsh-mobile` 把三个有效期编死在配置解析里，setup 文件抬不高它们——会话默认 48 分钟（`288e5`），schema 又把会话上限压死在一天（`864e5`）；配对设备 90 天（`7776e6`）；配对窗口默认 2 分钟、最多 10 分钟（`12e4` / `6e5`），窗口一关，配对路由直接抛 404。插件本来有静默续期的路（`/mobile-access/login` 会用设备 cookie POST `/mobile-access/auth/renew`），但前提是设备没过期、且用户打开的是应用地址而不是那条失效的链接。

改法：同样在打包期打补丁（`apps/desktop/scripts/patch-mobile-session.mjs`）：

- 会话与配对设备的默认有效期都改为一年（`31536e6` 毫秒），会话上限抬到与设备相同的 `316224e5`，于是不会用到一半被送回登录页，应用重启后也仍能凭设备 cookie 静默续期；
- 配对窗口默认值改为它自己的上限十分钟（`6e5`，仍限定在 `1e4…6e5`）；
- 配对窗口关闭后不再回 404，而是回一个页面：后台重试 `/mobile-access/auth/renew`（已配对的手机直接进入应用），否则说明二维码在桌面面板的位置并给出入口；
- 补丁带 `DSH_MOBILE_SESSION_LONGEVITY` 标记、幂等、在安装目录之外的临时副本上跑 `node --check`；`prepare-seed` 打完补丁后断言标记存在，`verifyOfflineInstallation` 在缺失时让构建失败（`desktop seed: the profile the seed produced has no long-lived dsh-mobile sessions`）。

### 3. 沿用 rc.31 / rc.30 / rc.29 的修复

- 桌面版 `/api/...` 下的插件路由不再被载体 404 吞掉，局域网访问面板能读到数据（rc.31）；
- 登录等待态不再同时显示「登录」与「取消」（rc.30）；
- 运行日志窗口先读快照再挂实时流，不再开成空白（rc.30）；
- 账号面板从注册表读取 `remote.account` 命名空间、`AuthorizationSession.commit` 前向移植、vision 工具默认不激活等 rc.29 的修复。

## 验证

- **端口被占用的实机复现与修复**：让另一个进程占住 `192.168.1.16:3443`，把 live profile 的 `setup.json` 写回 `listenPort: 3443` 后启动打过补丁的应用 —— 应用正常起来，日志输出 `(node:24452) [DSH_MOBILE_LISTEN_PORT_FALLBACK] Warning: DSH Mobile: 192.168.1.16:3443 is already in use; listening on 192.168.1.16:3444 instead.`，`netstat` 显示监听 `192.168.1.16:3444`，`setup.json` 被改写为 `listenPort: 3444`；面板显示「局域网访问已开启」与 `https://192.168.1.16:3444`，`https://192.168.1.16:3444/` 返回 `401 {"error":"authentication_failed"}`（TLS 就绪，等配对）。
- 补丁在 `dsh-mobile` 的 `lib/index.mjs` 上从 711 589 字节变为 714 003 字节，sha256 `ad6af19b470c524b46bd8eab1d24d01348491c81818b3ec5f4505cca4783074a`；重复执行报「already patched」，`node --check` 通过。
- **长期连接补丁**：同一个 `lib/index.mjs` 再变为 717 257 字节，sha256 `782c1bed7bffcf0508f27533b2a12303ccfee21d579b00ba563d88360f00c9e6`；会话/设备字面量改写为 `31536e6`、配对窗口改写为 `6e5, 1e4, 6e5`，`node --check` 通过，重复执行报「already patched」。
- 单跑 `prepare:seed` 通过，日志含 `patch-mobile-session: patched … (717257 bytes, sha256 782c1bed…)`，`verifyOfflineInstallation` 的两项移动补丁校验均通过（退出码 0，186 秒）。
- 门禁：Agent Note 格式 347 篇、分类 347 篇、双语配对 813 对，全过；改动文件 `oxlint` 0 warnings / 0 errors。
- **rc.32 产物原样验证**：（构建完成后回填）

## 安装包校验和

（构建完成后回填）
