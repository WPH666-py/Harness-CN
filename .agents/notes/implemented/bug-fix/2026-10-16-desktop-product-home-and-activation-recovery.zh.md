# Agent Note: Harness-CN starts from its own home and never deletes a running runtime

Status: implemented

[English](2026-10-16-desktop-product-home-and-activation-recovery.md) | 中文

## Problem

2026-10-16，一台同时装有 DSH NEXT 的机器上，Harness-CN 0.1.5-rc.25 的启动界面显示「已用时 157 秒」，随后以 `EPERM, Permission denied: \\?\C:\Users\admin\.dsh\profiles\desktop` 失败（shell 日志结尾是 `startup failed: EPERM, Permission denied: …`）。同一台机器上正常的启动仍然要 87–90 秒。

日志能对上这 157 秒：离线包下载 57 秒、仓库解包 32 秒、30110 个文件的 pnpm 链接 38 秒、暂存运行时校验 4.8 秒，以及 17 秒的激活重试；每次运行里 shell 自己的工作都不超过 3.2 秒。造成这个序列的是两个缺陷。

第一个缺陷是两个产品解析到了同一个 home。`packages/util/home-paths` 的 `resolveDshHome` 回答的是 `$DSH_HOME || ~/.dsh`，所以 Harness-CN 与 DSH NEXT 共用 `~/.dsh`。DSH NEXT 已经把 `~/.dsh/profiles/desktop/package.json` 改写成自己的 `desktopNextPlugins` 字段并占用了共用的软件包仓库，于是 `DesktopProjectManager.profileMatchesRelease` 永远无法命中，每次启动都从离线包重建 profile；它正在运行的 Host 又持有 `~/.dsh/profiles/desktop` 里的文件，激活时的重命名无法把该目录移开，Windows 便回以 EPERM。

第二个缺陷是 `activate()` 会删掉它正在替换的运行时。它的 catch 在做任何检查之前先执行 `if (existsSync(this.paths.profile)) removeOwnedDirectory(this.paths.profile)`，于是 EPERM 变成了清理失败，一个可用的 profile 被销毁；journal 停在 `active-moved` 步骤、旁边留着一棵空的 staging 树，`recover()` 再也无法恢复任何东西。

## Decision

Harness-CN 使用自己的 home。`apps/desktop/src/product-home.ts` 导出 `adoptHarnessCnHome(env)`，由两个入口在解析任何 desktop 路径之前调用——`apps/desktop-shell/src/shell-main.ts` 的 `prebuild` 与 `main`（经由本地 `adoptHome` 助手）以及 `apps/desktop/src/main.ts`——它在变量未设置或为空白时把 `DSH_HOME` 指向 `%USERPROFILE%\.harness-cn`，并返回 `resolveDshHome(undefined, env)`。显式设置的 `DSH_HOME` 仍然优先，`packages/util/home-paths` 继续以 `~/.dsh` 作为引擎默认值。

旧的用户数据只复制一次。`migrateLegacyHarnessHome` 把凭据、设置文件、sessions、storages 与 attachments 从 `~/.dsh` 复制进新 home——绝不复制 `desktop/`、`profiles/`、`logs/`、`recovery/`、`electron-user-data/` 或任何其它运行树——并且只在旧 home 没有任何 DSH NEXT 痕迹（`logs/desktop-next*`、`profiles/desktop/desktop-next*`，或 profile manifest 中含 `desktopNext`）时才复制。旧 home 永不被删除或移动，新 home 中已存在的文件永不被覆盖，`home-migration.json` 只在复制成功之后写入，所以被跳过或部分失败的迁移会在下次启动重试。

激活只在它所记录的动作落地之后才发布对应的 journal 步骤：移开之前写 `prepared`，移开之后写 `active-moved`，替换启动成功之后写 `staging-activated`。catch 现在调用 `settleActivation(activeMoved)`，把被移开的运行时放回 profile；只有 `activeMoved` 证明本次事务确实往该路径写过东西时，才会删除 profile 路径。如果该路径仍被某个进程占用，修复留给下一次启动按 journal 重做。EPERM、EACCES、EBUSY 的重命名失败由 `renameConflictError` 报成 `desktop project: the Harness-CN runtime at <path> is in use and could not be moved; close every Harness-CN window and any other program using this home, then start again`。

`recover()` 现在返回 `DesktopRecoveryReport` 而不是什么都不返回，`describeDesktopRecovery` 渲染它，两个入口都记录它，于是被恢复或被丢弃的运行时是可见的而不是静默的。`staging-activated` 的 journal 会丢弃已提交 profile 旁边那份被取代的副本；更早的步骤则恢复被移开的运行时。

`apps/desktop/tests/product-home.spec.ts` 覆盖采用、迁移、不覆盖与 DSH NEXT 痕迹检测；`apps/desktop/tests/project-manager.spec.ts` 新增四个用例，包括 `keeps the active profile when the replacement cannot move it aside`（即上面的缺陷）以及一个仅 Windows 的用例：打开的文件句柄把 profile 钉在原地，报错点名该路径。

## Alternatives considered

- 把 `packages/util/home-paths` 的引擎默认值改成产品目录。该 resolver 是与同一仓库里的上游产品共用的唯一事实来源，移动它也会移动 DSH NEXT 的数据。
- 继续共用 home，改为检测另一个产品，例如读 `~/.dsh/logs/active-run.json` 或写自己的 pid 标记。这会让本产品成为另一个产品私有文件的读者，而且 pid 标记是第二事实来源：它会过期，也看不见根本不是 Harness 的进程；目录重命名本身已经用 EPERM 回答了「是否被占用」。
- 保留 catch 里的 profile 删除，但先用 `existsSync(this.paths.rollback)` 守卫。真正要紧的事实是 journal 步骤与内存里的 `activeMoved`，而 `existsSync(profile)` 对本次事务移开过的 profile 和从未碰过的 profile 都成立。
- 用复制代替移开。复制一棵三万文件的运行时会翻倍峰值磁盘占用，并在每次安装与每次更新时拉长已安装 profile 处于不一致状态的时间。
- 把新的「被占用」文案本地化。今天其它 `DesktopProjectManager` 失败也都是以自己的英文文本进入启动对话框的，只翻译一条反而不一致；这个缺口记在下面。

## Consequences

两个产品可以并存：各自拥有 home、软件包仓库与 profile，谁也无法让对方的运行时失效或把它占住。已经运行过 Harness-CN 的用户会在新版首次启动时把凭据、会话与设置复制进 `~/.harness-cn`，而 `~/.dsh` 的内容照旧，所以磁盘增长只有被复制的那部分用户数据。

改动后的首次启动面对的是一个空 home，因此会重建一次运行时（在所报告的机器上，离线包已缓存时 65 秒，仍需下载时约 100 秒），除非旧 home 是 Harness-CN 独占的。

失败的激活不再能毁掉可用的运行时；无法移开 profile 的启动会说出是哪个路径被占用，而不是用清理失败替换掉真正的原因。恢复过程保持幂等：它只移动目录，并在最后删除 journal。

「被占用」消息与恢复行是英文的，而本产品的 shell 文案由 `apps/desktop/src/locale.ts` 拥有。本地化被推迟，因为这些路径在 Host 之前运行，且它们的文本进入的是 MessageBox，而不是能感知 locale 的界面。

那次首次启动安装的运行时也只有一个版本能启动。0.1.5-rc.25 离线包里的 `desktop.cordis.patch.yml` 没有禁用 `directory-picker-mobile-host` 与 `directory-picker-mobile-surface` 两行，于是随包内置的插件会替换 stock 的 picker 行并插入自己的一对 browse 后端，而补丁又插入了 native 那一对，两者注册同一个单例 `directoryPicker` 服务；第二次注册让整棵插件树以 `service "directoryPicker" has been registered at <BrowseDirectoryPicker>` 失败。本树里的补丁禁用了这两行，用同一份离线包在全新 home 上启动没有再出现 picker 冲突，这就是空 home 首次启动是安全的原因。

本笔记不改变报告里量到的健康启动开销：运行时仍是 30110 个文件的目录树，Host 仍要约 87–90 秒才报告就绪，安装包仍不带离线包。首次启动所要付的重建路径已因一次并发的仓库合并而变短（见[离线包仓库合并笔记](../simplification/2026-10-16-desktop-seed-store-concurrent-merge.zh.md)）；缩短其余部分属于另外的工作。

本决定部分取代 [one harness home resolver](../architecture/2026-07-24-single-harness-home-resolver.zh.md)：它的优先级规则与拒绝拆分根的决定对引擎仍然成立，而 Harness-CN 桌面产品现在在自己的入口固定 `DSH_HOME`。在本产品下，[Electron desktop packaging and updates](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 记录的布局从 `~/.harness-cn/` 开始而不是 `~/.dsh/`；该笔记关于 profile 所有权、激活 journal 与锁的决定不变。
