# Harness-CN 0.1.5-rc.25（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版修掉**点击「立即更新」后更新窗口不显示进度条**的缺陷：更新窗口的那一次点击现在会立刻画出进度条，安装路径不再有「静默失败」，下载失败时也能在日志里读到真正的原因。

> **关于版本号**：`0.1.5-rc.25` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。
>
> **rc.21 的微信桥不可用**：rc.21 里 `dsh-wechat` 钉在 0.8.0，该版本的会话创建回调会读 `ctx.agent`，被 Cordis 拒绝后每条微信消息都只能回复「⚠️ 无法创建/恢复 DSH 会话」。请用 rc.23 或更新版本。
>
> **rc.22 装得上、但升不上去**：rc.22 重建已有 profile 时会被一份改写坏掉的 pnpm 记录与「把旧钉版当成用户插件」两步卡住。请用 rc.23 或更新版本。
>
> **rc.20 及更早不要再用**：它们带启动失败的 `ENOTEMPTY` 缺陷。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.25_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.25.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、点击「立即更新」会立刻显示进度条（本版新增）

**现象**：在更新窗口里点「立即更新」，窗口停在原样——按钮按下去没有反应，进度条不出来，既不说在下载也不说失败。

**根因**：进度条只在更新状态机的 `installing` / `ready` 阶段才显示，而当时发布这一帧的最小路径要先把 `install()` 走起来才发布；`install()` 又会去等一个可能仍在进行、或已经失败的检查操作。于是这次点击要么被排在一个迟迟不返回的检查后面，要么在「没有可安装的更新」时从 `try` 之外直接抛出——两种情况都不会发布任何一帧，窗口自然什么都不画。

**修复**（`apps/desktop/src/update-coordinator.ts`）：

- **点击的那一刻同步发布起始帧**：`install()` 在 `await` 任何东西之前先发布 `{ phase: 'installing', progress: 0, downloaded: 0 }`（在已保留到发布物时），所以无论后面走得多远，窗口立刻就有东西可画。
- **只等已经在跑的检查**：`install()` 只等待已经在进行的检查，绝不新起一个检查；检查失败也会转成可见状态，而不会让这次安装失败。
- **没有可安装的更新也给出答复**：`doInstall()` 在发布物缺失时不再抛出（此前会变成一个页面渲染不了的 500），而是发布 `phase: 'error'` 与「没有可安装的更新，请先检查更新。」——点一下总能看到一个结果。

### 二、安装与下载不再「静默失败」（本版新增）

**现象**：更新明明失败，运行日志里却一行记录都没有，只能看到一个停住的窗口。

**修复**（`apps/desktop/src/update-coordinator.ts`）：

- 安装下载的**开始、成功、失败**各写一行运行日志（`desktop update <版本>: downloading the installer` / `downloaded (<校验结果>)` / `failed: <原因>`），失败时把那次的错误正文一并写入。
- 「没有可安装的更新」也会写一行日志，而不是静默返回。

### 三、下载失败时能读到真正的原因（本版新增）

**现象**：更新下载失败时，窗口和日志里只有一句 `fetch failed`，看不出是 DNS、代理、超时还是证书问题。

**根因**：Node 的 `fetch`（undici）把失败原因放在 `error.cause` 里，而错误在向上抛出时只剩最外层那句 `fetch failed`。

**修复**（`apps/desktop-shell/src/release-channel.ts`）：新增 `describeFailure`，沿 `error.cause` 链收集最多四层原因，拼成 `fetch failed (… <- …)` 再抛出——下次更新下载失败时，窗口与日志里会带着底层原因。

## 本次发布的验证方式

- **前端渲染链路实测**：在本机运行的外壳上打开更新窗口，用真实点击触发「立即更新」，进度条随即出现并随下载推进；`/shell-api/events` 的 SSE 事件流里能读到连续的 `installing` 帧。
- **单元测试**：`apps/desktop/tests/update-coordinator.spec.ts`（含「点击后立即发布 installing 起始帧」「发布物缺失时发布 error 而非抛出」）与 `apps/desktop/tests/update-skip-persistence.spec.ts` 全绿；全量 desktop 测试通过。
- **运行日志**：点击安装后会依次出现 `downloading the installer`、`downloaded (…)` 或 `failed: <原因>` 的日志行。
- **发布物自检**：`scripts/release/verify-harness-cn-release.mjs <版本> <目录>` 把安装包与离线包在本机、GitHub、Gitee 三处逐一比对 sha256，全部一致才算发布完成。

## 已知限制

- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 安装包仍然未签名，因此每次更新都要再走一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
