# Harness-CN 0.1.5-rc.19（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版解决的不是某个功能坏了，而是**这台机器上能不能用**的问题：插件装不上、更新默默失败、失败原因看不见。

> **关于版本号**：`0.1.5-rc.19` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.19_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.19.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、插件安装不再无视用户的镜像与代理

**问题**：`project-manager.ts` 把 registry 写死成 `https://registry.npmjs.org/`，并且把 `NPM_CONFIG_USERCONFIG` 指向一个空文件——**用户自己的 `.npmrc` 被忽略**。国内配了 npm 镜像、或必须走代理的机器，装插件会失败，而且失败原因只是干巴巴的网络错误。

**修复**（`apps/desktop/src/project-manager.ts`）：

- 读 `npm_config_registry` / `NPM_CONFIG_REGISTRY`（两种拼写都认），机器说了就用机器的；只有在机器没说时才回退 `https://registry.npmjs.org/`。
- 只有在**使用我们回退值**时才传 `--config.registry`，否则会覆盖掉用户的选择；同理只在用户没指定 npmrc 时才传 `--config.userconfig`。
- 尊重 `npm_config_userconfig` / `NPM_CONFIG_USERCONFIG` 指定的配置文件。
- registry 值必须是「origin」：带路径、带账号密码、带查询串、或非 HTTP(S) 协议一律**拒绝并回退**，不做猜测。
- 代理：检测到 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 时给 pnpm 子进程加 `NODE_USE_ENV_PROXY=1`（Node 默认**不**读这些变量，这正是代理机器失败的原因）；`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 原样传给子进程，私有 registry 的自签 CA 因此可用。
- 运行日志会记下这次安装用的是代理还是证书文件，出问题时看得见。

### 二、自动更新失败不再无声无息

**问题**：自动检查在首启 10 秒后跑一次、之后每 6 小时一次。**失败时它只更新一个没人看的内部状态**——不弹窗、日志里也不写。两个发布源都不可达的机器会安静地停在旧版本上，用户永远不知道。

**修复**：

- 失败原因写进运行日志（`release check failed: …`）。
- 外壳收到 `error` 状态时，把菜单里的「检查更新」标成 **「检查更新 [!]」**；检查成功或已是最新时恢复。
- 点这个菜单项时，**先弹窗说明上次失败的原因**，再发起新的检查。
- 手动检查失败的弹窗会在错误像网络问题时追加一句可执行建议（需要访问 gitee.com 或 api.github.com；走代理请设 `HTTPS_PROXY`；也可以直接从发布页手动更新），并说明这条建议针对的是传输失败而不是「发布本身有问题」。

### 三、把发布链路从某台机器搬进 CI

**问题**：发布脚本写死了 `D:\projects-py\git-portable\cmd`、`D:\projects-py\Harness-CN\pnpm-11.7.0`、`D:\conda\python.exe`，token 还散落在 `_probe` 的临时脚本里。换个人或换台机器就发不了版，而**已经装上的用户不会有任何提示**。

**修复**：

- 新增 `.github/workflows/harness-cn-release.yml`：`windows-2022` + `windows-2022` 两个 job，打 tag 或手动 dispatch 触发；`publish` 输入默认 **false**，所以第一次跑只验证打包、不碰发布源；打包产物始终作为 workflow artifact 留存。
- 新增 `scripts/release/publish-harness-cn.mjs` 与 `scripts/release/verify-harness-cn-release.mjs`：仓库自己持有发布与校验逻辑，仓库名从环境变量读（默认仍是那两个），凭据只从 Secrets 取。
- 校验脚本会把两个文件**从两个源重新下载回来**比对本地字节（Gitee 不做字节校验、GitHub 的 CDN 与 API 是不同主机，两者都需要覆盖），不一致直接让 job 失败。

需要配置的 Secrets：`GH_TOKEN`、`GITEE_TOKEN`（可选变量 `HARNESS_CN_GITHUB_REPOSITORY` / `HARNESS_CN_GITEE_REPOSITORY`）。

## 本次发布的验证方式

- `vitest run apps/desktop/tests/registry-settings.spec.ts`：6 项通过（默认值、两种拼写、六种非法值拒绝、npmrc 路径、代理开关、CA 文件）。
- `cargo check --release` 通过（菜单标记与失败原因保留）。
- `tsc` 通过（`apps/desktop-shell`、`apps/desktop`、`apps/desktop-host`）。
- `scripts/release/publish-harness-cn.mjs` 与 `verify-harness-cn-release.mjs` **在本机对 rc.18 实跑过**：发布脚本幂等（两端都报 “already published at the same size; left alone”），校验脚本两个文件、两个源全部 `OK`。
- workflow YAML 用 js-yaml 解析通过；打包步骤与本机实测成功的那条链路一致。

## 已知限制

- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 发布 workflow **尚未在真实的 GitHub runner 上跑过**（本机无法执行 Actions）。第一次请用 `publish: false` 跑一遍打包，确认无误后再勾选发布。
- 安装包仍然未签名，因此每次更新都要重新过一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
