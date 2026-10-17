# Harness-CN 0.1.5-rc.30

这一版只有两处修正，都是 rc.29 发布后从已安装的应用上看到的：登录进行中仍然显示「登录」按钮，以及运行日志窗口会开成空白。没有其他行为改动。

## 修复

### 1. 登录进行中仍然显示「登录」和「取消」

设置 → 账号与余额 点「登录」之后，面板切到「请在浏览器中继续」，但同一行仍摆着 `[登录] [取消] [打开浏览器]`：开始登录的控件和结束这次登录的控件并排出现，而第二次「开始」只会替换掉浏览器正握着的那次尝试，看起来像什么都没发生。

改法：未登录分支只在**没有进行中的尝试**时渲染「登录」；有尝试时渲染「取消」与授权链接。这一行改为可换行而不是溢出，链接补了一点水平内边距和按钮对齐。用例钉住了这个矩阵：相位矩阵断言每个进行中相位都没有「开始」控件，手势用例先在空闲面板点「登录」，再看等待态换成了取消与打开浏览器。

### 2. 运行日志窗口打开是空的

点 运行日志 后窗口里该有的标签都在（来源、暂停、自动滚动到最新、打开日志文件位置、清空），列表却空白，也没有状态行或错误提示；同一时刻从主窗口探测 `/shell-api/logs` 能拿到 207 条。

原因是页面先挂实时流（`subscribeEvents`，一条长连接的 SSE 请求）再去读快照。两者打的是同一个回环源，Chromium 对每个源允许六条连接；应用自己的页面占着几条长连接，内置插件窗口还占一条。流占掉最后一个名额时，快照请求排在它后面，页面停在 `await readSnapshot()`，屏幕上什么都没有 —— 而 `readSnapshot()` 自带重试（4 次、每次 5 秒），所以窗口要空五秒之后才开始解释自己。

改法：先读快照，再挂实时流；`merge()` 本来就按序号丢弃快照已带过的条目，后挂不会漏，也不会重复。窗口自己的注释早从另一面描述过这个失效方式：「没有截止时间时，标签出现了、列表空着，窗口会声称这次运行什么都没记。」

### 3. 沿用 rc.29 的修复

- 账号面板从注册表读取自己挂载的 `remote.account` 命名空间，登录不再「点了没反应」；
- `AuthorizationSession.commit(record)` 前向移植，浏览器授权完成后不再报 `storage` 失败，凭证能落到 `deepseek-account-platform/default`；
- `@anionex/dsh-vision-toolkit` 默认不激活（仍安装）；
- 账号设置行的 `$mount` 返回值被正确卸载；
- NSIS 离线分卷工具的写缓冲竞态、`tauri.conf.json` 的 `shortDescription` 编码问题。

## 验证

- rc.29 上复现两处缺陷：等待态一行含「登录」，运行日志窗口只有外壳、无状态行。
- 开发期热替换验证：点「登录」→「请在浏览器中继续」且 `hasSignIn: false`、按钮只剩「取消」；点「取消」回到空闲面板，「登录」回来；重开 运行日志 → `显示 65 条，内存保留 65 条，已丢弃 0 条。`；同一页面里用 iframe 复现旧顺序，快照请求被 SSE 流挡住，只剩空列表 —— 顺序调整后不再出现。
- **rc.30 产物原样验证**：把安装包里的 `harness-cn.exe` 与 `resources/` 按安装器布局铺到 `%LOCALAPPDATA%\Harness-CN`，启动后用 WebView2 调试端口驱动界面：
  - 设置 → 账号与余额 → 点「登录」→ 面板文案「请在浏览器中继续」，按钮集合只剩 `取消`（`hasSignIn: false`、`hasCancel: true`），链接为 `打开浏览器`；
  - 点「取消」→ 回到空闲面板，`登录` 回来（`hasSignIn: true`、`hasCancel: false`）；
  - 运行日志 → `显示 65 条，内存保留 65 条，已丢弃 0 条。`，列表 65 行，来源下拉「全部来源 / 桌面外壳 / 后端输出 / 后端错误」齐全。
- 发布物内容与上面跑的这份逐字节一致：`resources/shell/log-viewer.js` 的 sha256 = `AB7F2721DF5739435B32A29102B0BC1ABC0BC48164E32FB1AD74C41B5795805B`；离线包内 `deepseek-ai-dsh-client-ui-settings-account-harness-0.1.5-rc.30.tgz` 解出的 `lib/client.js`（194 120 字节）sha256 = `DCAD4685530FA77CC89D341C5ACF6D0220D46514BA3C583822A4D4C4560ED479`，与仓库构建产物一致。
- `pnpm exec vitest run packages/client/ui-settings-account-harness` → 8 个文件 / 95 个用例通过（含新增的相位矩阵断言）；`pnpm run typecheck:contracts-ready` 通过；`oxlint` 对改动文件 0 warnings / 0 errors；Agent Note 344 篇格式与分类校验通过（新增中英配对已提交）。
- 本机安装器的静默安装（`/S`）在当前会话里失败（进程退出码 2、未落盘），因此没有做安装器级 e2e；上面的验证跑的是安装包内同一份 payload，发布物哈希列在下方，可与下载件比对。

## 安装包校验和

GitHub 发布页（安装包 + 完整离线包）：

- `Harness-CN_0.1.5-rc.30_x64-setup.exe` — 28 940 624 字节，sha256 `0E14C82FE10A67A6D80A78DE8DB5E839FCC7F2134A943719D41DD1D2C48CF993`
- `Harness-CN-seed-0.1.5-rc.30.tar.zst` — 127 903 083 字节，sha256 `D85EA8ECE483B890A7BB74174D5FA9628BF497622057642E74B65F45E6DF5F6F`

Gitee 附件（安装包 + 离线包两卷，单附件上限 100 MB）：

- `Harness-CN-seed-0.1.5-rc.30.tar.zst.part1of2` — 67 108 864 字节，sha256 `64C2B006F35C6EDA37FC341BA9380EDA340E9EBF86E2F3B9F519BF9E03D5A117`
- `Harness-CN-seed-0.1.5-rc.30.tar.zst.part2of2` — 60 794 219 字节，sha256 `8D4CADBACF30CE3F877ACC7318CB76B965251AABF917E21BC9858536CF58A2A0`
- `Harness-CN-seed-0.1.5-rc.30.tar.zst.parts.txt` — 分卷清单；两卷按序拼接后应得到上面的完整 sha256
