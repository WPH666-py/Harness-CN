# Harness-CN

**面向 Windows 的 DeepSeek Harness 桌面发行版** —— 把"全插件 Cordis agent harness"打成一个双击即用的安装包，内置 Node、pnpm 和整棵插件树，**首次启动不需要联网安装任何依赖**。

> 本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `0.1.5-rc.1` 的第三方发行分支，**非官方发行版**。上游项目与本分支均为 MIT 许可；详见文末「许可证与致谢」。

| 项目 | 说明 |
| --- | --- |
| 发行版本 | `0.1.5-rc.1`（跟随上游 tag `dsh-v0.1.5-rc.1`） |
| 目标平台 | Windows 10 / 11 **x64** |
| 安装包 | `Harness-CN-0.1.5-rc.1-win-x64-setup.exe`（约 194 MB，见 Releases） |
| 安装方式 | 按用户安装、可选安装目录、**不需要管理员**；安装包**未签名** |
| 许可证 | MIT（含上游与第三方声明） |

📖 **用户手册**：**[Harness-CN说明文档.md](Harness-CN说明文档.md)** —— 安装、首次启动、界面导览、常用操作、随包插件、数据与备份、故障排查、从源码构建，逐节说明。

---

## 这是什么

DeepSeek Harness 是一个"一切皆插件"的 coding agent 运行时：会话、工具、子代理、工作流、沙箱与审批、Web GUI 全都是由 Cordis 插件组合出来的。上游以 npm 包与 `dsh` CLI 的形式发布，使用者需要自己准备 Node 环境、拉取 profile、安装插件。

Harness-CN 做的事情只有一件：**把这一整套东西做成一个 Windows 安装包**，并解决在真实桌面环境里会遇到的启动与升级问题。安装后不需要 Node、pnpm、Python、Git 或任何编译工具链。

## 下载与安装

1. 打开本仓库的 **Releases**，下载最新的 `Harness-CN-0.1.5-rc.1-win-x64-setup.exe`。
2. 双击安装。因为安装包**没有代码签名**，Windows SmartScreen 会提示"未知发布者"，选择「更多信息 → 仍要运行」即可；企业策略严格的机器可能直接拦截未签名程序。
3. 安装器是"向导式"（非一键式）：可以自选安装目录（默认按用户安装，不需要管理员权限）。
4. 首次启动请在启动界面绑定 **DeepSeek API Key**（凭据只保存在本机 `~/.dsh/.credentials.yaml`，不会随安装包分发）。

**环境要求**：Windows 10/11 x64（Electron 44 的门槛，Win7/8 不支持）；用户目录所在磁盘预留约 1 GB（运行时镜像 ≈540 MB）；能访问 `api.deepseek.com`。

## 首次启动会发生什么

安装包里的 `resources/seed` 不是一堆散装 npm 包，而是一份"已安装好的运行时"的归档：**pnpm store 的 16 个分片** + **一份链接清单**（哪棵树里的哪个文件由 store 里哪个文件提供）+ 少量归档文件。启动时只需要把它"链接"回本地，而不是重新安装一遍。

| 阶段 | 首次启动 | 之后每次启动 |
| --- | --- | --- |
| 校验种子（逐文件哈希） | ~3 s | 同一版本直接跳过 |
| 解包并合并 pnpm store | ~30 s（该 seed 首次） | 已含该 seed 时整段跳过 |
| 重建 profile（约 27,000 个硬链接） | ~15 s | 已安装且同一 seed 时跳过 |
| 暂存运行时健康检查（真的起一次后端） | ~10–60 s | 跳过 |
| 激活 + 正式启动后端 | ~7 s | ~7 s |

启动窗口在 1–2 秒内出现，带进度条和循环播放的加载动画，所以等待期间不会是"空屏卡死"。进度与每一步的日志都写在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\harness.log`，出问题时把它发到 Issue 是最快的定位方式。

## 相对上游做了什么

**发行与启动**
- 桌面发行流水线：`prepare-seed` 直接把"装好的 profile"归档成 store 分片 + 链接清单，安装时只做链接，不做安装。
- profile 与 store 分离的**事务式替换**：新运行时先在 staging 里链接好、起一次后端证明能启动，再原子换入；换入失败自动回滚。中断的事务在下次启动时自愈。
- store 标记绑定"分片集合摘要"而不是整份种子的身份：**只改了应用代码、包没变的升级包可以跳过 30 秒解包**。
- 残骸自愈：profile 目录里只剩 `node_modules`（比如上一次删除没删干净）时按全新安装处理，而不是读它的 `package.json` 直接报错退出。
- 启动窗口（进度条 + 加载动画）、独立的 API-Key 绑定窗口、运行日志查看窗口，且这些辅助窗口不显示菜单栏。

**桌面 Shell**
- 顶部菜单精简为：重启 / 运行日志 / 检查更新 / 重新绑定 API-Key / 开发者工具 / 退出。
- 因为本发行版**未签名**，构建时不产出更新源，所以「检查更新」不会真的拉到新版本，升级请手动安装新包。
- 目录选择器使用原生实现；开发工具、日志与窗口尺寸等状态按应用持久化。

**客户端（Web GUI）**
- 客户端 store 复水改为"把本地存档合并到声明的初始状态之上"：升级后旧版本留下的存档不会再让界面崩溃（典型症状是侧边栏工作区列表整个挂掉）。
- 会话导入面板、视觉引擎（ModLens）面板等第三方面板的 POST 路由打通：桌面载体过去把所有非 GET 请求直接交给只读的静态资源处理器（于是统一返回 405），现在一律先送交内部 webserver，只有它明确 404 且请求是读操作时才回落。

**捆绑的第三方插件**（都随安装包预置，首次启动即可用，离线）
`dsh-chat-import`（会话导入/双向同步）、`dsh-cost-meter`（会话费用与余额）、`dsh-rule-engine`（规则引擎）、`@liustack/modlens`（视觉引擎）、`@jieai/dsh-plugin-vet`（插件审计）。另有 `@anionex/dsh-vision-toolkit` 默认**不激活**——它首次运行会下载约 35 MB 的独立 Python 运行时，会拖住启动。

## 从源码构建

```powershell
# 前置：Windows x64、Node 22.19+ 或 24+、git、可选的真实 Python（编译原生模块用）
pwsh -File build-harness-cn.ps1            # 首次会 pnpm install
pwsh -File build-harness-cn.ps1 -SkipInstall
```

脚本做的事：固定 pnpm `11.7.0`、设置 Harness-CN 的应用标识与"未签名"模式、切到 Electron 镜像源，然后执行上游的 `package:desktop:win:x64`（`build:official` → `release:pack` → `prepare:runtime` → `prepare:package-set` → `prepare:seed` → `electron-builder`）。产物在：

```
harness-0.1.5-rc.1/apps/desktop/.desktop-build/targets/win-x64/artifacts/
  ├── harness-cn-0.1.5-rc.1-win-x64.exe      # 安装包
  └── win-unpacked/                          # 免安装目录（含 resources/seed 与 runtime）
```

构建要点：原生模块（`node-pty`、`koffi`、`fs-ext`）在构建机上编译或取预编译产物，**使用者的机器上不需要编译器**；`apps/desktop/.desktop-build` 是构建产物目录，不要提交。

## 仓库结构

```
apps/desktop/          Electron Shell：窗口、菜单、启动事务、种子与 store 管理
apps/desktop-host/     桌面后端载体：把 Web 组合跑在字节管道上（含插件路由转发）
packages/              上游的 Cordis 插件包（core/api/client/fs/llm/session/… 共 200+）
vendor/                上游 vendored 的 Cordis 源码
python/ native/        Python SDK 与原生扩展
scripts/ docs/         构建与文档
build-harness-cn.ps1   本分支的打包入口
```

## 常见问题

**启动时弹「Harness-CN 无法启动」**：对话框里的第一行就是根因。三类我们修过并覆盖了测试的形态：
- `plugin tree failed to load ... Invalid or unexpected token` / `Cannot find module ...spill.js` —— 早期版本用文件 inode 配对 store 文件，在 Windows 上会配错（把别的文件的内容写进这棵树）。现已改为**按内容 sha512 配对**。
- `desktop project: core package mapping does not match desktop-packages.json` —— profile 里的 `pnpm-workspace.yaml` 被 pnpm 追加了自己的段落；现已改为只校验核心映射是否存在。
- `ENOENT: ... profiles\desktop\package.json` —— profile 是删除残留；现在按全新安装处理。

**启动很慢/像卡住**：看启动窗口是不是在动，以及 `harness.log` 里最后一行停在哪一阶段。首次安装后的第一次启动会做一次完整的解包与链接（见上表），属于预期。

**「会话导入」面板报"服务响应异常"或侧边栏工作区列表崩掉**：分别对应上面提到的 POST 路由与客户端存档合并两个修复，请安装最新安装包。

**想彻底重置**：退出应用后删除 `~/.dsh/profiles/desktop` 与 `~/.dsh/desktop`（前者是运行时，后者是 pnpm store 与暂存目录），下次启动会自动重建；`~/.dsh/settings.yaml` 与 `~/.dsh/.credentials.yaml` 保存的是你的设置与 API Key，删掉需要重新配置。

**能不能装到别的系统**：这个安装包只有 Windows x64；macOS/Linux 请使用上游。ARM64 的 Windows 只能以 x64 模拟方式运行。

## 为什么启动能这么快：seed 的设计

上游的安装方式是"跑一次 `pnpm install`"，在 Windows 上这一步通常是几分钟并且强依赖网络。本发行版把它换成了"发布一棵已经装好的树"：

1. 构建时在临时目录里正常安装一次，得到一棵完整的 `node_modules`；
2. 遍历这棵树，把每个文件按**内容的 sha512** 定位到 pnpm store 里的条目（store 本身就是内容寻址的：文件名是内容摘要，前两位十六进制是桶目录），记录成 `profile-links.json`；store 里没有对应内容的少数文件（安装过程生成的文件）进 `profile-files.tar`；
3. 把 store 切成 16 个分片 tar，连同清单一起放进安装包的 `resources/seed`。

安装后首次启动做的是：校验种子（逐文件 SHA-256）→ 解包分片并合并进本地 store → 在暂存目录里按清单**建硬链接**（约 2.7 万个链接，约 15 秒）→ 起一次后端证明这棵树能跑 → 原子替换。

这样设计的两个直接好处：**首次启动离线可用**，而且**同一版本第二次启动几乎瞬时**。另外还有两个曾经的坑，已经在代码里修掉并覆盖了测试：

- **不能按 inode 配对**。Windows 上 Node 报告的 `ino` 是 64 位文件索引塞进 JS Number，超过 2^53 会丢精度，于是两个不相干的文件会配到同一条 store 条目，重建出来的树里就混进了别人的内容（症状是插件加载报 `Invalid or unexpected token` 或`Cannot find module`）。现在一律按内容摘要配对。
- **`.modules.yaml` 里的构建期路径要改写**。种子里的那棵树记录着"我是在构建机的临时 store 里装的"，直接照搬会让后续任何 `pnpm` 操作以 `ERR_PNPM_UNEXPECTED_STORE` 失败。materialize 时会把 `storeDir` 与 `virtualStoreDir` 改写成本机实际位置。

## 数据放在哪里

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/profiles/desktop` | 已安装的运行时（重建即可恢复） |
| `~/.dsh/desktop/pnpm/store` | 本地 pnpm store 与暂存目录（重建即可恢复） |
| `~/.dsh/settings.yaml` | 你的设置：默认模型、权限预设、主题、语言等 |
| `~/.dsh/.credentials.yaml` | API Key 等凭据（不会随安装包分发） |
| `~/.dsh/storages/` | 插件自己的数据（如费用账本） |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs\harness.log` | 桌面 Shell 与后端的运行日志 |

安装包**不需要管理员权限**：按用户安装、不注册系统服务、不写开机自启、不修改系统 PATH。所有状态都在你的用户目录下，卸载时删除安装目录即可（`~/.dsh` 会保留，需要时可自行清理）。

## 升级与回滚

直接运行新版本的安装包即可覆盖安装：下次启动会发现种子变了，重新链接一棵新的运行时，起一次后端证明可用之后原子换入，**旧的运行时会被移到 `rollback` 目录**而不是当场删掉；换入过程中如果任何一步失败，会自动回滚到旧的运行时并给出错误。要强制重建（例如怀疑本地状态坏了）：退出应用后删除 `~/.dsh/profiles/desktop`，下次启动会自动重建；连 store 一起删则多花约 30 秒解包。

## 贡献与反馈

欢迎 Issue 与 PR。提交问题时请附上：`harness.log` 的尾部若干行、对话框全文（如果有）、以及 `winver` 的系统版本。涉及构建的改动请在 PR 描述里给出你实际跑过的命令与结果。

## 许可证与致谢

- 本仓库基于 **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）修改，上游版权归 DeepSeek 所有；本分支的改动同样以 MIT 发布，详见 `LICENSE`。
- 捆绑或依赖的第三方组件与许可证清单见 `THIRD_PARTY_NOTICES.md`；`vendor/` 是上游的 vendored 源码副本，其来源与版本记录在 `vendor/README.md`。
- 本仓库**不是** DeepSeek 官方发行版，相关名称仅用于说明来源；问题请提到本仓库而不是上游。
