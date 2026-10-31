# Harness-CN 0.2.1-rc.7

这一版是针对 rc.6 装机后立刻暴露的两个问题出的修正：一是离线包装载后启动直接中止（`dsh-rigorquant` 声明两个补丁文件，打包校验只认单个路径），二是切到 IDE 形态时左列显示"无法读取这个目录"（文件树把工作区根当成空路径去列）。两处都在本版修好，同时补上了点开文件时行号窗口从 0 开始导致的读取失败。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.7_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.7.tar.zst.part1` … `part10`，共 10 个分卷，按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part9',
  'Harness-CN-seed-0.2.1-rc.7.tar.zst.part10',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.7.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.5 的差别

- **新增 IDE／工作站视图切换**：会话标题栏右侧多了一个切换按钮。切到 IDE 形态时，左列换成工作区文件树（逐层展开目录，点文件在中间打开），中列显示文件内容（等宽、带行号，超长文件可继续加载），右列仍是当前的对话；再点一次回到默认布局。切换只改布局，不重建对话，草稿、滚动位置、正在跑的任务都保留
- **修复启动中止**：插件可以在 `dsh.bundle.patch` 里声明一个补丁路径，也可以声明一组；rc.6 的校验只接受前者，遇到 `dsh-rigorquant@0.7.0` 这种两个文件的声明就直接终止启动。现在两种写法都收，每个路径依然要求存在
- **修复 IDE 视图左列空白**：文件树过去以空路径去列工作区根，宿主以 `path is required` 拒绝，于是左列只有一行报错。现在从会话自身的工作目录开始列，子项按绝对路径拼接，中间的文件内容列也同步改成以文件第一行为起点读取（宿主的行窗口从 1 开始编号）
- **修复 `/voice-mode/focus` 的 403**：语音插件在页面挂载时就把当前会话报给宿主，而刚物化完的 profile 里宿主还没打开这个会话，于是每次启动控制台都有一条 `403 (Forbidden)`。现在这条路由遇到"宿主还不认识的会话"不再拒绝，而是丢掉这次焦点声明并照常返回 200；语音启动那条 403 保持原样
- **修复"双击桌面图标没反应"**：启动遇到致命错误时，退出请求会被 launch guard 取消，于是一个没有窗口的进程一直留着并占住单实例互斥量，之后每次双击只是唤醒这个空壳。现在致命错误和"重启"两条路径都先把退出标志置位再退出
- **离线包分卷命名与读取契约统一**：`split-offline-package.mjs` 直接产出 `part<N>`，与首次启动读取分卷的正则一致
- **打包链固化三项设置**：`build-harness-cn-tauri.ps1` 自己注入 `DSH_CLIENT_COMMIT_HASH` / `DSH_CLIENT_VERSION`（无 `.git` 的构建树也能构建，可用 `-CommitHash` 覆盖）、把 `TEMP` / `TMP` 指到可写目录，并在 WiX 链接失败时用 `light.exe -sval` 自动重链 MSI
- 其余与 rc.5 相同：底座 `deepseek-harness 0.2.1-rc.4`、账号页交还上游、五个仓库插件与 `dsh-remote-ssh-ops` 仍随离线包携带本地 `.tgz`

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响
- `dsh-meme` 在"恢复插件"时会报 `ERR_PNPM_NO_OFFLINE_META`（离线镜像里没有它的元数据），不影响启动，下一版随插件归档一起修
- `dsh-plugin-rea` 期望 `data\plugins\rea-bundle\bin\rea-shim.mjs`，该目录目前为空，日志里每 30 秒一条 `MODULE_NOT_FOUND`，功能未受影响
- 离线包体积仍在 600 MB 量级，展开后 `store-archives` 比 rc.4 翻倍，原因尚未定位；seed 自带的 `pnpm install --prod --frozen-lockfile` 是通过的
- rc.6 已从发布页撤下：它的离线包在全新安装上无法启动，请直接用本版

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.7-manifest.json`（发布资产名一致）。
