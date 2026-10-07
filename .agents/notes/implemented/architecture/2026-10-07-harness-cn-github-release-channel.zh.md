# Agent Note: Harness-CN GitHub release channel

Status: implemented

[English](2026-10-07-harness-cn-github-release-channel.md) | 中文

## Problem

Harness-CN 分发的是桌面壳的未签名 Windows 构建。桌面壳本来已经带有完整的更新流程——工作区打开十秒后的自动检查、本地化的 **检查更新…** 菜单项、原生确认弹窗、以及 `updates` 这组 IPC 接口——但在这个构建里它永远不会触发。协调器由 `electron-updater` 驱动，并以 `process.resourcesPath` 下是否存在 `app-update.yml` 作为启用判据；而未签名构建的打包流程完全省略 `publish` 段，于是那个文件永远不会生成，判据恒为假。它原本会使用的更新源是上游自己的部署，本 fork 并不运营它。结果是一个「代码里看起来存在、却永远报告『已是最新』」的能力，以及告诉用户请手动升级的发行说明。

真正存在的分发渠道是本 fork 自己的 GitHub Releases：安装包作为 release 资产上传在那里。产品里没有任何东西读它。

## Decision

**一条后端缝。** `DesktopUpdateCoordinator` 不再依赖 `electron-updater`。它驱动一个 `DesktopUpdateBackend`——`check()`、`download(request)`、`install()`——并保留它本来就有的一切：进行中检查与安装的合流、向所有窗口发布的 `DesktopUpdateState`、`beforeRestart()` 这一步，以及「下载 → `beforeRestart` → 安装程序 → 退出」的顺序。`electron-updater` 成为该接口的一个实现，在构建确实带有 `app-update.yml` 时使用；它不再是唯一的实现。

**GitHub Releases 渠道是本 fork 实际使用的实现**，在没有 `app-update.yml` 时被选中。它请求 `https://api.github.com/repos/WPH666-py/Harness-CN/releases`，带上 GitHub 要求的 `accept` 与 `user-agent` 头，并且只考虑同时满足三个条件的发布：不是 draft、剥掉前导 `v` 后 tag 能解析为语义化版本、带有名为 `Harness-CN-<版本>-win-x64-setup.exe` 的资产。只有在该版本严格高于当前运行版本时才会被提示。

**装不上的发布永远不会被播报。** 资产要求是「挑选发布」的一部分，而不是后续步骤：没有匹配安装包的发布会被跳过并继续搜索，因此一个更旧但可安装的发布仍然胜过更新但装不上的那个。`download()` 保留自己的拒绝作为兜底，用于资产在检查与下载之间消失的情形。

**用发布列表，而不是「最新」发布。** GitHub 会把标记为 prerelease 的发布从 `/releases/latest` 中略去。本 fork 发行的是候选版本——`0.1.5-rc.1`——而这个标记在这些发布上并不总是被勾选，所以依赖那个端点意味着某天有人勾上复选框后，更新会**静默地停止投递**。列出发布并过滤 draft，是那种不会被发版时的一个复选框关掉的行为。

**有意把 prerelease 提供给 stable 用户。** 版本里的 prerelease 部分被保留，因此 semver 会把 `0.1.5-rc.2` 排在 `0.1.5-rc.1` 之上、把 `0.1.6-rc.1` 排在 `0.1.5` 之上，并且双方的 prerelease 状态都不做过滤。对一个每个版本都是候选版的 fork 来说，过滤就等于永不更新。

**完整性会被校验，缺失也如实上报而不是藏起来。** 资产被下载到平台临时目录下的子目录，并在写入的同一次遍历中计算摘要，因此这约 194 MB 只被读一遍。结果与 GitHub API 为该资产报告的 `sha256:` 摘要比对；不匹配就删除文件并拒绝运行。资产没有摘要的发布——GitHub 是较晚才开始暴露该字段的——会被无校验安装，更新状态会如实说明，而不是暗示做过一次并未发生的校验。

**安装程序就地升级。** 安装以静默 `/S` 开关启动 NSIS 安装程序，由它替换旧版本。桌面壳绝不抢先卸载：那样一旦安装失败，用户会两头落空。

**退出是显式且注入的。** 旧实现从 `electron-updater` 的 `quitAndInstall` 白拿了进程退出。新后端刻意只做 spawn，因此协调器接收一个 `requestExit` 回调，并在安装程序启动之后、仅在成功路径上调用它。桌面壳冲刷日志并调用 `app.quit()` 而非 `app.exit()`，因为安装程序即将触碰的文件正需要一次干净的收尾来解除占用。

**跳过分版本记忆。** 跳过按钮持久化它被按下时对应的版本，并且该版本只在**自动**检查中被压制。手动 **检查更新…** 仍会询问它——那是用户主动问的——而严格更高的版本会重新提示。

## Alternatives considered

- **`electron-updater` 的 GitHub provider。** 否决：它通过随安装包一同发布的频道元数据（如 `latest.yml`）来解析更新，而这里的触发条件是「安装包已上传到该发布」。要求再有一个生成文件被正确上传，是一个没有收益的静默失败面，尤其对一个已经把版本号写进资产名的 fork 而言。
- **为未签名构建产出 `publish`，让 `app-update.yml` 存在。** 否决：那会声明一个无人服务的频道，而且启用该段同时会武装 electron-builder 自己的发布动作，而本构建绝不能这么做。
- **先卸载，再安装。** 否决，理由同上：两步之间失败会让机器一无所有。
- **启动安装程序后用 `app.exit()`。** 否决：它会跳过 `before-quit` 收尾，而那正是安装程序替换文件之前必须跑完的东西。
- **把「没有摘要」当作硬失败。** 否决：那会让经由不产出该字段的途径创建的每个发布永久无法安装，而该字段的缺失并不能说明字节本身有问题。状态改为上报这个更弱的保证。

## Consequences

- 更新流程现在在未签名构建里真正生效——而那是本 fork 唯一发行的构建——不需要代码签名、不需要 `publish`、也不需要第二个被上传的元数据文件。
- 渠道是仓库身份而不是配置：`WPH666-py/Harness-CN` 是一个常量，检查别处的构建就是另一个产品构建。
- 发版时的不变量现在承重：**上传的资产必须与 release tag 用同一个版本号命名。** 不一致会让该发布无法安装，而资产要求会把它降级为「不提示更新」，而不是「下载之后才失败」。本 fork 的上传脚本用写死的文件名给安装包命名，而 tag 来自别处，因此两者可能漂移。
- GitHub 的匿名 API 上限是每地址每小时 60 次。每次启动检查一次远在限额之内，403 或 429 被归类为限流而不是渠道损坏；自动路径在任何失败下都保持静默。
- 下载来自 `github.com`，在部分网络中缓慢或不可达。因此传输带有停滞超时、总时限与进度上报，手动检查会给出真实错误，而不是看起来卡住。
- 本 fork 的 macOS 与 Linux 构建不受影响：该渠道仅限 Windows，且只在走未签名路径时被选中。

## Testing

`apps/desktop/tests/update-github-backend.spec.ts` 覆盖两个方向的版本选择、资产要求及其向更旧可安装发布的回退、「用列表而非 latest」的决定、摘要一致与不一致、摘要缺失、传输的停滞与总时限，以及拒绝下载检查未保留的版本。`apps/desktop/tests/update-coordinator.spec.ts` 覆盖后端缝：「下载 → `beforeRestart` → 安装 → 退出」的顺序、成功安装恰好退出一次、失败安装不退出，以及跳过记录只压制自动路径。所有假 fetch 都遵守 `init.signal`，因为忽略它的替身会让超时测试**空转通过**而不是失败。

除单元测试外，该渠道还对着真实 GitHub API 做过验证：版本选择、资产查找与摘要解析都跑在真实发布上，并且对真实资产 URL 的范围请求返回了 `206` 与 `MZ` 可执行文件头。这证明了除完整交互回路之外的每一环——后者需要一个已发布的第二版本来观察。

## Related

- [Electron Desktop packaging and updates](2026-08-25-electron-desktop-packaging-and-updates.zh.md) 拥有签名发布单元、seed 传输，以及本 note 在其旁边新增第二个后端的 electron-updater 路径。
