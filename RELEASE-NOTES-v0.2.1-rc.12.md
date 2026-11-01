# Harness-CN 0.2.1-rc.12

## 安装

1. 运行 `Harness-CN_0.2.1-rc.12_x64-setup.exe`（覆盖安装可用 `Harness-CN_0.2.1-rc.12_x64_zh-CN.msi`）。
2. 首次启动需要离线包。从本页下载这 9 个分卷，按顺序拼成一个文件后放进 `data\desktop\seed\downloads`：

```powershell
$parts = Get-ChildItem 'Harness-CN-seed-0.2.1-rc.12.tar.zst.part*' | Sort-Object { [int]($_.Name -replace '^.*\.part', '') }
$out = [IO.File]::Create((Join-Path $PWD 'Harness-CN-seed-0.2.1-rc.12.tar.zst'))
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Dispose() }
$out.Dispose()
```

3. 启动后第一次会解包内置运行时（约 5–10 分钟），之后启动约 15 秒。

## 与 0.2.1-rc.11 的差别

- **「课程助手面板」按钮不再折行**：rc.11 里这个按钮在底部一行被挤成两行（“课程助手面 / 板”），现在固定单行显示，圆角药丸样式不变。
- rc.11 的全部内容保留：IDE/工作站双布局与可拖动分栏、文件标签页编辑（Ctrl+S 保存、× 关闭并保存、最多 8 个标签）、图片预览、左下角余额、写操作按会话工作区判定（回归测试覆盖）、两个被移除的插件（vscode-mode / Research Graph）。

## 已知

- 3 个插件条目仍是 pending 状态（上游未发布正式包）。
- `sharp` 的安装脚本被 pnpm 忽略（构建期警告，不影响运行）。
- `dsh-meme` 恢复时会报 `ERR_PNPM_NO_OFFLINE_META`，之后会回落到内置包，功能正常。
- 日志中每 30 秒一条 `rea-shim` 的 `MODULE_NOT_FOUND`（`data\plugins\rea-bundle` 未生成），属于既有问题，不影响对话。
- 离线包 560–600 MB（`store-archives` 体积偏大，仍在排查）。
- 文件写入是无条件的（没有乐观锁）：同时用外部编辑器改同一个文件时以最后一次保存为准。
- Gitee 附件配额有限：rc.10 及更早的分卷会在新版本发布后清理，历史版本请到 GitHub 下载。

## 校验

SHA-256 见发布页的 `publish-0.2.1-rc.12-manifest.json`；9 个分卷按序拼接后的整包哈希与清单里的 `Harness-CN-seed-0.2.1-rc.12.tar.zst` 一致。
