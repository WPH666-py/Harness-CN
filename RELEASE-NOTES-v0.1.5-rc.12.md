# Harness-CN 0.1.5-rc.12（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版**修复应用内更新从不生效的缺陷**（rc.9 起存在），此外没有功能改动。

> **关于版本号**：本发行版的 `0.1.5-rc.12` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.12_x64-setup.exe` | 26.54 MB（27,828,408 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.12.tar.zst` | 78.77 MB（82,595,446 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
809255D9EA4EFB8F62484F9C3F6FAAEDAB6F128CBDE512EB1889869BA38E3501  Harness-CN_0.1.5-rc.12_x64-setup.exe
EC861514ECD91A498ACC6AEE0674F5D037B2704ABC38A3BF1A2545C83B1C5E15  Harness-CN-seed-0.1.5-rc.12.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 修复：应用内更新下载完成后从不生效

**症状**：点「立即更新」，进度条走到 100%，窗口显示「正在启动安装」，随后应用关掉——但重新打开还是旧版本，
更新目录里躺着一个完整的安装程序。rc.9 起一直如此。

**根因**：进程树清理机制与「启动一个必须比应用活得久的外部安装程序」直接冲突。

第一轮改动引入了一个 Windows **job object** 来保证「退出应用时停掉所有 agent 与后台任务」：
它用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 创建，并且**句柄故意永不关闭**，于是 shell 进程一结束，
job 里的一切都被终止。更新器是用 Node 的 `spawn(..., { detached: true })` 启动 NSIS 安装程序的，
但在 Windows 上 `detached` 只设置 `CREATE_NEW_PROCESS_GROUP`——**不会脱离 job**。
结果是：应用在启动安装程序 800 ms 后退出 → job 关闭 → **安装程序在自己的初始化阶段被杀**。

**为什么延长等待时间治不了**：无论等多久，应用最终都要退出，job 一关安装程序就死。

**修复**（三处配合）：

1. `platform.rs`：job 增加 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`，允许特定子进程脱离；
2. 新增 `launchinstaller` 握手：sidecar 把已下载安装程序的路径报给 shell，
   由 **shell 用 `CREATE_BREAKAWAY_FROM_JOB` 启动**它。这个 flag 只能由调用 `CreateProcess` 的一方设置，
   而 Node 的 `spawn` 无法设置它——这就是为什么必须在 Rust 侧启动；
3. `release-channel.ts` / `update-coordinator.ts` / `shell-main.ts`：`install()` 不再自己启动安装程序，
   改为返回已校验的安装程序路径，由 shell 接管启动，随后 sidecar 正常退出。

breakaway 只对**显式请求**它的子进程生效，所以 agent、命令、后台任务依旧留在 job 内，
「退出时全部停掉」的行为没有任何削弱。

**启动失败不再静默**：如果安装程序路径不可用或无法启动，shell 会弹窗说明，并提示安装包仍在下载目录中、可手动运行。

## 本次发布的验证方式

**缺陷复现（本机实测）**

- 机器上装的仍是 rc.10，而更新目录里有完整的 `Harness-CN_0.1.5-rc.11_x64-setup.exe`（27,837,633 字节，
  与已发布资产逐字节一致）——证明下载与 SHA-256 校验都通过了，失败发生在下载之后。
- 手动以相同静默参数运行同一个安装程序：**成功**，退出码 0，耗时 **10.9 秒**，`harness-cn.exe` 正确变为 `0.1.5-rc.11`。
  安装程序本身完全可用。
- 运行日志同样吻合：每次都走完 `desktop update <版本> downloaded (verified)`，
  随后是 `stopping: closing the workspace and every task it started`（正常退出，非崩溃），
  而下次启动仍然报旧版本已安装。

**job object 语义判定**

用一个显式创建 `KILL_ON_JOB_CLOSE` job 的探针测量（关闭 job 的最后一个句柄等同于 shell 进程退出）：

| 子进程 | job 内确认 | 关闭句柄后 |
| --- | --- | --- |
| `cmd.exe`（普通 Windows 进程，与安装程序同类） | `activeProcesses=2` | **被终止** |
| `node.exe` | `activeProcesses=1` | 存活（运行时自身行为，与安装程序无关） |

**修复后验证**

- `pnpm run typecheck`：0 错误。Rust `cargo check --release`：通过。
- 更新相关的 4 个测试文件共 **61 项通过**，其中新增/改写了两项：
  `install()` 返回已校验的安装程序路径而**不**启动它；协调器把该路径交给退出步骤。
- sidecar 产物确认包含 `launchinstaller` / `silentSwitch` 握手，且旧的 `spawnInstaller` 已移除。

**未做**：修复后的应用内完整更新链路（点「立即更新」→ 自动装好并重启）在真实 GUI 里跑通一遍。
本次修复的直接证据是 job 语义的实测与产物内容检查，不是一次端到端的安装会话。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板不出现（本基线未声明 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计不可用（需要基线无法设置的 `ignorable` 标记），检测与拦截不受影响。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
