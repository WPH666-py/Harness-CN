# Harness-CN 0.1.5-rc.1（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版，
把整套"全插件 Cordis agent harness"打成一个**免开发环境**的 Windows 安装包：Electron、Node 24、pnpm 11.7
以及一棵已经安装好的插件树（242 个包）都在安装包内，首次启动**离线可用**。

## 下载

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `Harness-CN-0.1.5-rc.1-win-x64-setup.exe` | 194.4 MB | `7F866BBEDC789CA43EC74325BF7363AC85C2BB7B3BF898D0C54552091B47AB96` |

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限，
可选安装目录。

## 安装与首次启动

1. 运行安装包，选择安装目录。
2. 启动后在启动界面绑定 DeepSeek API Key（凭据只保存在本机 `~/.dsh/.credentials.yaml`）。
3. 首次启动会重建运行时：校验种子 ≈3s → 解包 pnpm store ≈30s → 链接约 27,000 个文件 ≈15s →
   暂存健康检查 → 激活并启动。窗口 1–2 秒内出现，带进度条与加载动画；之后每次启动只剩后端启动（数秒）。

## 相对上游的改动

- **发行**：seed 直接携带"已安装好的 profile"（pnpm store 分片 + 链接清单），安装时只做硬链接；
  profile 替换是事务式的（先用暂存树起一次后端证明可用，再原子换入，失败自动回滚）。
- **启动**：store 链接按内容摘要（sha512）配对，不再依赖 inode（Windows 上会因精度丢失而配错）；
  store 标记绑定分片集合摘要，只改应用代码的升级包跳过 ≈30s 解包；profile 只剩 `node_modules` 的
  残骸按全新安装处理，不再以 `ENOENT` 中止启动。
- **桌面 Shell**：启动窗口（进度条 + 加载动画）、独立 API-Key 绑定窗口与运行日志窗口，辅助窗口无菜单栏；
  顶部菜单精简为 重启 / 运行日志 / 检查更新 / 重新绑定 API-Key / 开发者工具 / 退出。
- **客户端**：本地存档复水改为合并到声明的初始状态之上，旧版本存档不再让侧边栏工作区崩溃；
  插件 POST 路由直达内部 webserver（此前被只读的静态资源处理器以 405 拒绝，导致"会话导入"面板报错）。
- **捆绑第三方插件**：`dsh-chat-import`、`dsh-cost-meter`、`dsh-rule-engine`、`@liustack/modlens`、
  `@jieai/dsh-plugin-vet`（`@anionex/dsh-vision-toolkit` 随包但不激活）。

## 已知限制

- 仅 **Windows 10/11 x64**；未签名、无自动更新（升级请手动安装新包）。
- `~/.dsh` 与 `dsh` CLI 共用，同一台机器上混用其他构建时会互相覆盖 profile 与 store。
- 首次启动需要约 1 GB 用户目录空间（store ≈260 MB + 运行时 ≈270 MB）。

完整说明（含设计原理、数据位置、升级回滚、从源码构建、FAQ）见仓库的
[README.zh-CN.md](https://github.com/WPH666-py/Harness-CN/blob/main/README.zh-CN.md)。

下载链接：<https://github.com/WPH666-py/Harness-CN/releases/download/v0.1.5-rc.1/Harness-CN-0.1.5-rc.1-win-x64-setup.exe>

## 许可证

基于上游 MIT 许可修改，本发行版同样以 MIT 发布；第三方组件清单见 `THIRD_PARTY_NOTICES.md`。
本仓库不是 DeepSeek 官方发行版。
