# Harness-CN 0.1.5-rc.18（修复版，未发布）

本版修复三个各自独立、但都会被用户直接看到的缺陷：**vet 运行时守卫的开关点不动**、**离线包的手动兜底路径不生效**、**休闲食品商城的商品链接点了没反应**。

> **关于版本号**：`0.1.5-rc.18` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。
> 起版前先按仓库流程执行 `pnpm run release:dsh 0.1.5-rc.18` —— 它要求整个 dsh 家族 268 个清单同版本，
> 会一并改写 `tauri.conf.json`、`Cargo.toml` 与锁文件并生成提交。

## 本版改动

### 一、修复：vet 盾牌面板的写入被自己的同源校验拒绝（403）

**现象**：盾牌面板上点「开启」，返回 `54927/vet/runtime-guard:  Failed to load resource: the server responded with a status of 403 (Forbidden)`，
面板提示「写入失败 — 跨源请求被拒绝」，防御统计与「最近扫描」照常显示（只读路由不受影响）。

**原因**：一条写入要穿过两层转发，而每一层都把请求的 authority 换掉了：

```
页面(WebView)  http://127.0.0.1:<外壳端口>/          Origin: http://127.0.0.1:<外壳端口>
  ↓ 外壳的 Host 代理（shell-server.ts）
桌面宿主       http://127.0.0.1:<外壳端口>/...        Origin 原样携带
  ↓ pluginRoutes 把请求重建到插件路由监听端口
dsh 宿主       Host: 127.0.0.1:<webserver 端口>      Origin 仍指向外壳端口  ← 两者不等
```

vet 的 `sameOrigin` 用 `Origin` 对比 `Host`，两者不等即 `403 跨源请求被拒绝`。这是**反向代理的经典问题**：
代理改写了 `Host`，却把浏览器填的 `Origin` 原样透传；对下游而言，这个 `Origin` 描述的已经不是它自己了。

**修复**：在**知道目标 authority 的那一跳**把 `Origin` 重新指向它。

- `apps/desktop-host/src/request-routing.ts` 新增 `headersForAuthority()`：复制请求头，`Origin` 存在时改写为本次请求实际寻址的 origin。
- `apps/desktop-host/src/index.ts` 的 `pluginRoutes` 用它重建发往 webserver 的请求。

选这一跳而不是外壳那一跳，是因为只有这里知道 webserver 的真实端口；外壳代理那一跳的目标 authority 就是它自己的端口，
改了也等于没改（这正是第一轮排查踩到的坑）。安全语义不变：`Origin` 缺失时依然不补（非浏览器调用），
改写后的值与下游看到的 `Host` 一致，同源校验仍然是有效的防线，只是不再把「代理改写过的自己人」判成跨站。

**验证**：`apps/desktop-host/tests/request-routing.spec.ts` 新增两例（改写、以及不凭空补 `Origin`）；
另在真实运行实例上直接复现过：`POST /vet/runtime-guard` 带 `Origin=http://127.0.0.1:54927` 得 `403 {"ok":false,"note":"跨源请求被拒绝"}`，
带 `Origin=http://127.0.0.1:61038` 得 `200 {"ok":true,...}`（61038 即 dsh 宿主的实际监听端口）。

### 二、修复：手动放进 `downloads` 的离线包不被读取，且离线包只在「每个源的最新 release」里找

两处独立缺陷，正好卡在同一个兜底路径上：

1. **说的和做的不一致**。首启失败提示原文是「也可以手动从发布页下载该文件，放进 `%USERPROFILE%\.dsh\desktop\seed\downloads` 后重新启动」，
   但 `ensureSeedPackage` 只检查 `resources/seed`（随包）与 `seed-<版本>`（缓存），**从不读 `downloads`**。
   照提示做完再启动，依旧报同一个错。
2. **只搜每个源的最新 release**。`readGithub` / `readGitee` 各自只取 `newestFirst(...)[0]`，
   离线包又以「自己那一版的 release」发布，于是只要任一源有一个更新的、不带离线包的 release（例如只带安装包的补丁版），
   查找在最新一版就结束，历史里明明存在的离线包永远找不到。

**修复**：

- `seed-package.ts` 新增 `findSeedArchiveInDownloads()`，用发布名（两种扩展名都认）在 `downloads` 里查；
  `ensureSeedPackage` 的取用顺序变为 **随包 → 缓存 → downloads 手动放置 → 网络**，来源多一个 `'manual'`，运行日志里能看到。
  手动放置的文件解包后**保留**（那是用户自己的文件），只有自动下载的才在解包后删除。
- `release-sources.ts`：`readGithub` / `readGitee` 改为返回**该源的全部 release**（仍按新→旧），
  `ReleaseAnswer.facts` 变成 `releases`，`findPublishedAsset` 跨两个源、按版本从新到旧逐个 release 查找资产。
  更新通道改用新的 `readableReleases()` 读取，行为不变（仍然只在可安装的最新一版上给提示）。
- Gitee 顺带少了两类浪费：资产列表已经带 `browser_download_url`，不再对每个 release 都打一次 `attach_files`；
  只有列表里没有任何可用条目时才回退到那个端点。

**验证**：`apps/desktop/tests/seed-package.spec.ts` 新增 4 例（手动放置被采用且文件保留、按发布名识别且两种扩展名都认、
缓存优先、源全失败时报错文案）+ 3 例跨 release 查找（旧 release 里找到本版离线包、多个匹配取最新、全都没有则返回空）。
`release-channel.spec.ts` 原有 10 例未改仍全绿。

### 三、修复：休闲食品商城的商品链接点击无反应

**现象**：商品卡片上「前往拼多多购买 →」点了没反应；页面本身渲染正常。

**原因**：商城的 9 个商品链接都是 `target="_blank"`（已用无头浏览器 dump 渲染后的 DOM 确认：9 个 `<a class="buy">`
全部带 `href="https://mobile.yangkeduo.com/..."`、`target="_blank"`、`rel="noreferrer noopener"`）。
WebView 里这属于**新窗口请求**，而 `open_window` 只注册了 `on_navigation`（限制 `127.0.0.1`），没有 `on_new_window` ——
Tauri 的默认处置是拒绝：既不开新窗口，也不在系统浏览器里打开，于是点击表现为「什么都没发生」。

**修复**（`src-tauri/src/main.rs` + `platform.rs`）：

- `open_window` 增加 `on_new_window`：把地址交给**系统默认浏览器**（商店链接本来就该在浏览器里下单），然后返回 `Deny`，不在产品里开第二个窗口。
- 新增 `platform::open_external()`，用 `ShellExecuteW(SW_SHOWNORMAL)` 打开；本进程是无控制台的 GUI 子系统程序，
  走 shell 关联而不是命令行，才不会每次点击闪一个黑框。返回值 ≤ 32 视为失败（`ShellExecuteW` 的约定），失败时弹对话框而不是静默。
- 只放行 `http`/`https`，并拒绝 `127.0.0.1` / `localhost`（那是本机监听端口，外壳自己的窗口已经在渲染它）。
- `Cargo.toml` 为其增加 `windows-sys` 的 `Win32_UI_Shell` feature。`cargo check --release` 通过。

`on_navigation` 的既有约束不变：产品页面仍然只渲染 loopback 来源，外部链接不会把工作区换成一个陌生页面。

### 四、修复：运行日志窗口空白

**现象**：菜单里的「运行日志」打开后是空白的——标题、说明、按钮都在，日志列表里一行都没有，也不显示「暂无日志」。

**原因**：这个窗口显示的一切都来自 `log-viewer.js`（一个 ES module）。**模块一旦没有跑起来，页面照样把自己那套markup 画出来**，于是看上去就像「这次运行什么都没记」——而这恰好是最没有信息量的一种报告：它让人去查运行，而不是查窗口本身。

排查过程中还挖出一个更隐蔽的问题：页面自己的 CSP 是 `script-src 'self'`，**它连内联脚本都拒绝**。我第一版把兜底逻辑写成内联 `<script>`，浏览器直接报
`Executing inline script violates the following Content Security Policy directive 'script-src 'self''`——
也就是说，任何以内联形式写在页面里的「自检」都会被它要补偿的那条策略本身拦掉，然后继续静默失败。

**修复**：

- 新增 `log-viewer-boot.js`（**独立的 classic 脚本**，因此不受 `script-src 'self'` 限制，且在 module 之前执行）：
  - 捕获脚本加载失败、脚本错误、未处理的 rejection，并把原因写进窗口里；
  - 模块没起来时，它**自己**去读同一个 `/shell-api/logs` 并把记录画出来——没有 module、没有 import、没有打包器，读不到就把原因（HTTP 状态、响应不是快照、控制面拒绝）直接写在窗口里。
  - 判断「模块是否起来」靠两个信号：`window.__dshLogViewerStarted` 与标题是否已被填上；两者都没有才接管，因此模块正常时它完全隐身。
- `log-viewer.js`：**先读快照、后接实时流**（原来顺序相反，实时流建不起来会让整页停在空状态）；实时流不可用时只降级为「仅显示已读取的记录」并明确说明；清空失败也会报出来；状态行现在总是带上日志文件路径。
- `shell-server.ts`：补上 `.json` 的 MIME；并且**外壳自己记录**每次页面请求（`window page requested: /shell/log-viewer.html`）——窗口的脚本再怎么失败，这一行也一定在运行日志里。
- `main.rs`：打开窗口时打印 `opening window <label> at <url>` 到 sidecar 的 stderr。

**验证**（在真实外壳页面上、用真实 HTTP 监听、模块被 404 掉的条件下复现）：

| 条件 | 结果 |
| --- | --- |
| 模块被拒（复现故障） | 兜底接管：**15 行日志全部画出**，横幅说明模块未执行，状态行含文件路径 |
| 模块正常 | 模块接管：15 行、状态行「显示 15 条…」，横幅保持隐藏 |

## 本次发布的验证方式

- `cargo check --release` 通过（`apps/desktop-shell/src-tauri`）。
- `tsc -p apps/desktop-shell/tsconfig.check.json --noEmit`、`tsc -p apps/desktop-host/tsconfig.json --noEmit` 通过。
- `vitest run apps/desktop apps/desktop-host`：171/172 通过；唯一失败的是 `macos-signature.spec.ts` 的
  「加载发布标识并要求代码签名」超时（并行跑时 5 秒预算不够，单独跑 798 ms 通过），与本版改动无关。
- 403 复现与同源对照在**运行中的实例**上实测（见上文小节的两种响应）。
- 商城页面用无头 Edge 渲染并 dump DOM 核对（9/9 链接指向 `mobile.yangkeduo.com` 且 `target="_blank"`）。
- 运行日志窗口的两条路径都在**真实外壳页面**上测过（见上一节表格），不是只在隔离页面里跑通。
- 需要说明的是：我没能直接读到出问题那个窗口的 DevTools 控制台（应用没有开远程调试端口），
  所以空白的**根因**是按「脚本未执行」这一族故障处理的——兜底与自检都会把真正的错误写在窗口里，
  下次它再出问题，窗口本身就会给出答案，而不再是空白。

## 已知限制

- 本版修复要**重新构建并重装**才会到达已安装的副本：改动落在 `apps/desktop-host`（以发布物安装进 profile）、
  `apps/desktop-shell`（Rust 外壳与 `rsc/` 页面，经 `prepare:shell` 复制进资源）两处。构建链路：
  `release:pack` → `pack desktop-host` → `prepare:packages` → `prepare:seed` → `prepare:shell` → `tauri build`。
- 外壳代理那一跳**刻意不改**：它只知道自己的 authority，把 `Origin` 改写成自己的端口等于没改
  （第一轮排查正是踩在这里）。真正需要改写的是知道 webserver 端口的那一跳，也就是 `pluginRoutes`。
- 离线包文件名必须与被绑定的版本一致（`Harness-CN-seed-<版本>.tar.zst` 或 `.tar.gz`），
  这是「按发布名查找」的代价：版本不匹配的归档不会被误用，也不会被识别。
- 手动放置的归档解包后不会删除，用户需要自己清理；自动下载的仍然解包即删。
