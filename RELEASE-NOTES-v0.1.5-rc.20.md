# Harness-CN 0.1.5-rc.20（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版给内置插件集加了**手机**与**微信**两条入口，并把首次启动要付的那笔编译代价挪到了安装阶段。

> **关于版本号**：`0.1.5-rc.20` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.20_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.20.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、内置 dsh-web-mobile：窄屏、触屏、平板上把界面改成移动端形态

新增内置插件 `dsh-web-mobile@3.0.6`（[仓库](https://github.com/mexiaosqwq/dsh-web-mobile)）。它是**纯客户端插件**：主机半边是一个空 `apply`，只贡献一行客户端 UI，所以它不会给宿主加任何后台任务。

宽屏鼠标环境**完全不动**（插件自己按指针类型判断），窄屏与触屏下才生效：设置、文件树、预览改成底部浮层，输入区在软键盘弹出时上抬，安全区避让，会话行的归档/置顶收进「⋯」菜单，宿主返回的大块 JSON（会话历史等）自动压缩后再传输。平板上 768–1023px 限宽居中，≥1024px 仍可从会话行菜单删除会话。

它运行时只请求一个基线模块 `@deepseek-ai/dsh-client-ui-primitives`——这个模块是 Web 外壳静态模块表里的常驻成员，任何动态插件包都可以请求，因此**不需要**为它额外安装任何包；取不到图标名时它渲染空图标，不会抛错。

### 二、内置 dsh-wechat：微信成为第二个客户端

新增内置插件 `dsh-wechat@0.8.0`（[仓库](https://github.com/pan17/dsh-wechat)）。它把微信私聊通过腾讯 iLink bot 协议桥接到 DSH agent：

- **双向收发**：微信文本/图片/文件/语音 → agent（媒体自动下载到 `~/.dsh-wechat/tempfile/`，以本地路径作为附件注入）；agent 正文与「执行过程」分别推送回微信。
- **微信内 slash 命令**：`/workspace`、`/session`、`/preset`、`/model`、`/perm`、`/silent`、`/notify`、`/status`、`/stop` 等由 bridge 直接处理；DSH 原生命令（`/plan`、`/goal`、`/compact`）走 `ctx.commands` 注册中心，回执与 GUI 一致。
- **审批与提问卡双端同卡**：微信与 GUI 弹同一张原生卡，谁先回谁生效。
- **扫码登录与连接配置**：DSH 设置 → **WeChat** 单卡展示状态、扫码、退出登录、通知/静默开关；配置存 `~/.dsh-wechat/config.json`，重启后自动恢复会话映射。

**版本选择**：0.8.0 是最后一个声明 `engines.dsh >=0.1.2-rc.1` 的发布；0.9.7 起把这条约束固定到 `0.2.0-rc.2`，之后的版本要求 `>=0.2.0-rc.2`。微信桥是**进程内**直接调用宿主服务（`ctx.agent`、`ctx.agents`、`ctx.commands`、`ctx.sessionProjections`）的插件，装一条为 0.2 线写的代码到 0.1.5 基线上，等于让它在运行期去调不存在的接口，所以这里钉 0.8.0 而不是最新版。

### 三、把首次启动的编译代价挪到安装阶段

**问题**：全新安装后的第一次启动要现场装配桌面运行时（展开包存储、链接整棵插件树、校验 2.8 万个文件），用户要等上好几分钟，而这段时间界面上只有一个进度条。

**修复**：

- 安装程序在文件就位后、首次启动前运行 `--prebuild`：用同一个事务把运行时装配好，失败不致命（首次启动会照旧自己装配一遍），失败原因写进 `shell.mjs` 的 stderr，安装程序收进自己的日志。
- 宿主进程改用 Node 的**磁盘编译缓存**（`<harness home>/node-compile-cache`，放在 profile 之外，升级替换 profile 时不会连缓存一起丢掉），第二次及以后启动复用已编译字节码。
- 运行日志窗口继续如实报告它显示不了的内容。

### 四、退出与「卡」的收尾

上一版把退出改成握手（先请求宿主收尾，超过预算才强杀）。本版补齐这条路径的**可见性**：收尾预算、超时后结束进程、以及需要强杀时都各写一行运行日志——下次再遇到「点一下要等」，运行日志里应当能直接读到当时卡在哪一步，而不是只看得到一个白窗口。

### 五、把 `compress` 归进规则引擎的工具分类表

**问题**：`dsh-rule-engine` 按「工具分类表」判定工具，表外的工具一律拒绝，只在会话内按用户明确许可放行一次。`compress`（把一段对话折叠成摘要块）是 DSH 的官方工具，但不在 0.6.4 的表里，于是每换一个新 profile（首装、以及每次升级）它都会重新消失一次，用户只能再许可一遍。引擎自己在拒绝信息里写明的长期做法，就是补进分类表。

**修复**：分类表是插件包内的数据、不是引擎读取的配置，所以补它的位置只能是**离线包**：

- `apps/desktop/scripts/patch-rule-engine.mjs` 把 `compress` 写进已安装的分类表（`artifact` 类：它只写会话存储，没有文件副作用，与 `todo_write`、`skill` 同类），并在写完后重新 import 该文件逐项断言：`compress` = `artifact`，而 `read`/`edit`/`pwsh`（只读与写入两种命令）/`mcp__*` 等原判定一个都不许动。
- `prepare:seed` 在安装完离线包后立刻打这个补丁：补丁写的是 store 归档的源文件，所以**之后从这份离线包物化出来的每个 profile 都带着它**——首装、以及以后每次升级重建 profile 时都在内。
- 覆盖写而不是就地改：pnpm 把 store 条目**硬链接**进 profile，就地写会顺着链接改掉 store 里的原件，而记录里那些条目的哈希还是旧的。
- `verifyOfflineInstallation` 现在会把物化出来的那棵树的分类表**读回来**校验，`apps/desktop/scripts/materialize-seed-check.ts` 用启动器自己的物化路径重放一遍；补丁若在归档环节掉了，构建就会失败，而不是发出去。

## 本次发布的验证方式

- `pnpm --filter @deepseek-ai/dsh-desktop run prepare:seed`：新增两个 pin 后离线包重建通过，`verifyOfflineInstallation`（把 profile 从 store 链接清单物化出来再校验）通过；两个包被记为 `file:` 依赖并写进 `dsh.profile.bundles`。
- 独立实例实测（临时 `DSH_HOME`，`--resource-dir` 指向新构建的 sidecar）：启动到 `ready`，`/shell-api/plugins` 列出 12 个内置插件，`dsh-web-mobile@3.0.6` 与 `dsh-wechat@0.8.0` 均为 `bundled: true`。
- 客户端组合实测：`window.__DSH_BOOT__` 图中两行都在（`batch phase=application`，`inject` 边完整，`external` 为空），两个 `client.js` 组合端点都返回 200（mobile 690,438 B / wechat 17,903 B），各自注册为 `dsh-web-mobile` / `dsh-wechat`。
- 浏览器实测：桌面宽度 1440×900 与手机宽度 390×844 各跑一次真实页面，**控制台与页面异常均为 0**；设置页出现 **WeChat** 卡片（与「通用设置 / 模型 / 插件 / Agent 预设 / 会话导入 / 费用」并列）。
- `cargo check --release`、各 app 的 `tsc` 通过；安装程序与离线包由同一条 `tauri build` 链路产出。
- `compress` 分类补丁：先在一份未改动的 `dsh-rule-engine@0.6.4` 上验证「补之前 = `unknown`、补之后 = `artifact`、重复运行不重复写」，再让 `prepare:seed` 带着补丁重建离线包，最后用启动器的物化路径从**归档后的**离线包还原出 profile 并读回分类表（`compress=artifact`，其余判定不变）。

## 已知限制

- **微信登录需要腾讯 iLink bot**：设置页扫码前请先在 `~/.dsh-wechat/config.json`（或设置页）确认连接配置；token 缺失或失效时不向微信推送，日志会写明原因。
- **微信桥只服务第一个微信用户**（插件自身设计）。
- `dsh-wechat` 钉在 0.8.0：0.9.x/0.10.0 的跨会话 `/notify` 细分等功能不包含在内；要升到那条线需要先把基线升到 0.2.x，或按 0.2 接口逐项做兼容移植。
- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 安装包仍然未签名，因此每次更新都要重新过一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
