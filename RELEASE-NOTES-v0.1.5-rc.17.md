# Harness-CN 0.1.5-rc.17（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版为补丁：**修复首次启动在「重建运行环境」阶段直接失败**——Windows 拒绝创建某个硬链接时报 `UNKNOWN` 错误，整个启动事务随之终止。

> **关于版本号**：本发行版的 `0.1.5-rc.17` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.17_x64-setup.exe` | 27.46 MB（28,802,019 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.17.tar.zst` | 78.74 MB（82,566,988 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
D7450CF35719599A81CB0B4186F605E9A484EC8AB9944B32C007A3DDD016AF7E  Harness-CN_0.1.5-rc.17_x64-setup.exe
60505D94521E276E56CF80872399330710F50F4239381DB5036C66068C8F2191  Harness-CN-seed-0.1.5-rc.17.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 修复：重建运行环境时硬链接被拒导致启动失败

**现象**：首次启动进行到「重建运行环境」时直接报错退出：

```
UNKNOWN: unknown error, link '<包存储路径>' -> '<profile 路径>'
```

**原因**：重建过程把 profile 从包存储里逐文件**硬链接**出来，原先只容忍 `ENOENT`（源文件缺失），
其它任何链接失败都会中止整个启动事务。而 Windows 对「被拒绝的链接调用」报的是 `UNKNOWN`，
并不说明原因——现场实测源文件存在、可读、内容正确（11 字节的 `export {};`），磁盘还有 90 GB 空余，
即拒绝是针对这一次链接调用本身的，与内容缺失无关。

rc.15 加的「软件包仓库不完整时重新展开重试」对这种形态无能为力：包存储按内容寻址、从不被覆写，
重新解包后同一个文件还是会同样失败。

**修复**：单个条目链接失败时**回退为复制**。字节完全一致，产出的 profile 与链接构建的完全相同；
`ENOENT` 仍然单独报错并指出缺失的条目（那种情况下复制同样会失败，值得诊断）。
发生回退的本次启动会在日志里报告复制了多少个条目。

### 其余内容与 rc.16 相同

- 已有实例运行时点击桌面图标，按进程归属找回并前置窗口，不再依赖会被 WebView2 覆盖的窗口标题（rc.16）。
- 首次启动遇到「软件包仓库不完整」时自动重新展开并重试一次（rc.15）。
- 更新链路修复：安装程序由 shell 以 `CREATE_BREAKAWAY_FROM_JOB` 启动（rc.12）。
- 只读的**内置插件**页、**作者信息** / **休闲食品商城**（9 个商品）/ **评价与反馈** 三项菜单。

## 本次发布的验证方式

- 现场诊断（本机实测）：复现 `UNKNOWN` 链接拒绝，确认源文件存在且内容正确、磁盘空间充足，
  即失败与内容无关；确认该失败形态下重试解包必然复现同样失败。
- 单元测试覆盖链接拒绝的回退复制路径与 `ENOENT` 的独立报错路径（`apps/desktop/tests/seed-store.spec.ts`）。
- 完整流程重跑：`build:official` → `release:pack` → `pack desktop-host` → `prepare:packages` →
  `prepare:seed` → `prepare:shell` → `tauri build`。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板不出现（本基线未声明 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计不可用（需要基线无法设置的 `ignorable` 标记），检测与拦截不受影响。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
