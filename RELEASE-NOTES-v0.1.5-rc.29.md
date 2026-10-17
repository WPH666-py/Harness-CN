# Harness-CN 0.1.5-rc.29

这一版修好桌面版「账号与余额」里的**登录**：rc.28 里点它没有任何反应。

## 修复

### 1. 账号登录点了没反应（本次主修）

账号面板是完整的：Host 侧有平台 PKCE 登录、控制器与 `remote.account` 命名空间，界面也有「登录」控件。但面板插件在**自己的 `apply` 里挂载** `remote.account`，随后又经由注入的 `ctx.remote` 投影把它读回；Cordis 对带点号的服务名要求 `inject` 声明，而自挂载插件无法声明自己提供的服务（会等待自己而死锁）。于是每次账号调用都抛 `cannot get property "remote.account" without inject`：状态流失败、面板停在「登录后查看」，`signIn()` 在解析命名空间前就置位 `busy`，把「登录」永久留在禁用态。

改法：

- 从注册表读取自己挂载的服务（`ctx.get('remote.account')`），缺失时抛有名字的错误；
- `signIn()` / `cancelSignIn()` / `signOut()` 在解析失败时恢复 `busy` 并置 `failed`，本地失败渲染失败分支而不是卡住整行；
- 测试脚手架改为由 `ctx.get` 提供假命名空间，并新增「命名空间缺失」回归用例（断言 `busy: false`、`failed: true`、未发出任何 Remote 调用）；本包 95 个用例全部通过。

### 2. 浏览器授权完成后登录仍然失败（凭证提交接缝）

命名空间修好后，登录能一路走到浏览器：平台页打开、回调回到本机、`auth_init` 与 `auth_exchange` 都是 `200 (code: 0)`。但 Host 紧接着打出 `[deepseek-account] sign-in failed { errorCode: 'storage' }`，面板回到未登录，凭证库里只多了一条 `deepseek-account-platform/device`，授权本身该写的 `deepseek-account-platform/default` 没有出现。

原因是版本错配：桌面种子从 npm 装的 `@deepseek-ai/dsh-deepseek-account-platform@0.1.7-rc.2` 通过 `session.commit(record)` 提交授权，而运行时自带的 `@deepseek-ai/dsh-authorization@0.1.5-rc.29` 的 `AuthorizationSession` 只有 `method`/`signal`/`notify`/`prompt` 四个成员，没有 `commit`。平台包的**每一个**已发布版本都调用 `session.commit`，所以只能由运行时补上这个成员。

改法（对上游 `origin/master` 的前向移植，见 Agent Note `2026-10-17-authorization-session-commit`）：

- `AuthorizationSession.commit(record)` 经 `ctx.credentials.modifyRecord(flow.key, …)` 写记录，尝试已结束或已撤回时抛 `CANCELLED`；
- `InFlight.committing` 让 `cancel()` 与调用方撤回在写入进行时等待存储写完，而不是把写拆成两半；
- 保留本仓库对 `INVARIANT` 码监听器异常的重抛；
- 新增两个用例（会话提交以 `authorized` 结算并落库；撤回后再提交被拒绝且不写入）。

### 3. 沿用 rc.28 的修复

- `@anionex/dsh-vision-toolkit` 默认不激活（仍安装），启动不再弹它的 pending 提示；
- 账号设置行的 `$mount` 返回值现在被正确卸载（rc.27 首启挂载泄漏）；
- NSIS 离线分卷工具的写缓冲竞态（分卷字节与清单摘要不一致）；
- `tauri.conf.json` 在 rc.28 版本提升中被写坏的 `shortDescription`（非法 UTF-8 导致外壳构建失败）。

## 验证

- 本机安装 rc.28 后复现：设置 → 账号与余额，「登录」不可用、日志无任何 `[deepseek-account]` 记录；
- 源码修复后热替换进安装副本：点击「登录」即产生 `POST /auth-api/v0/dsh/auth_init → 200 (code: 0)`，面板切到「请在浏览器中继续」，并给出平台授权地址（在 Edge 打开）；
- `pnpm exec vitest run packages/client/ui-settings-account-harness` → 95 passed；`tsc -b tsconfig.client.json` 通过；Agent Note 342 篇格式与分类校验通过、中英配对已记录。
- `pnpm exec vitest run packages/credentials/authorization/tests` → 32 passed（含新增的两个提交接缝用例）；`tsc -b tsconfig.host.json` 通过；Agent Note 343 篇格式与分类校验通过、中英配对已记录。
- 端到端复验（rc.29 官方安装包，本机静默安装后启动）：点「登录」→ 面板切到「请在浏览器中继续」→ 浏览器完成授权 → 面板变为「已登录 DeepSeek · 励志的王某人 / 充值余额 ¥186.47 / 赠金余额 ¥186.47」，凭证库新增 `deepseek-account-platform/default`，Host 侧 `get_unnotified_bonuses`、`users/current`、`get_user_summary` 全部 `200 (code: 0)`（rc.28 上同一步报 `storage`）。

## 安装包校验和

- `Harness-CN_0.1.5-rc.29_x64-setup.exe` — 安装包（Windows x64，NSIS，Authenticode 签名：`水哥`），28 932 792 字节，SHA-256 `AE0FC162FCF5A8D4F85C5341D3B0B8C07D2BD98FAFFBAFC0C2EF443823B8DE66`
- `Harness-CN-seed-0.1.5-rc.29.tar.zst` — 离线种子整包（GitHub 资产），127 968 852 字节，SHA-256 `d846295d8b14e00604fdfbd3a0e4399f16f30298a9b1b1752dcb11a5f709b9ba`
- Gitee 分卷 `Harness-CN-seed-0.1.5-rc.29.tar.zst.part1of2`（67 108 864 字节，SHA-256 `a1f9f6b13a169edad1550dfbe1ddf392fd7369f015d90a56de60a0d207937285`）/ `.part2of2`（60 859 988 字节，SHA-256 `a09d1622735a14f4cdd8cf680af514c9a104a1f50d555537c61b87ecb1cdf585`）与 `parts.txt`

下载分卷后按 `parts.txt` 顺序拼接即可还原整包（`copy /b part1of2+part2of2 seed.tar.zst`），拼接结果应与整包 SHA-256 一致。
