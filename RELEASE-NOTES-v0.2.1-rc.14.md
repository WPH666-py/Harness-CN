# Harness-CN 0.2.1-rc.14

## 安装

1. 运行 `Harness-CN_0.2.1-rc.14_x64-setup.exe`（覆盖安装可用 `Harness-CN_0.2.1-rc.14_x64_zh-CN.msi`）。
2. 首次启动需要离线包。从本页下载这 9 个分卷，按顺序拼成一个文件后放进 `data\desktop\seed\downloads`：

```powershell
$parts = Get-ChildItem 'Harness-CN-seed-0.2.1-rc.14.tar.zst.part*' | Sort-Object { [int]($_.Name -replace '^.*\.part', '') }
$out = [IO.File]::Create((Join-Path $PWD 'Harness-CN-seed-0.2.1-rc.14.tar.zst'))
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Dispose() }
$out.Dispose()
```

3. 启动后第一次会解包内置运行时（约 5–10 分钟），之后启动约 15 秒。

## 与 0.2.1-rc.13 的差别

- **非 UTF-8 / 二进制文件现在能打开了**。之前文本读取接口只接受 UTF-8，遇到别的编码就报「is not UTF-8 text」。现在读取失败会回落到字节读取：先看 BOM（UTF-8 / UTF-16LE / UTF-16BE），再严格按 UTF-8 解，再退到 GB18030；都不成立或含 NUL 字节的文件按二进制处理，显示「二进制文件，无法以文本方式预览」和文件大小，不再是报错。非 UTF-8 编码解出来的内容以只读方式打开（保存会把编码改掉，所以给的是「以 GB18030 显示，只读」这样的提示）。
- **编辑器带行号和当前行高亮**：左侧行号栏与正文同字号、同行高，随垂直滚动联动、不随水平滚动；光标所在行有淡蓝色背景带（沿用主题 token 的半透明混色），点击、方向键、选区变化都会跟着走。
- **长行不再折行**：`wrap="off"` + 横向滚动条，行号栏固定在左侧；代码多、单行长的文件可以左右拖动查看。
- **IDE 布局的三条分栏线改实了**：文件树与编辑区、编辑区与 AI 回答之间现在是 1px 的实线（主文字色），不再是半像素发丝线；拖动分隔线仍然可用。
- **课程助手面板有关闭按钮了**：之前它只调 `selectPanel('course-assistant')` 打开、没有反向入口，装好后就得靠切换会话才能退出。现在标题栏右侧多了一个「×」，点击回到对话。
- rc.13 的全部内容保留：REA 运行时自动准备、「课程助手面板」单行胶囊、可编辑标签页（Ctrl+S 保存、× 关闭并保存）、图片预览、左下角余额、沙箱写入按会话工作区判定。

## 已知

- 3 个插件条目仍是 pending 状态（上游未发布正式包）。
- `sharp` 的安装脚本被 pnpm 忽略（构建期警告，不影响运行）。
- `dsh-meme` 恢复时会报 `ERR_PNPM_NO_OFFLINE_META`，之后会回落到内置包，功能正常。
- 二进制预览只给结论和大小，没有十六进制视图；超过 32 MB 的非 UTF-8 文件按字节读取上限截断，界面暂不提示截断。
- UTF-8 BOM 的文件保持可编辑，但保存后不再写 BOM。
- REA 的 IDA / Hopper / Kuna 需要用户自备，准备完成后 `rea-shim --shim-status` 仍会列出为 unmet。
- 离线包约 560–600 MB（`store-archives` 体积偏大，仍在排查）。
- Gitee 附件配额有限，只保留最近两版发布页。

## 校验

`publish-0.2.1-rc.14-manifest.json` 里是本页每个附件的字节数与 SHA-256；分卷按名字里的序号拼回后，整包哈希应与其中的 `Harness-CN-seed-0.2.1-rc.14.tar.zst` 一致。
