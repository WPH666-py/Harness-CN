# Harness-CN 0.2.1-rc.8

这一版收的是 rc.7 发布后你点出来的几件事：三栏宽度没法自己调、切到 IDE 形态后左下角看不到余额、切换按钮太不显眼、一直停在"重新连接中"、以及要删掉 VSCodeMode 和 Research Graph 两个插件。

其中"一直重连"查下来是两件事叠在一起：`dsh-vscode-mode` 每秒往 `/edrv/rpc` 打约 9 次请求，把页面的连接池（同源 6 条）占满，宿主那边的流通道因此握不上手；而重连循环又有一个死结——上一个连接的收尾如果卡住（资源耗尽下正是如此），循环就一直等它，不会开始下一次尝试，界面上的"连接中"于是永不变化。两处都修了。

## 安装

- 安装包：`Harness-CN_0.2.1-rc.8_x64-setup.exe`（NSIS）或 `.msi`
- 离线包：`Harness-CN-seed-0.2.1-rc.8.tar.zst.part1` … `part9`，共 9 个分卷，按序号依次拼接即可（见下方命令），放进 `data\desktop\seed\downloads\` 后启动会自动解包
- 已有安装可以覆盖升级；数据目录 `data\` 保持不变

```powershell
$parts = @(
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part1',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part2',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part3',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part4',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part5',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part6',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part7',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part8',
  'Harness-CN-seed-0.2.1-rc.8.tar.zst.part9',
)
$out = [IO.File]::Create("$PWD\Harness-CN-seed-0.2.1-rc.8.tar.zst")
try { foreach ($p in $parts) { $in = [IO.File]::OpenRead("$PWD\$p"); try { $in.CopyTo($out) } finally { $in.Dispose() } } } finally { $out.Dispose() }
```

## 与 0.2.1-rc.7 的差别

- **三栏宽度可调**：右侧对话列与 IDE 中间列之间多了一条拖拽边（切到 IDE 形态时出现在工作区文件树与文件内容之间），宽度会被记住；文件树自身也能拖，范围 180–520 px，对话列最小 400 px
- **左下角常驻余额**：新增 `ui-billing-balance`，占住底部一整行，显示今日余额／本月消耗，两种布局下都在；有 `billingMetrics` 服务时跟它走，没有就自己按 `/api/billing/usage-stats` 轮询（页面隐藏时停）
- **切换按钮改成显眼的标签**：从图标换成浅蓝底、带文字的「IDE/工作站」胶囊按钮，`aria-pressed` 与两个方向的提示语都补齐（切过去是"切换到 IDE 布局"，切回来是"回到对话布局"）
- **修复"一直重连"**：`connection` 的循环现在把"上一代连接收尾"和"取消信号"一起竞速，只有在真正取消之后才给 5 秒收尾宽限；曾经忽略取消的连接不会再拖住下一次尝试。`stop()` 也会把状态收在"已断开"，不再留下一个"还在连接"的假状态
- **移除两个插件**：`dsh-vscode-mode`（就是上面那个每秒 9 次请求的元凶）与 `dsh-scifork`（左栏底部的 Research Graph）从随包清单与 seed 里一起去掉，已在旧 profile 里装过的会在就地升级时一并清掉
- 其余修复沿用 rc.7：启动中止（`dsh.bundle.patch` 允许数组）、IDE 左列空白（文件树从会话工作目录起列）、文件内容从第一行读、`/voice-mode/focus` 的 403、"双击桌面图标没反应"、分卷命名契约、打包链三项设置

## 已知

- 3 个插件条目在启动时会 pending（`harness-dev-context` 等 `webApp` 服务、`dsh-connect-qoder` 与 `dsh-email` 等 `settings` 服务），不影响主界面
- `dsh-image-vision` 依赖的 `sharp` 预编译包在 `--prod` 安装时被 pnpm 判定为 ignored build script，仅影响该插件的原生加速，功能不受影响
- `dsh-meme` 在"恢复插件"时会报 `ERR_PNPM_NO_OFFLINE_META`（离线镜像里没有它的元数据），不影响启动
- `dsh-plugin-rea` 期望 `data\plugins\rea-bundle\bin\rea-shim.mjs`，该目录目前为空，日志里每 30 秒一条 `MODULE_NOT_FOUND`，功能未受影响
- 离线包体积仍在 600 MB 量级，展开后 `store-archives` 比 rc.4 翻倍，原因尚未定位；seed 自带的 `pnpm install --prod --frozen-lockfile` 是通过的

## 校验

安装包与分卷的 SHA-256 见同目录 `publish-0.2.1-rc.8-manifest.json`（发布资产名一致）。
