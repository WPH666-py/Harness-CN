# Harness-CN 安装兼容性 & 相对原版 Harness 的优势

> 对应版本：Harness-CN `0.1.5-rc.24`（Windows x64 桌面发行版），代码基线为上游 `deepseek-ai/deepseek-harness` 的 `dsh-v0.1.5-rc.1`。
> 本文结论来自发布代码本身：`SYSTEM-REQUIREMENTS.zh.md`、`apps/desktop-shell/src-tauri/tauri.conf.json`、`apps/desktop/src/bundled-plugins.ts`、`build-harness-cn-tauri.ps1` 与 `RELEASE-NOTES-v0.1.5-rc.24.md`。

---

## 一、安装包能在「任何人的电脑」上装起来并跑起来吗？

**一句话结论：不能覆盖「任何」电脑，但能覆盖绝大多数普通 Windows 用户。**

在一台 **普通的 Windows 10/11 x64 电脑 + 能访问 gitee.com 或 api.github.com 的网络**上，它可以顺利安装、更新并运行，而且**首启之后每次启动都不需要联网**。但有几类机器会明确装不上或跑不起来——这些边界都写在文档里，失败时会给出可读的报错，而不是静默卡死。

### 1.1 必须满足的前提

| 要求 | 说明 | 不满足时会怎样 |
| --- | --- | --- |
| **Windows x64** | 只发布 `win-x64` 一个目标，内置的是 x64 版 Node 24.17 | ARM64 的 Windows 只能靠 x64 仿真运行（未做验证）；macOS / Linux 没有发行版 |
| **WebView2** | 界面由 WebView2 渲染，安装方式为 `downloadBootstrapper` | Win11 自带；Win10 由安装包联网补装。完全离线且没有 WebView2 时窗口起不来 |
| **磁盘空间（约 4 GB）** | 安装目录约 110 MB；`~/.dsh/desktop`（离线包 + 包存储）约 3 GB；profile 约 300 MB | 空间不足时首启会在「展开包存储」阶段报错退出 |
| **能访问 gitee.com 或 api.github.com** | 首次启动需要下载离线包（`Harness-CN-seed-<版本>.tar.zst`，本版约 97 MiB），更新通道也查这两个源 | 首启失败会提示把离线包手动放到 `%USERPROFILE%\.dsh\desktop\seed\downloads\`，重开即可 |
| **允许「按用户安装」** | NSIS `installMode: currentUser`，装在 `%LOCALAPPDATA%\Harness-CN` | 企业策略禁止用户目录安装、或 EDR / 杀软拦截时，装不上 |
| **接受未签名程序** | 没有代码签名证书 | 首装与**每次更新**都会触发 SmartScreen「未知发布者」，选「更多信息 → 仍要运行」；严格的 IT 策略可能直接禁止 |

### 1.2 会在哪些机器上失败

- **非 x64 平台**：ARM64 Windows 未验证；macOS / Linux 没有对应安装包，请使用上游。
- **Windows 7 / 8**：不满足 WebView2 的门槛，不支持。
- **完全离线的机器**：首启拿不到离线包就起不来——除非按上面的方法手动放置离线包（手动放的文件解包后会保留，只有自动下载的才删除）。
- **代理网络未正确配置**：Node 默认不走代理；这类机器**必须**设置 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，否则检查更新会失败并明确提示去设置它。
- **磁盘太小的机器**：会在解包阶段失败。

### 1.3 普通用户会喜欢的「不需要」

- **不需要**安装 Node、pnpm、Python、Git 或任何编译工具链——Node 24.17 与 pnpm 11.7 随包内置，原生模块（`node-pty`、`koffi`、`fs-ext`）在构建机上已编译好，**使用者的机器上不需要编译器**。
- **不需要**管理员权限——按用户安装，不注册系统服务、不写开机自启、不改系统 PATH。
- **不需要**联网就能重复启动——离线包缓存在 `~/.dsh/desktop/seed/seed-<版本>`。
- **不需要**我们的账号——只需用户自己的 DeepSeek API Key（仅保存在本机 `~/.dsh/.credentials.yaml`）。

**小结**：只要不是 ARM64、Win7/8、强管控企业机或彻底离线的机器，绝大多数 Windows 10/11 x64 用户都能双击装好、开箱可用。

---

## 二、相对原版 DeepSeek Harness 的优势

上游 Harness 以 npm 包 + `dsh` CLI 的形式发布，使用者要自己准备 Node 环境、拉取 profile、安装插件，在 Windows 上 `pnpm install` 通常要几分钟且强依赖网络。Harness-CN 做的事情只有一件：**把这一整套「一切皆插件」的运行时做成一个 Windows 安装包，并修好在真实桌面环境里会遇到的启动与升级问题**。具体优势分五类。

### 2.1 开箱即用，零工具链

安装后不需要 Node、pnpm、Python、Git——内置运行时 + 已装好的插件树，首启即可用。上游需要用户自行配置开发环境，本发行版把这道门槛整个去掉。中文界面与中文文档（README、系统要求、说明文档、发布说明）也是随包提供。

### 2.2 离线首启 + 启动快（seed 的设计）

这是本发行版最核心的技术改动。上游是「跑一次 `pnpm install`」，本版换成「发布一棵已经装好的树」：

- 构建时在临时目录正常安装一次，遍历这棵树，按**内容 sha512** 把每个文件定位到 pnpm store 条目（store 本身内容寻址），记录成链接清单；
- 把 store 切成 16 个分片 tar，连同清单一起放进离线包；
- 安装后首启只做「校验种子 → 解包合并 store → 按清单建约 2.7 万个硬链接（约 15 秒）→ 起一次后端证明能跑 → 原子替换」。

直接好处是**首次启动离线可用**，且**同一版本第二次启动几乎瞬时**。此外还用 `NODE_COMPILE_CACHE` 做字节码缓存预热，并把首次启动的编译代价前移到安装阶段（`--prebuild`），第 2 次及以后启动复用已编译字节码。上游的 `pnpm install` 路径在本版中已不存在。

### 2.3 事务式升级、自动回滚、残骸自愈

profile 与 store 分离：新运行时先在 staging 里链接好、真的起一次后端验证可用，再**原子换入**；换入失败自动回滚到旧运行时，**旧运行时被移到 `rollback` 目录而不是当场删掉**。store 标记绑定「分片集合摘要」而非整份种子身份，所以**只改应用代码、包没变的升级包可以跳过 30 秒解包**。profile 目录只剩 `node_modules`（删除残留）时按全新安装处理，而不是读坏掉的 `package.json` 直接退出。这些在上游是「用户自己想办法」的部分。

### 2.4 把真实桌面上踩过的坑都修了

本版发布说明里的多数条目都是「上游没有、但在 Windows 桌面真实发生」的缺陷修复：

- **启动失败 `ENOTEMPTY`**：解包暂存目录过去用固定名，两次重叠的解包会互删文件；现改为每次运行使用唯一暂存目录（带 PID / 时间 / 随机数），清理失败也**不再能决定启动成败**。
- **运行日志窗口空白**：过去页面脚本「先读后画」没有超时，模块卡住时窗口永远空白；现在两处请求各有 5 秒上限、失败按原因分格显示、会重试，**任何失败路径都不会以「窗口什么都没有」收场**。
- **旧版本升不上来**：修好 pnpm 记录被改坏（缺逗号致 pnpm 拒绝整棵树）、以及「把旧钉版当成用户插件去恢复」两步，让装过旧版的机器能正常升级。
- **微信桥不可用**：升级到上游已修好的 `dsh-wechat@0.10.0` 并在离线包里保留兜底补丁。
- 还有按内容 sha512 配对 store 文件（避免 Windows inode 精度问题）、`.modules.yaml` 构建期路径改写等。

### 2.5 随包预置的一批第三方插件（离线可用）

这些插件都**预置在安装包里、首次启动即可用，无需联网安装**（`apps/desktop/src/bundled-plugins.ts` 为准）：

- **`dsh-web-mobile` + `dsh-mobile`（移动端，本版新增）**：前者是纯客户端插件，把窄屏 / 触屏 / 平板下的界面改成移动端形态（底部浮层、软键盘上抬、安全区避让等，宽屏鼠标环境完全不动）；后者是**手机的网络入口**——带托管 TLS 的 HTTPS 服务 + 二维码配对，让手机真的能连上来。两者缺一不可。
- **`dsh-wechat`（微信桥）**：把微信私聊通过腾讯 iLink bot 协议桥接到 agent，双向收发文本 / 图片 / 文件 / 语音，支持微信内 slash 命令、审批与提问卡双端同卡、扫码登录，助手在微信里自称 **DSH-MoBot**。
- **`dsh-rule-engine`**：规则引擎（本版把官方工具 `compress` 补进它的工具分类表，避免每次升级后重新消失）。
- **`billion-context-dsh`**：模型驱动的上下文管理（由模型自己决定何时压缩并写摘要）。
- **`dsh-defend`**：提示注入 / 越狱 / 密钥泄露防护，含破坏性删除守卫。
- **`@goodandready/dsh-time-machine`**：工作区影子 git 检查点，一键回滚 agent 的多文件改动，不碰用户自己的提交与分支。
- **`@xbzbing/dsh-git-panel`**：Web GUI 里的 IDE 风格 Git 面板（分支、历史、未提交改动、diff 统计）。
- **`dsh-chat-import`**（会话导入 / 双向同步）、**`dsh-cost-meter`**（会话费用与余额）、**`@liustack/modlens`**（视觉引擎）、**`@jieai/dsh-plugin-vet`**（插件审计）、**`@vectorize-io/hindsight-coding-agents`**（长期项目记忆）。

另有 `@anionex/dsh-vision-toolkit`、`dsh-vault`、`dsh-rule-engine-client` **已安装但不默认激活**——前者首运行要下载约 35 MB 独立 Python 运行时、后者缺 `DSH_VAULT_PASSWORD` 会拒绝加载，都不让它决定应用能否打开，用户需要时一键开启即可。

### 2.6 面向中国大陆网络

- **更新源首选 Gitee**（`ph-wang/Harness-CN`），失败再回退 GitHub（`WPH666-py/Harness-CN`）；两处都不可达时明确报错，不会假装「已是最新」。
- **尊重机器自己的 npm 镜像与代理设置**：读 `npm_config_registry` / `NPM_CONFIG_REGISTRY`、`HTTPS_PROXY` 等；私有 registry 的自签 CA 通过 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 追加信任。
- 发布同时覆盖 GitHub 与 Gitee 两个源，下载不受单一站点可达性影响。

### 2.7 桌面 Shell 的体验

顶部菜单精简为「重启 / 运行日志 / 检查更新 / 重新绑定 API-Key / 开发者工具 / 退出」；独立的 API-Key 绑定窗口与运行日志窗口；启动窗口带进度条与加载动画，不会是「空屏卡死」；发现新版本会后台下载、按 sha256 校验后静默安装。

---

## 三、边界与注意事项

- 本仓库是**非官方第三方发行版**，问题请提到本仓库而不是上游。
- 只有 **Windows x64**；安装包**未签名**，每次更新都要再走一遍 SmartScreen。
- **手机首次访问会看到证书警告**：`dsh-mobile` 给局域网地址签的是自签 CA 证书，手机浏览器第一次打开需手动信任一次（这是自签证书的正常表现，不是连接失败）；跨网络访问需要自己把端口映射出去，本版不做中继。
- **微信里那个联系人名改不了**：显示名由腾讯 iLink 平台按 `bot_type` 分配，本版只能让助手在对话里自称 DSH-MoBot。
- registry 只在**安装新插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
- 卸载只需删除安装目录；`~/.dsh` 会保留（需要时可自行清理）。
