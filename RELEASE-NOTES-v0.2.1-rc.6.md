# Harness-CN 0.2.1-rc.6

本版把界面做成两种形态：默认还是 Harness 现在的对话布局，点一下会话标题栏的切换按钮，整页变成 Trae 那样的 IDE 形态——左边工作区文件树、中间打开的文件、右边照旧是 AI 对话；再点一下切回来，两边互不影响。同时修掉三项先前遗留的问题：`/voice-mode/focus` 的 403、致命错误后进程不退导致的"双击图标没反应"、以及打包链里三处只能手工设置的开关。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.6_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.6.tar.zst.part1` … `part10`，共 10 个分卷，按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part9',
  'Harness-CN-seed-0.2.1-rc.6.tar.zst.part10',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.6.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.5 的差别

- **新增 IDE／工作站视图切换**：会话标题栏右侧多了一个切换按钮。切到 IDE 形态时，左列换成工作区文件树（逐层展开目录，点文件在中间打开），中列显示文件内容（等宽、带行号，超长文件可继续加载），右列仍是当前的对话；再点一次回到默认布局。切换只改布局，不重建对话，草稿、滚动位置、正在跑的任务都保留
- **修复 `/voice-mode/focus` 的 403**：语音插件在页面挂载时就把当前会话报给宿主，而刚物化完的 profile 里宿主还没打开这个会话，于是每次启动控制台都有一条 `403 (Forbidden)`。现在这条路由遇到"宿主还不认识的会话"不再拒绝，而是丢掉这次焦点声明并照常返回 200（未知会话本来也接收不到朗读，页面下一次切换会话或切回前台会重新上报）；语音启动那条 403 保持原样，那里拒绝是对的
- **修复"双击桌面图标没反应"**：启动过程里遇到致命错误时，退出请求会被 launch guard 取消（它判定"sidecar 还活着且没有工作区窗口"就阻止退出），于是一个没有窗口的进程一直留着并占住单实例互斥量，之后每次双击只是唤醒这个空壳。现在致命错误和"重启"两条路径都先把退出标志置位再退出
- **离线包分卷命名与读取契约统一**：`split-offline-package.mjs` 现在直接产出 `part<N>`（不带 `of<count>`），与首次启动读取分卷的正则一致；rc.5 的命名是发布之后单独修过的，本版从源头就对
- **打包链固化三项设置**：`build-harness-cn-tauri.ps1` 自己注入 `DSH_CLIENT_COMMIT_HASH` / `DSH_CLIENT_VERSION`（无 `.git` 的构建树也能构建，可用 `-CommitHash` 覆盖）、把 `TEMP` / `TMP` 指到可写目录，并在 WiX 链接失败时用 `light.exe -sval` 自动重链 MSI，不再需要人工补刀
- 其余与 rc.5 相同：底座 `deepseek-harness 0.2.1-rc.4`、账号页交还上游、五个仓库插件与 `dsh-remote-ssh-ops` 仍随离线包携带本地 `.tgz`

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响
- `dsh-meme` 在"恢复插件"时会报 `ERR_PNPM_NO_OFFLINE_META`（离线镜像里没有它的元数据），不影响启动，下一版随插件归档一起修
- `dsh-plugin-rea` 期望 `data\plugins\rea-bundle\bin\rea-shim.mjs`，该目录目前为空，日志里每 30 秒一条 `MODULE_NOT_FOUND`，功能未受影响
- 离线包体积从 rc.4 的 372 MB 涨到约 600 MB，展开后 `store-archives` 翻倍，原因尚未定位；seed 自带的 `pnpm install --prod --frozen-lockfile` 是通过的

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.6-manifest.json`（发布资产名一致）。
