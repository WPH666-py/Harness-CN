# Harness-CN 0.1.5-rc.20（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版解决的不是某个功能坏了，而是**这台机器上能不能用**的问题：插件装不上、更新默默失败、失败原因看不见。此外，首次启动才付的那笔一次性开销被挪到了安装时，后端改为常驻托盘；移动端界面与微信桥两个插件改为随包发布，装完即用。

> **关于版本号**：`0.1.5-rc.20` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.20_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.20.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

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

### 四、启动与安装提速

**问题**：首启慢的根因是那笔一次性开销都堆在「第一次打开」时才付——解包离线包、逐项 SHA-256 校验、建 2.7 万次硬链接、真起一次后端做健康检查。用户感知就是「装完点开，卡很久」。本版把这笔开销拆开、前移、并行化。

**1. 运行时构建从「首次启动」挪到「安装末尾」**（`apps/desktop-shell/src-tauri/hooks.nsh`）

- 安装器把文件落地后、结束前，用随包的 Node 跑一次 `shell.mjs --prebuild`（`nsExec::ExecToLog /TIMEOUT=1200000`，即最多 20 分钟），提前把运行时构建好。
- **不把 seed 打进安装包**：那样会让安装包超过 Gitee 单附件 100 MB 上限（`installMode: currentUser`，包体越小越好）。预构建时按需下载 seed。
- **离线/下载失败不阻塞安装**：这一步的退出码安装器不检查，失败就静默跳过，回退到老路径——首次启动时再构建。也就是说最坏情况等于旧行为，不会把安装搞失败。

**2. 关窗进托盘，后端常驻保活**（`apps/desktop-shell/src-tauri/src/main.rs`）

- 关闭窗口不再结束进程，而是 `window.hide()`——外壳与后端进程都留在系统托盘里，再次打开瞬间复用已就绪的后端，免去重新启动的几十秒。
- 托盘菜单两项：**「显示主窗口」**（等同重新打开）与**「退出 Harness-CN」**；只有「退出」才会真正结束后端进程。
- 重复启动不再起第二个实例：通过命名事件 `Local\Harness-CN-Show` 唤起已运行实例的主窗口。为此给 tauri 打开了 `tray-icon` feature（`apps/desktop-shell/src-tauri/Cargo.toml`）。
- **行为变化提示**：以前关窗即退出，现在关窗是「收进托盘」。想彻底退出请用托盘菜单或右下角图标右键。

**3. 首启文件操作降本**（`apps/desktop/src/project-manager.ts`）

- 离线包归档的 SHA-256 校验改为**有界并发**（`SEED_HASH_CONCURRENCY = 8`），不再串行逐个算。
- 已经存在且校验通过的归档、以及已经建好的硬链接**直接跳过**，不重复校验、不重复建链。2.7 万次文件操作里能省掉的都省掉。
- 没有引入文件系统驱动或挂载方案——那是高风险改动，本版只做低风险降本。

**4. 首启健康检查按场景降级 + 字节码缓存预热**（`apps/desktop-shell/src/shell-main.ts`、`apps/desktop/src/host-process.ts`）

- **首启/升级**改用 `verifyStagedRuntime` 做结构完整性检查（几秒），不再「真起一次后端再关掉」地验证（那样要几十秒）；只有**增删改插件**时才保留完整启动验证，保证正确性。
- 给后端子进程设 `NODE_COMPILE_CACHE`（缓存目录 `node-compile-cache`，落在 profile 之外）：第一次跑把常用模块编译成字节码缓存，之后启动直接复用，省掉重复编译。

### 五、移动端与微信改为随包发布

**问题**：`dsh-web-mobile`（手机上的 DSH 界面）与 `dsh-wechat`（微信桥）以前要用户自己在插件市场装。麻烦的不只是多两步：`dsh-wechat` 是**进程内直接调用宿主服务**的插件，装一个与宿主代际不匹配的版本不会「少个功能」，而是运行时报错。

**修复**（`apps/desktop/src/bundled-plugins.ts`）：

- 两个插件加进内置清单，随安装包发布，安装后默认挂载，不需要用户动手。
- `dsh-web-mobile@3.0.6`：纯客户端插件，主机半边是空的 `apply`，因此**不给宿主增加后台任务**；它自己往 Web 界面上挂那层移动端 UI。
- `dsh-wechat@0.8.0`：**钉住 0.8.0**。0.9.7 起该插件要求 `engines.dsh >= 0.2.0-rc.2`，而本发行版的代码基线是上游 `dsh-v0.1.5-rc.1`；本地宿主不满足要求会**拒绝加载**，用户会以为插件装坏了。0.8.0 是最后一个声明支持我们这条基线的版本。
- 两个插件都不需要额外依赖：`dsh-web-mobile` 要的 `@deepseek-ai/dsh-client-ui-primitives` 属于 Web 外壳的常驻模块表，任何插件包都能取到。

**怎么用**：移动端走已有的局域网访问（设置里那条移动访问），手机浏览器打开即可；微信在「设置 → WeChat」里扫码登录，登录态落在离线包之外的 `wxbridge` 目录，重装不丢。

## 本次发布的验证方式

| 验证 | 证据 |
| --- | --- |
| 离线包构建 | `prepare:seed` 退出码 0：664 个包从 registry 解析，266 个 tarball + 9 个 vendor |
| 内置清单真的生效 | 独立实例（临时 `DSH_HOME` + 本次构建的 sidecar）启动到 `ready`，后端列出 12 个内置插件，两个新插件都在且标记为「随包发布」 |
| 客户端接线 | 两个客户端组合端点都返回 200（`690438` / `17903` 字节），各自注册名为 `dsh-web-mobile` / `dsh-wechat`；`window.__DSH_BOOT__` 启动图里两行都在 `batch phase=application`，`inject` 边完整、`external` 为空 |
| 真实页面 | 1460×900 与 390×844 两档视口，控制台与页面异常各 0 条；「设置」左侧导航出现「WeChat」项，与「通用设置 / 模型 / 插件 / Agent 预设 / 会话导入 / 费用」并列 |
| 单元测试 | 46 项全绿（project-manager、registry-settings、release-channel、seed-store），含「拒绝改动随包发布的插件」一组 |
| 打包 | `package:desktop:win:x64` 与 `tauri build` 均退出码 0；Rust release 编译 3 分 06 秒 |
| 发布 | 两个文件上传到 GitHub 与 Gitee，大小与本地构建产物逐字节一致 |

前四节（插件镜像与代理、更新失败可见、发布链路进 CI、启动与安装提速）的验证记录在 rc.19 一文里，本版未改动那些代码路径。

## 已知限制

- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 发布 workflow **尚未在真实的 GitHub runner 上跑过**（本机无法执行 Actions）。第一次请用 `publish: false` 跑一遍打包，确认无误后再勾选发布。
- 安装包仍然未签名，因此每次更新都要重新过一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
- 移动端与微信**没有真机验证**：本次只验证到「插件被正确挂载、设置页出现入口、控制台无异常」。手机实际显示效果、微信扫码登录后的收发是否顺畅，需要用户在真机上确认。
- 微信桥的可用性受**微信侧**规则限制；登录用的是网页版协议，账号有可能被限制，这与本发行版无关，插件也修不了。
- 两个插件是**钉版本**的（3.0.6 / 0.8.0）。将来想跟进新版，要先确认新版的 `engines.dsh` 与本发行版的基线兼容，不能只改版本号。
- 安装包会**结束正在运行的 Harness-CN 再替换文件**（`hooks.nsh`），升级前请先保存手头工作。
