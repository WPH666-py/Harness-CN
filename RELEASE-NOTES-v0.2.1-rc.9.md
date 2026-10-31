# Harness-CN 0.2.1-rc.9

rc.8 装到真机上后，左下角的余额位置对了，但数字是空的——芯片去读 `/api/billing/usage-stats`，那条路由返回的是聚合用量对象（`total.cost` 与 `byModel`），不是逐个 provider 的余额数组，所以一行都解析不出来，干脆不渲染。真正的余额在 `/api/billing/balance` 的 `balances` 里（`provider` / `totalBalance` / `currency`，未配置的 provider 带 `error`）。这一版就是修这件事，其余与 rc.8 相同。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.9_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.9.tar.zst.part1` … `part9`，共 9 个分卷，按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.9.tar.zst.part9',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.9.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.8 的差别

- **余额芯片读到真实余额**：先请求 `/api/billing/balance`，从 `balances` 里取第一个既没有 `error` 又有 `totalBalance` 的 provider（当前是 `DeepSeek ¥106.43`）；那条路由不可用（旧版插件）时回落到 `/api/billing/usage-stats`，两种返回形状都能解析
- 芯片位置不变：仍在底部整行的最左侧，默认布局与 IDE 布局下都在（rc.8 引入的 `ui-billing-balance` 座位）
- 其余全部沿用 rc.8：三栏可拖拽、文件树自身可拖（180–520 px）、浅蓝底「IDE/工作站」胶囊按钮、重连循环的收尾竞速修复、`dsh-vscode-mode` 与 `dsh-scifork` 两个插件移除，以及 rc.7 的一批修复（启动中止、IDE 左列空白、文件从第一行读、`/voice-mode/focus` 403、双击无反应、分卷命名契约、打包链三项设置）

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响
- `dsh-meme` 在"恢复插件"时会报 `ERR_PNPM_NO_OFFLINE_META`（离线镜像里没有它的元数据），不影响启动
- `dsh-plugin-rea` 期望 `data\plugins\rea-bundle\bin\rea-shim.mjs`，该目录目前为空，日志里每 30 秒一条 `MODULE_NOT_FOUND`，功能未受影响
- 离线包体积仍在 550–600 MB 量级，展开后 `store-archives` 比 rc.4 翻倍，原因尚未定位；seed 自带的 `pnpm install --prod --frozen-lockfile` 是通过的

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.9-manifest.json`（发布资产名一致）。
