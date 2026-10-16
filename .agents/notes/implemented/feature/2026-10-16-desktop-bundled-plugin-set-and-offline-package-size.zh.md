# Agent Note: 桌面内置插件集与离线包体积

Status: implemented

[English](2026-10-16-desktop-bundled-plugin-set-and-offline-package-size.md) | 中文

## Problem

全新的 Desktop profile 只带发行版内置的插件：`apps/desktop/src/bundled-plugins.ts` 就是种子用来预热 pnpm store 的那份清单，profile 清单从该种子复制而来，`dsh.profile.bundles` 再把各行激活。有三项被用户点名的能力不在那份清单里，于是一次不访问 registry 的首启就加载不到它们：白盒长期记忆、给纯文本模型用的图像识别、以及 WorkBuddy 桌面端自带的模型服务。

把它们加进去并非没有代价，而且代价落在这个发行版在意的一个维度上。离线包是整个种子的一个归档，作为 release 附件发布，而 Gitee 的附件上限是 100 MiB，同时 `prepare-shell.mjs` 拒绝把超过该上限的构建放行——这样「没人能下载的发行版」会在构建期就失败，而不是等到上传。单是记忆插件就是本仓库所内置的最大包，比其余大两个数量级——npm 报 42.4 MiB 未压缩（44 434 676 字节）——而 rc.25 的种子在 zstd 22 级下已经是 96.9 MiB（101 604 376 字节）。

## Decision

三条以 `active: true` 且版本精确钉住的行加入内置集，每条都在原地写清理由：

- `@furongjun1999/dsh-memory` `0.8.1`——一条宿主行加上其工具读取的知识树；它在运行时导入的每个包（`dsh-session`、`dsh-system-prompt`、`dsh-tools`）与声明的每个 peer 都是本 profile 已经提供的。
- `@lp181818/dsh-vision-plugin` `1.2.3`——给纯文本模型用的图像识别，从它自己的 Settings 页配置。它与 `@anionex/dsh-vision-toolkit` 不同，后者因为首次使用时会自行准备 Python 运行时而保持 inactive；这一个只是 44 KB 的 JavaScript，宿主半边只导入 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。
- `dsh-workbuddy-connect` `0.6.5`——WorkBuddy 桌面端自己的模型服务，挂成一条 `llm-workbuddy` provider 行，不启动任何 OAuth 流程、也不改默认模型。它钉在其 0.1.5 走廊的最后一个版本上，因为 0.7.0 起把每个 dsh peer 都钉到 `0.2.0-rc.2`——本产品不携带那条线——而 0.6.5 对它需要的七个接缝接受 `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.1`；它在走廊外的唯一 peer `@earendil-works/pi-ai` 已按它要求的版本装在这里，因为 `dsh-llm-pi-ai` 依赖它。

版本必须精确，因为三处必须一致：`prepare:seed` 预热的 pnpm store、从种子复制的 profile 清单，以及 `dsh.profile.bundles` 列表。钉版漂移会被 `verifyOfflineInstallation` 在构建期抓住，而不是落到用户机器上。

种子体积上限从常量变成显式的构建开关。`apps/desktop-shell/scripts/prepare-shell.mjs` 读取 `HARNESS_CN_SEED_LIMIT_MB`，默认 100——Gitee 的附件上限，所以普通构建在种子涨过它时依旧大声失败——设为 `0` 则关闭该检查，供不发布到 Gitee 的发行版使用。0.1.5-rc.26 就是这样构建的：该归档在 zstd 22 级下为 122.2 MiB。

## Alternatives considered

**不内置这三者，让用户自己安装。** 否决：全新的离线 profile 带不上的能力，正是这次改动要发布的能力；而记忆插件恰恰是用户在首启之前无法评估的那类包。

**为了不超过 Gitee 上限而放弃记忆插件。** 否决：它就是这次要加的能力。上限是发布约束，不是扣下这个包的理由——另外两项加起来不到它的十分之一。

**把离线包拆成核心归档与扩展归档。** 是推迟而非否决：首启路径只取一个文件、只校验一份清单，因此拆分是对种子契约（身份、完整性、store 合并）的架构级改动，而不是发布期的取舍。要让 100 MiB 以上的能力集重新回到两个托管方，这是唯一的办法。

**把 zstd 级别提到 22 以上。** 否决：22 是编码器接受的最高标准级别，而从 19 到 22 的收益已经用掉了（rc.24：19 级 124.1 MiB，22 级 97.0 MiB）。

**保持硬上限，离线包过大时就不发布它。** 否决：安装程序从不携带种子，所以把种子从发行版里拿掉，等于让首启去下载一个没有任何托管方提供的包——那是坏掉的发行版，而不是更小的发行版。

## Consequences

rc.26 的种子是 122.2 MiB，因此离线包目前只能挂在 GitHub release 上；把这个构建发布到 Gitee 时无法携带它，发布说明里写明了这一点。想让 Gitee 重新托管离线包的人，必须缩小内置集或者拆分归档。

现在每个安装好的 profile 都会带上记忆插件的文件与另外两项较小的新增，而三者都无需 registry 就能加载，因为种子 store 持有它们的闭包。记忆插件自带的 bundle patch 只有一条 insert，另外两者也各自通过自己的 patch 注册，因此没有任何桌面补丁层为它们新增行。

种子体积门禁恰好被一个环境变量削弱：设了 `HARNESS_CN_SEED_LIMIT_MB=0` 的构建会发布它产出的任何东西。这是有意的——上限属于构建无法替之决定的发布决策——而默认值让所有不设它的人继续得到那个响亮的失败。

同一个种子里进入的其它包（包括本版移除的官方客户端包，它部分抵消了这里的增长）由 [DeepSeek 账号登录与赠金领取](2026-10-16-desktop-deepseek-account-and-bonus-credits.zh.md) 这篇笔记拥有。
