# Harness-CN 系统要求与网络说明

本页说明 **Harness-CN**（本仓库发布的 Windows 桌面版）能装、能更新、能运行的前提，以及它在什么机器上**会失败**、失败时会看到什么。安装包、离线包与更新通道的实际约束都写在下面，来源是发布代码本身。

> 上游 `@deepseek-ai/dsh` 的通用要求见 [apps/desktop/README.md](apps/desktop/README.md)。本页只讲 Harness-CN 这个发行版的边界。

## 一句话结论

在一台**普通 Windows 10/11 x64 电脑 + 能访问 gitee.com 或 api.github.com 的网络**上：能装、能更新、能运行，且**首启之后每次启动都不需要联网**。

在代理网络、企业管控、非 x64、或需要安装插件的机器上，会分别卡在下面四道坎上——每一道都有明确的失败表现，不会静默。

## 必须满足

| 要求 | 为什么 | 不满足时 |
| --- | --- | --- |
| **Windows x64** | 只发布 `win-x64` 一个目标，内置运行时是 `x64 win32` Node 24.17 | ARM64 Windows 只能靠 x64 仿真，未做验证；macOS / Linux 没有发行版 |
| **WebView2** | 界面由 WebView2 渲染（`webviewInstallMode: downloadBootstrapper`） | Win11 自带；Win10 由安装包联网补装。离线装机 + 无 WebView2 时窗口起不来 |
| **约 1 GB，实测更多** | 安装目录约 110 MB，`~/.dsh/desktop`（离线包 + 包存储）约 3 GB，profile 约 300 MB | 空间不足时首启会在「展开包存储」阶段失败并报错退出 |
| **能访问 gitee.com 或 api.github.com** | 首次启动下载离线包（约 78 MB），更新通道查这两个源 | 首启失败会给出提示，并告诉你把离线包手动放到哪个目录（见下） |
| **允许按用户安装与就地更新** | NSIS `installMode: currentUser`，装在 `%LOCALAPPDATA%\Harness-CN` | 企业策略禁止用户目录安装、或 EDR/杀软拦截时，装不上；更新要在原目录替换文件，同样需要写权限 |
| **安装包未签名** | 没有代码签名证书 | 首装和**每次更新**都会触发 SmartScreen「更多信息 → 仍要运行」；有的 IT 策略直接禁止 |

## 不需要

- **不需要装 Node、pnpm 或任何工具链**：Node 24.17 与 pnpm 11.7 随包内置，第一方依赖来自离线包内置的 pnpm store。
- **不需要管理员权限**：按用户安装。
- **不需要联网就能重复启动**：离线包缓存在 `%USERPROFILE%\.dsh\desktop\seed\seed-<版本>`，之后每次启动都离线。
- **不需要我们的账号**：只需要用户自己的 DeepSeek API Key。

## 网络：代理、镜像、自签证书

这是最容易卡住的一类机器，所以逐条说清楚：

| 场景 | 现在的行为 |
| --- | --- |
| 首启/更新走代理上网 | 读系统环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`。**必须设置**，否则 Node 默认不走代理，检查更新会失败并提示你去设它 |
| 插件安装走代理 | 同上；安装时会显式把 `NODE_USE_ENV_PROXY=1` 传给 pnpm 子进程，并在运行日志里记一行「package installs use the configured proxy (…)」 |
| 用国内 npm 镜像装插件 | **尊重机器自己的选择**：读 `npm_config_registry` / `NPM_CONFIG_REGISTRY`，以及 `npm_config_userconfig` / `NPM_CONFIG_USERCONFIG` 指定的 npmrc 文件；机器没指定时才回退到 `https://registry.npmjs.org/` |
| 私有 registry 用自签 CA | 读 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 指定的证书文件（追加信任，不替换系统信任），并在运行日志里记一行 |
| registry 值写得不像 registry | 路径、账号密码、查询串、非 HTTP(S) 协议一律**拒绝**并回退默认值，不做猜测 |
| 更新源完全不可达 | 自动检查（首启 10 秒后、之后每 6 小时）失败时：写运行日志，并把菜单里的「检查更新」标成「检查更新 [!]」；点该菜单项会先弹窗说明**上次失败的原因**，再重新检查 |

## 手动放离线包（网络受限机器）

首启失败时会给出去向和文件名的提示。正确做法：

1. 从任一发布页下载 `Harness-CN-seed-<版本>.tar.zst`（或 `.tar.gz`）；
2. 放到 `%USERPROFILE%\.dsh\desktop\seed\downloads\`；
3. 重新启动应用。

查找顺序是：**随包自带 → 本地缓存 → downloads 手动放置 → 联网下载**。手动放的文件解包后**保留**，只有自动下载的才在解包后删除。

## 更新通道

- 首选 **Gitee**（`ph-wang/Harness-CN`），失败则 **GitHub**（`WPH666-py/Harness-CN`）。
- 两处都会查，取最新且带安装包的那一版；两个源都不可达时，检查更新会明确报错，不会假装「已是最新」。
- 每次更新都要重新下载安装包并重新触发一次 SmartScreen（未签名）。

## 已知限制

- **没有 macOS / ARM64 发行版。**
- 发布链路依赖上面两个仓库与对应凭据；发布流程已移入 `.github/workflows/harness-cn-release.yml`，用仓库 Secrets 而不是某台机器的固定路径。
- `release/` 下的打包脚本仍要求 Windows 环境（Tauri + NSIS + MSVC）。
