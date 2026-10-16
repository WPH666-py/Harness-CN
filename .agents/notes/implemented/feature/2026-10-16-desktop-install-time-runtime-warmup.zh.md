# Agent Note: Setup warms the desktop runtime before the first launch

Status: implemented

[English](2026-10-16-desktop-install-time-runtime-warmup.md) | 中文

## Problem

2026-10-16 的启动报告把健康启动路径留在约 87 秒，而外壳自己在其中的份额最多 3.2 秒。应用日志把剩下的部分拆成两段：`desktop runtime already matches the bundled release` 之后到后端第一行输出之间的 70.1 秒，以及 `backend ready` 之前那趟约 15.8 秒的微信扫码往返。对同一份 profile 的探针把这段静默再拆成加载器阶段与插件/webserver 阶段，当运行时的文件已经在系统缓存里时两者合计 9.1 秒；而同一次探针在同一 profile、同一环境下另一次运行，把后一次 9.1 秒就跑完的阶段测成 62.1 秒。V8 编译缓存已被排除：两次运行前后 `desktop/node-compile-cache` 都是同样的 32 个文件、2 651 144 字节。

剩下的就是已安装运行时那棵树的一次冷首触：30 110 个文件，每个都要付一次 Windows 打开，再加杀毒软件首次看见它时的开销；作为对照，DSH NEXT 把同一个引擎放在一个打包的 181 MB `app.asar` 里，用 4.96 秒启动。产品里没有任何地方在可以藏起这笔开销的地方付过它：`--prebuild` 负责安装发行版并做结构化校验，并且刻意从不启动它，于是每个用户都在自己的第一次启动时、在 splash 界面前面付掉整笔冷启动成本。

## Decision

`apps/desktop-shell/src/shell-main.ts` 新增 `warmRuntime`，`prebuild` 在发行版就位之后调用它一次。它用 `main` 使用的同一个编译缓存目录、从活动 profile 启动一个 `DesktopHostProcess`，等 host 报告就绪，写出 `desktop runtime warmed: dsh <version> in <n> s`，然后把它停掉。失败只记一行 `desktop runtime warm-up failed: <message>`，不改动任何其它东西：安装程序仍然以 0 退出，首次启动的行为与改动之前完全一样。

这次预热刻意不放进 `applyRelease` 的 `healthCheck` 钩子。那个钩子在激活之前校验暂存树；预热跑在事务已提交之后的活动运行时上，因此它无法影响激活或回滚。

`prebuild` 的 JSDoc 原本记录的是相反的决定（"The Host is deliberately not started: composing the runtime is the long part, and booting it here would cost the fifty seconds the structural check exists to avoid"），现在记录的是这一条：安装期是唯一能在无人盯着 splash 界面时付掉「每个运行时文件第一次被打开」这笔钱的地方。

## Alternatives considered

- 保持安装期原样，把冷启动成本留给首次启动。它是正确的，每个文件在每台机器上也只会冷一次，但那一次恰好落在用户正在评判这个产品的时刻。
- 在 `healthCheck` 里启动暂存树。那个钩子本来就会为插件增删改启动一次暂存运行时，但用在这里会把一分钟的首触工作塞进一个可能回滚的事务，而且会让每次发行安装都为结构化校验已经做过的检查付费。
- 改在 `main` 里预热。启动路径上有一个 splash 界面和一个在等的用户；安装程序两者都没有。
- 像 DSH NEXT 那样把运行时打包成单个 181 MB `app.asar`。那从根上攻击按文件的代价，也是唯一能接近 5 秒的路线，但它改变桌面 profile 的物化方式，不是这次改动能承载的决定。
- 用一趟单独的「只编译」流程预热 V8 编译缓存。已实测并否决：在 62.1 秒的冷启动与 9.1 秒的热启动之间缓存内容完全一致，所以静默不是它构成的。
- 把第三方微信扫码挪出就绪路径。已实测：跳过 `bridge.start()` 让同一 profile 的就绪时间从 18.6 秒降到 15.3 秒，最多约 3.3 秒，而 `dsh-wechat` 是第三方打包物，只有 seed 期的补丁脚本可以碰它。

## Consequences

安装期现在要花约 15 秒启动并停止运行时，用户的首次启动则从一棵系统已经打开过一次的树开始。在这些测量所用的 profile 上，同一个 host 热态用 15 秒报告就绪，而应用日志里的冷态静默是 70.1 秒；预热那次运行本身打印的是 `desktop runtime warmed: dsh 0.1.5-rc.25 in 15 s`。

安装程序在报告成功之前要多花这些时间。NSIS 钩子本来就给整个 `--prebuild` 调用留了 20 分钟预算，所以多出来的这次启动不构成新的超时风险。

预热不是健康检查，也不能被当作健康检查来读。它只证明运行时启动过；失败时除了一行日志什么都不改变，没有任何回滚、暂存清理或 journal 记录依赖它。

有一种失败模式值得写下来，因为它在验证本笔记时被观察到：当运行时自带的 `node.exe` 跑在一个拒绝操作系统临时目录的文件沙箱下时，`@deepseek-ai/dsh-spill-local` 的 `mkdtemp` 会以 `EPERM` 失败，整次启动随之死掉。被复制进受沙箱约束的 workspace 的 `node.exe` 无法在 `%TEMP%` 里创建目录，而同一个二进制放在它外面就可以；那次预热按设计把失败记了下来并以 0 退出。

首次启动仍然要付微信扫码往返，仍然要打开一棵 30 110 个文件的树；本笔记只是把首触提前，而不是取消它。新钩子所在的安装与激活路径仍归 [Electron 桌面打包与更新](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 所有，它启动的 profile 归 [产品 home 笔记](../bug-fix/2026-10-16-desktop-product-home-and-activation-recovery.zh.md) 所有，与它并列测量的重建路径归 [仓库合并笔记](../simplification/2026-10-16-desktop-seed-store-concurrent-merge.zh.md) 所有。
