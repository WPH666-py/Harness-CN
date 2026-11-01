# Harness-CN 0.2.1-rc.13

## 安装

1. 运行 `Harness-CN_0.2.1-rc.13_x64-setup.exe`（覆盖安装可用 `Harness-CN_0.2.1-rc.13_x64_zh-CN.msi`）。
2. 首次启动需要离线包。从本页下载这 9 个分卷，按顺序拼成一个文件后放进 `data\desktop\seed\downloads`：

```powershell
$parts = Get-ChildItem 'Harness-CN-seed-0.2.1-rc.13.tar.zst.part*' | Sort-Object { [int]($_.Name -replace '^.*\.part', '') }
$out = [IO.File]::Create((Join-Path $PWD 'Harness-CN-seed-0.2.1-rc.13.tar.zst'))
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Dispose() }
$out.Dispose()
```

3. 启动后第一次会解包内置运行时（约 5–10 分钟），之后启动约 15 秒。

## 与 0.2.1-rc.11 的差别

- **REA 插件不再需要手动跑 `setup.mjs`**。之前插件卡在「还要跑一次 setup」，因为 `data\plugins\rea-bundle` 里没有运行时，它的 MCP 行每 30 秒重试一个不存在的 `bin\rea-shim.mjs`。现在启动过程会在后台自己跑一次准备（首次约 800 MB：Node、JDK、Ghidra、apktool、jadx-headless-mcp、rea-agents，可断点续跑），完成后建议重启一次，`mcp-rea` 就接上了。日志里能看到 `REA bundle: provisioning started` / `finished`，已就绪时是 `REA bundle: ready`。
- **「课程助手面板」按钮不再折行**：rc.11 里它被挤成两行（“课程助手面 / 板”），现在固定单行，圆角药丸样式不变。
- rc.11 的全部内容保留：IDE/工作站双布局与可拖动分栏、文件标签页编辑（Ctrl+S 保存、× 关闭并保存、最多 8 个标签）、图片预览、左下角余额、写操作按会话工作区判定（回归测试覆盖）、两个被移除的插件（vscode-mode / Research Graph）。

## 已知

- 3 个插件条目仍是 pending 状态（上游未发布正式包）。
- `sharp` 的安装脚本被 pnpm 忽略（构建期警告，不影响运行）。
- `dsh-meme` 恢复时会报 `ERR_PNPM_NO_OFFLINE_META`，之后会回落到内置包，功能正常。
- REA 的 IDA / Hopper / Kuna 需要用户自备（插件本来就不下载它们），准备完成后 `rea-shim --shim-status` 仍会列这几项为 unmet。
- 离线包约 560–600 MB（`store-archives` 体积偏大，仍在排查）。
- 文件写入是无条件的（没有乐观锁）：同时用外部编辑器改同一个文件时以最后一次保存为准。
- Gitee 附件配额有限，只保留最近两版发布页。

## 校验

`publish-0.2.1-rc.13-manifest.json` 里是本页每个附件的字节数与 SHA-256；分卷按名字里的序号拼回后，整包哈希应与其中的 `Harness-CN-seed-0.2.1-rc.13.tar.zst` 一致。
