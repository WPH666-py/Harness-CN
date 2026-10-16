# Harness-CN 0.1.5-rc.27（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版在 rc.26 之上只补一处交互：**点「登录」后授权页自己弹出来**，不再需要用户在状态行旁再点一次链接；同时让离线包重新回到 Gitee——按固定大小分卷发布，绕开该站 100 MB 的附件上限。

> **关于版本号**：`0.1.5-rc.27` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。
>
> **rc.26 的全部改动都在本版里**：自定义数据目录（与 DSH NEXT 并存）、激活失败不再删运行时、重建运行时更快、安装期预热、三个新内置插件、DeepSeek 账号登录与赠金、typert codec 兼容惰性 schema 工厂。逐条说明见 [RELEASE-NOTES-v0.1.5-rc.26.md](RELEASE-NOTES-v0.1.5-rc.26.md)。
>
> **rc.25 的全新环境可能起不来**：rc.25 内置的 `desktop.cordis.patch.yml` 缺少 `directory-picker-mobile-host` / `directory-picker-mobile-surface` 两条禁用项，随包内置的第三方插件会插入自己的 `browse` 后端并与补丁插入的 `directory-picker-native` 争抢同一个单例服务，报 `service "directoryPicker" has been registered at <BrowseDirectoryPicker>`。请用 rc.26 或更新版本。
>
> **rc.21 的微信桥不可用**：rc.21 里 `dsh-wechat` 钉在 0.8.0，该版本的会话创建回调会读 `ctx.agent`，被 Cordis 拒绝后每条微信消息都只能回复「⚠️ 无法创建/恢复 DSH 会话」。请用 rc.23 或更新版本。
>
> **rc.22 装得上、但升不上去**：rc.22 重建已有 profile 时会被一份改写坏掉的 pnpm 记录与「把旧钉版当成用户插件」两步卡住。请用 rc.23 或更新版本。
>
> **rc.20 及更早不要再用**：它们带启动失败的 `ENOTEMPTY` 缺陷。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.27_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.27.tar.zst` | 见发布页 | 离线包（GitHub：整包） |
| `Harness-CN-seed-0.1.5-rc.27.tar.zst.part1of2` / `.part2of2` / `.parts.txt` | 见发布页 | 离线包（Gitee：分卷，见下文拼接方法） |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、登录时授权页自动打开（本版新增）

**现象**：rc.26 里点「登录」后，只有状态行变成「请在浏览器中继续」，用户还得自己在状态行旁再点一次「打开」，浏览器才会跳到授权页；官方桌面端与同类发行版都是自动弹出来的。

**根因**：账号平台包只负责**产生** `authorizeUrl`（`browserUrl(...)` 把回跳地址改写成客户端地址），它自己不打开任何窗口；rc.26 的那一行把这个地址渲染成一个链接就结束了，没有任何组件去打开它。

**修复**（`packages/client/ui-settings-account-harness/src/client/AccountSection.tsx`）：一次尝试进入 `waiting-browser` 并带上 `authorizeUrl` 时，该行用 `window.open(url, '_blank', 'noopener,noreferrer')` 打开它一次——以尝试 id 为键，因为账号状态流每一帧都会重发同一份快照，按 id 判定才不会重复弹窗——并继续在状态行旁保留「打开」链接：出货的 Tauri 外壳会把新窗口请求交给系统浏览器，而开发用的 Electron 外壳拒绝一切新窗口，那里只剩这个链接可用。

**测试**：新增一个用例覆盖「每次尝试只自动打开一次、同一尝试重发或推进不重开、没有 URL 时不开、未进入 `waiting-browser` 时不开、链接仍在」。该包现为 8 个 spec、94 个用例，逐文件覆盖率仍是 100/100/100/100。

### 二、离线包在 Gitee 上分卷发布（本版新增）

**背景**：rc.26 新内置的记忆插件把离线包从 96.9 MiB 推高到 122.2 MiB，超过 Gitee 单个附件 100 MB 的上限，rc.26 的离线包因此只能从 GitHub 下载。

**做法**：

- 新增 `scripts/release/split-offline-package.mjs`：把归档按 64 MiB 切成 `Harness-CN-seed-<版本>.tar.zst.part1of2`、`.part2of2`，并写一份 `….parts.txt`，内含每一卷与整包的 sha256、以及拼接方法（Windows 与 POSIX 各一条命令）。分卷是归档的逐字节切片，按名字顺序拼接即可还原。
- Gitee 的发布带上**安装包 + 两卷 + 清单**；GitHub 仍发整包，两边的安装包是同一个文件。
- `apps/desktop-shell/scripts/prepare-shell.mjs` 的体积检查改为**默认不设上限**（原来默认 100 MB 并在超限时让构建失败）：离线包已经能分卷发布，「装不进一个附件」不再是构建期该拦下的问题；`HARNESS_CN_SEED_LIMIT_MB` 仍然有效，设成正数可让必须单附件发布的构建照旧在这里失败。

## 本次发布的验证方式

- **客户端包测试**：`packages/client/ui-settings-account-harness` 的 8 个 spec、94 个用例全部通过；`--coverage.include='packages/client/ui-settings-account-harness/src/**'` 的 `All files` 为 100/100/100/100，未覆盖位置一栏为空。
- **类型与产物**：`tsc -b packages/client/ui-settings-account-harness/tsconfig.json` 与 `tsc -b tsconfig.client.json` 均以 0 退出；`run-oxlint.ts` 对该包报 0 个警告、0 个错误；进包的客户端半边 `lib/client.js` 34 479 字节（gzip 9 677 字节，sha256 `fa47807d7958afc57cefd0dc37985284492a1adb377e8a8a51dacf996c3e6179`，含自动打开授权页的那一行）、宿主半边 `lib/index.js` 388 字节。
- **骨架门禁**：`verify-client-packages` 报 52 个客户端包（47 个动态、5 个静态）满足包模式与模块请求规则；`gen-client-catalog.ts --check` 与 `gen-tsconfig-paths.ts --check` 都报已是最新。
- **文档门禁**：`verify-agent-note-format`（339 篇）与 `verify-agent-note-classification`（339 篇）全部通过；`verify-translation-pairing`、`verify-md-links`（1603 个文件）、`verify-package-readme-summaries`（320 篇）、`verify-package-readme-limitations`（269 篇）均通过；账号包的 README 与 Agent Note 已就地更新。
- **构建**：`build-harness-cn-tauri.ps1 -SkipPrepare` 以 0 退出；安装包 `Harness-CN_0.1.5-rc.27_x64-setup.exe` 28 835 209 字节、sha256 `3b46b80a394f240a3401133ae364a402b4fcec3d65a9392f1126b875ae96aa35`；离线包 `Harness-CN-seed-0.1.5-rc.27.tar.zst` 127 911 057 字节（122.0 MiB）、sha256 `9b835aac3aa0edb35b6602bc5e653caf8e066de984ed6e9c7b6d31a115a390e0`；分卷 `…part1of2` 67 108 864 字节、`…part2of2` 60 802 193 字节，拼接后与整包逐字节一致（见下）。

### 本次实际发布

- **GitHub**：[`v0.1.5-rc.27`](https://github.com/WPH666-py/Harness-CN/releases/tag/v0.1.5-rc.27)（prerelease），资产为安装包（28 835 209 字节）与整包离线包（127 911 057 字节），服务端记录的摘要与本地构建逐字节一致。
- **Gitee**：[`v0.1.5-rc.27`](https://gitee.com/ph-wang/Harness-CN/releases/tag/v0.1.5-rc.27)，资产为安装包、两卷离线包（67 108 864 + 60 802 193 字节）与分卷清单。
- **回读校验**：两处的每个资产都从各自的下载地址重新下载并算过 sha256——安装包 `3b46b80a…aa35`、离线包 `9b835aac…90e0`；Gitee 的两卷拼接后同样是 127 911 057 字节、sha256 `9b835aac…90e0`，与 GitHub 整包逐字节一致。
- **未演练的部分**：真实 DeepSeek 账号登录、真实赠金到账与确认仍未在本机演练；Windows 载体上的界面观感需要人工确认。

## 已知限制

- **Gitee 上的离线包是分卷**：两卷必须都下载后按 `….parts.txt` 的命令拼接，再按整包的 sha256 校验；只想拿整包的话请从 GitHub 下载。分卷只是为了绕过 Gitee 的单附件上限。
- **首次启动仍要扫码**：`backend ready` 之前仍会等 `dsh-wechat` 的微信扫码往返（约 9–16 秒，超时上限 5 分钟）。它是随包安装的第三方插件，本版没有改动它。
- **冷启动成本只是被提前，没有消失**：安装期预热让用户首次启动不再独付这笔钱，但 30 110 个散文件的按名开销仍在（对照 DSH NEXT 用单个 181 MB `app.asar` 启动同一引擎只要 4.96 秒）。把桌面运行时打包成单文件属于架构级改动，本版未做。
- **运行时被占用时的提示是英文**：`desktop project: the Harness-CN runtime at … is in use and could not be moved; …` 与其它 `desktop project:` 错误一样直接显示在失败对话框里，尚未本地化。
- **Electron 开发外壳里点不开外部链接**：出货的 Tauri 外壳会把新窗口请求交给系统浏览器，因此授权页、充值页与用量页在正式应用里正常打开；仓库自带的 Electron 开发外壳拒绝一切新窗口，自动打开与链接在那里都没有反应。
- **离线包仍不在安装包里**：安装程序不带 seed，安装期 `--prebuild` 会先下载约 122 MiB 的离线包再重建；本版缩短的是重建，不是下载。
- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 安装包仍然未签名，因此每次更新都要再走一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
