# Harness-CN 0.2.1-rc.5

本版把 `ai-courses`、`dsh-scholar-suite`、`dsh-openmaic`、`dsh-image-vision`、`dsh-chem-ui` 五个仓库插件，以及原先从 GitHub 直装的 `dsh-remote-ssh-ops`，全部从"运行时去 npm / GitHub 拉"改成**随离线包携带本地 `.tgz`**：安装完成后第一个启动就能装上，离线机器、没有 npm 账号的机器、上游仓库被删或改名都不影响。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.5_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.5.tar.zst.part1` … `part10`，共 10 个分卷（合计 627,187,442 字节），按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part9',
  'Harness-CN-seed-0.2.1-rc.5.tar.zst.part10',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.5.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.4 的差别

- **五个仓库插件改为本地归档安装**：插件清单里这五项改成 `file:plugins/<name>-<version>.tgz`，归档随离线包放在 `seed\plugins\`，首次启动时随 seed 一起展开到 profile 目录，`pnpm` 用本地文件解析，不再联网
- **`dsh-remote-ssh-ops` 也改为本地归档**：它原本是清单里唯一的 `github:weisiren000/dsh-remote-ssh-ops#main` 直装项，上游仓库现在已经 404，导致整个 seed 安装直接失败（`ERR_PNPM_FETCH_404`）。这里把最后可用的 0.1.0 版本（commit `1f2ee065`）打成 `plugins\dsh-remote-ssh-ops-0.1.0.tgz` 一起带走，插件本身的行为不变
- **profile 自带归档**：`copyMetadata` 现在把 `plugins/` 一起复制进 profile，后续任何插件的启用/停用/恢复都不会因为找不到 `.tgz` 而失败
- **仓库可复现**：六个 `.tgz` 提交进仓库（`apps/desktop-shell/src-tauri/resources/plugins/`），`prepare-seed` 会把它们打进 seed，别人 clone 后能原样构建出同样的离线包
- 其余与 rc.4 相同：底座 `deepseek-harness 0.2.1-rc.4`、热启动约 12 s、账号页交还上游

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- 打包链仍需三项手工设置：注入 `DSH_CLIENT_COMMIT_HASH` / `DSH_CLIENT_VERSION`（无 `.git` 的构建树里 `git rev-parse` 不可用），把 `TEMP` 指向可写目录（`%LOCALAPPDATA%\Temp` 下 esbuild 删除临时文件偶发 `Access is denied`，会整段 Web 构建失败），以及 MSI 链接时给 `light.exe` 加 `-sval`（构建环境里 Windows Installer 服务不可访问，ICE 校验以 `LGHT0217` 失败；`-sval` 只跳过校验，产物不变）。下一轮会固化进构建脚本
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.5-manifest.json`（发布资产名一致）。
