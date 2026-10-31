# Harness-CN 0.2.1-rc.10

rc.9 的 IDE/工作站只能看不能改：点开文件是一段只读文本，点图片直接报 `is not UTF-8 text`，而且关掉就没了。根因在底座——`workspaceFiles` 这套 Remote 接口只有读和结构性变更（建目录、建文件、改名、复制、删除），根本没有"写回文件内容"这个动作，所以前端再想保存也没有可调的接口。这一版补上了这个动作，并把工作站改成真正的多标签编辑器，顺带把底部那个`🎓 课程助手` + `打开面板 →` 两截式的按钮收成一个。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.10_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.10.tar.zst.part1` … `part9`，共 9 个分卷，按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.10.tar.zst.part9',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.10.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.9 的差别

- **能改文件了**：新增 host 侧 `workspaceFiles.write(sessionId, path, text)`——路径解析与权限和 `read` 完全一致（工作区内外的已有文件都能写），带 NUL 字节与 `maxFileBytes` 门禁，原子替换并发出变更事件，所以外部工具和变更面板都能看到
- **多标签编辑**：工作区文件点开进标签，最多 8 个（超出时先关最旧的干净标签，全是脏的就保留不丢）；文本框支持 Tab 缩进两格、不做自动格式化
- **关闭即保存**：`Ctrl/Cmd+S` 保存当前标签；点标签上的 `×` 会先保存再关闭——失败则标签留着，并在标签状态行显示原因
- **整文件读写**：打开时把整个文件按页读完再进入编辑，保存是全量写回，不会出现"只存了第一页"这种截断
- **图片直接预览**：`png/jpg/jpeg/gif/webp/bmp/ico/avif` 走 `readBytes` 渲染预览并显示文件大小，不再当作文本报错
- **课程助手按钮**：`🎓 课程助手` + `打开面板 →` 两截改成单一胶囊「课程助手面板」，带边框与悬停底色；该插件是随包预构建的，所以通过 seed 补丁脚本落地，重装也保持
- 其余全部沿用 rc.9：左下角余额芯片（默认布局与 IDE 布局都在）、三栏与文件树可拖拽、浅蓝底「IDE/工作站」胶囊、重连循环收尾竞速修复、两个插件移除，以及 rc.7/rc.8 的既有修复

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响
- `dsh-meme` 在"恢复插件"时会报 `ERR_PNPM_NO_OFFLINE_META`（离线镜像里没有它的元数据），不影响启动
- `dsh-plugin-rea` 期望 `data\plugins\rea-bundle\bin\rea-shim.mjs`，该目录目前为空，日志里每 30 秒一条 `MODULE_NOT_FOUND`，功能未受影响
- 离线包体积仍在 550–600 MB 量级，展开后 `store-archives` 比 rc.4 翻倍，原因尚未定位；seed 自带的 `pnpm install --prod --frozen-lockfile` 是通过的
- 写入是无条件的（没有"版本不符先提示"的乐观锁）；两个窗口同时改同一个文件时以后保存的为准

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.10-manifest.json`（发布资产名一致）。
