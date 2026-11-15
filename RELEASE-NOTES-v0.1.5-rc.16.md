# Harness-CN 0.1.5-rc.16（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版为补丁：**修复「点击桌面图标没反应」**——已有一个实例在运行时，新的启动请求找不到窗口就直接退出。

> **关于版本号**：本发行版的 `0.1.5-rc.16` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.16_x64-setup.exe` | 27.46 MB（28,795,846 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.16.tar.zst` | 78.77 MB（82,595,283 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
97C5EB88EAAA740C0B1F7002E3524129191D3FCDD643B913BAFC10A1A589E072  Harness-CN_0.1.5-rc.16_x64-setup.exe
967EC04589373D32847663FB477C50F2F6DF2AA9C474FAA90E20D604ADF7DB84  Harness-CN-seed-0.1.5-rc.16.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 修复：点击桌面图标没有反应

**现象**：应用已经在运行（或残留了一个进程）时，双击桌面 `Harness-CN` 图标毫无反应，任务栏也不出现窗口。

**原因**：单实例仲裁按**窗口标题**找回正在运行的实例：

```rust
FindWindowW(NULL, "Harness-CN")   // 只按标题精确匹配
if window.is_null() { return; }   // 找不到就静默返回
```

问题是这个标题**不稳定**。工作区窗口渲染的是 Host 提供的网页，WebView2 会在页面加载后把窗口标题
同步成页面的 `<title>`（本产品的前端是 `DeepSeek Harness`），于是 Rust 建窗时写的 `"Harness-CN"`
被覆盖掉。此后再启动就匹配不到窗口，`focus_running_instance` 静默返回，而新进程已经判定
「已有实例」并退出——用户看到的就是「点了没反应」。

**修复**：改为按**进程归属**找回窗口，不再依赖标题。用 `EnumWindows` 枚举顶层窗口，取
`GetWindowThreadProcessId` 等于自身进程 ID、且可见的那个窗口，然后 `ShowWindow(SW_RESTORE)` +
`SetForegroundWindow` 把它带出来。窗口标题改由前端控制，与身份识别解耦。

保留按标题的查找作为**回退**：如果运行中的是比本版更旧的实例（其窗口由旧代码创建），
仍然尝试用 `"Harness-CN"` 找到它。

### 其余内容与 rc.15 相同

- 首次启动遇到「软件包仓库不完整」时自动重新展开并重试一次（rc.15）。
- 更新链路修复：安装程序由 shell 以 `CREATE_BREAKAWAY_FROM_JOB` 启动（rc.12）。
- 只读的**内置插件**页、**作者信息** / **休闲食品商城**（9 个商品）/ **评价与反馈** 三项菜单。

## 本次发布的验证方式

- 现场诊断（本机实测）：枚举运行中实例的顶层窗口，确认**只有 1 个可见顶层窗口且标题为空**，
  而 `FindWindowW(NULL, "Harness-CN")` 因此匹配失败；同时确认该实例的 sidecar 仍正常服务
  （端口在监听、四个页面均返回 200），即应用并没死，只是无法被找回。
- Rust `cargo check --release`：通过（含新增的 `EnumWindows` / `GetWindowThreadProcessId` 调用）。
- 完整流程重跑：`build:official` → `release:pack` → `pack desktop-host` → `prepare:packages` →
  `prepare:seed` → `prepare:shell` → `tauri build`。

**未做**：装好本版后，在真实场景里验证「第二个实例能把已有窗口带到前台」。这需要两次启动的
人机交互（先开着应用，再双击图标），无法在脚本里可靠复现。窗口枚举逻辑本身已随构建通过编译。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板不出现（本基线未声明 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计不可用（需要基线无法设置的 `ignorable` 标记），检测与拦截不受影响。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
