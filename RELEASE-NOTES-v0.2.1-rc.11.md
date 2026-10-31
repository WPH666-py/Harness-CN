# Harness-CN 0.2.1-rc.11

## 安装

1. 运行 `Harness-CN_0.2.1-rc.11_x64-setup.exe`（覆盖安装可用 `Harness-CN_0.2.1-rc.11_x64_zh-CN.msi`）。
2. 首次启动需要离线包。从本页下载这 9 个分卷，按顺序拼成一个文件后放进 `data\desktop\seed\downloads`：

```powershell
$parts = Get-ChildItem 'Harness-CN-seed-0.2.1-rc.11.tar.zst.part*' | Sort-Object { [int]($_.Name -replace '^.*\.part', '') }
$out = [IO.File]::Create((Join-Path $PWD 'Harness-CN-seed-0.2.1-rc.11.tar.zst'))
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Dispose() }
$out.Dispose()
```

3. 启动后第一次会解包内置运行时（约 5–10 分钟），之后启动约 15 秒。

## 与 0.2.1-rc.10 的差别

- **IDE（工作站）模式现在是真正的编辑器**：可以同时打开多个文件（最多 8 个标签），文本文件左列点开就在中间编辑，`Ctrl+S` 保存，点标签上的 × 关闭并保存；打开图片会直接预览，不再报 “is not UTF-8 text”。新标签会挤掉最早一个没有改动过的标签，有未保存内容时不会被挤掉。
- **修好了写入被沙箱拦住的问题**：以前所有写操作（新建、复制、移动、删除、保存）都没有带上会话自己的沙箱策略，桌面端的兜底根目录是 profile 目录，所以对工作区文件的写入会被拒绝（表现就是“保存失败：… file access denied under workspace-write mode”）。现在每个写操作都按会话工作区根目录判定，配套加了一个回归测试。
- **「课程助手」按钮改成单一药丸按钮**：原来左边是 `🎓 课程助手` 文字、右边是 `打开面板 →` 链接，看着像坏掉的样式；现在只有一个 `课程助手面板` 按钮，样式直接写在元素上，不再依赖插件自己的 CSS。
- rc.10 的改动全部保留：标签页、图片预览、左下角余额、两种布局都可拖动的分栏、「IDE/工作站」淡蓝按钮、可调的三栏宽度。

## 已知

- 3 个插件条目仍是 pending 状态（上游未发布正式包）。
- `sharp` 的安装脚本被 pnpm 忽略（构建期警告，不影响运行）。
- `dsh-meme` 恢复时会报 `ERR_PNPM_NO_OFFLINE_META`，之后会回落到内置包，功能正常。
- 日志中每 30 秒一条 `rea-shim` 的 `MODULE_NOT_FOUND`（`data\plugins\rea-bundle` 未生成），属于既有问题，不影响对话。
- 离线包 560–600 MB（`store-archives` 体积偏大，仍在排查）。
- 文件写入是无条件的（没有乐观锁）：同时用外部编辑器改同一个文件时以最后一次保存为准。

## 校验

SHA-256 见发布页的 `publish-0.2.1-rc.11-manifest.json`；9 个分卷按序拼接后的整包哈希与清单里的 `Harness-CN-seed-0.2.1-rc.11.tar.zst` 一致。
