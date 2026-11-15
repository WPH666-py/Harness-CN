# Harness-CN 0.1.5-rc.15（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版为补丁：**首次启动若遇到「软件包仓库尚未完整」的失败，现在会自动重新展开并重试一次**，不再需要用户手动再开一次应用。

> **关于版本号**：本发行版的 `0.1.5-rc.15` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.15_x64-setup.exe` | 27.46 MB（28,789,872 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.15.tar.zst` | 78.87 MB（82,703,960 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
FFBB3D510D3A5A52CA5E7F9251E460CB64FDB24C834C18EAA510135367858BF0  Harness-CN_0.1.5-rc.15_x64-setup.exe
F90EFDD7CCB085DDB269CD410060F67E733E9630D4E54210A3FEC4243F6F1510  Harness-CN-seed-0.1.5-rc.15.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 首次启动的「仓库不完整」失败会自动重试

**现象**（rc.14 升级到本机后首次启动时出现）：

```
package store ready; rebuilding the desktop runtime
startup failed: UNKNOWN: unknown error, link '…\pnpm\store\v11\files\4e\e1c88f…' -> '…\staging\…\types.js'
```

应用停在启动窗口，必须手动再打开一次才能正常进入。第二次启动一切正常。

**原因**：桌面运行时不是「安装」出来的，而是从软件包仓库（store）**逐文件硬链接**重建的。
展开仓库与重建运行时是两个阶段，重建开始时仓库里若还有条目没落盘，那一次链接就会失败，
而失败会让整个启动事务回滚退出。这是时序问题，不是数据损坏：仓库内容本身是完整的
（已用归档索引逐项核对：22844 个内容，本地缺失 0）。

**修复**：把「重建运行时」及其后续步骤提取为一个可重试单元。当失败被判定为**仓库内容缺失**
（`profile link … targets a missing store file`、`link '<仓库路径>'`、或落点为仓库内的 `ENOENT`），
就自动重新展开仓库并重试**一次**；重新展开前先清掉半链接的临时目录，避免旧链接被当成已完成的写入。

**只重试一次**是有意的：整个仓库重新展开后仍然不完整，那是真正的故障，
继续循环只会把一个下载损坏的离线包变成永远开不完的启动。

判定失败类型时同时兼容三种报错形态，因为它们来自不同层：链接器自己的
`targets a missing store file`、Node 的 `link '<路径>'`、以及仓库内文件缺失的 `ENOENT`。

### 其余内容与 rc.14 相同

- 插件管理页为只读的**内置插件**（无安装、升级、卸载入口）。
- 顶部菜单：**作者信息**、**休闲食品商城**（9 个商品）、**评价与反馈**。
- 更新链路修复（rc.12 引入）：安装程序由 shell 以 `CREATE_BREAKAWAY_FROM_JOB` 启动。

## 本次发布的验证方式

新增测试 `unpacks the store again and retries when the rebuild finds it incomplete`：
在种子的仓库里删掉一个被链接引用的内容文件、并清掉「本仓库已展开」的标记，然后执行完整的
`applyRelease`。断言它**没有**抛错、返回 `true`、并且最终版本正确——也就是真实走了
「首次链接失败 → 重新展开仓库 → 重试成功」这条路径。

这个测试在实现完成前是**失败**的，而且失败原因正是本次修复的要点：链接器抛的是
`targets a missing store file`，而我最初只匹配了 pnpm 的 `link '…'` 形态，导致重试根本不触发。
测试当场暴露了这一点。

- `pnpm run typecheck`：0 错误。
- `apps/desktop/tests/project-manager.spec.ts`：**17 项通过**（含上面新增的那一项）。
- 完整流程重跑：`build:official` → `release:pack` → `pack desktop-host` → `prepare:packages` → `prepare:seed` → `prepare:shell` → `tauri build`。

**未做**：把 rc.14→rc.15 的升级装到本机后，在真实首次启动里触发「仓库不完整」这一路径。
该路径的触发依赖展开与重建的时序，无法按需复现，因此验证依靠上述单元测试而非现场复现。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板不出现（本基线未声明 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计不可用（需要基线无法设置的 `ignorable` 标记），检测与拦截不受影响。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
