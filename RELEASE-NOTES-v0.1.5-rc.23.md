# Harness-CN 0.1.5-rc.23（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版修掉 rc.21 里**微信桥完全不可用**的缺陷（每条消息都回「无法创建/恢复 DSH 会话」），让运行日志窗口**不可能再什么都不显示**，并修好**已装过旧版本的机器升不上来**的问题（rc.22 的重建路径会被坏掉的 pnpm 记录与「把旧钉版当成用户插件」两步卡住）；微信桥升到上游已修好的 0.10.0，并让它在微信里自称 **DSH-MoBot**。

> **关于版本号**：`0.1.5-rc.23` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。
>
> **rc.21 的微信桥不可用**：rc.21 里 `dsh-wechat` 钉在 0.8.0，该版本的会话创建回调会读 `ctx.agent`，被 Cordis 拒绝后每条微信消息都只能回复「⚠️ 无法创建/恢复 DSH 会话」。请用 rc.23。
>
> **rc.22 装得上、但升不上去**：rc.22 修好了微信桥，可它重建已有 profile 时先被一份改写坏掉的 pnpm 记录拦住（`missed comma between flow collection entries`），再被「把旧版钉版当成用户插件去恢复」拦住——已经装过 rc.21 或更早版本的机器升到 rc.22 会失败。请用 rc.23（见第十条）。
>
> **rc.20 及更早不要再用**：它们带启动失败的 `ENOTEMPTY` 缺陷。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.23_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.23.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、修复微信桥「无法创建/恢复 DSH 会话」（本版新增）

**现象**：微信里给 bot 发任何消息，收到的都是

```
⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。
```

运行日志里每一次都成对出现：

```
[dsh-wechat] preset mount failed: Error: cannot get property "agent" without inject
[dsh-wechat] create session failed: Error: cannot get property "agent" without inject
```

**根因**：`dsh-wechat@0.8.0` 的会话创建回调把 agent 当作 setup 上下文的属性来读（`ctx.agent?.session?.header?.agentPreset`），而该上下文并没有声明 `agent` 注入，Cordis 于是抛出上面的错误。预设挂载在 `try` 里被吞成一行日志，紧接着的 `ctx.agent?.session?.requestHeader?.()?.config` 不在 `try` 里，回调因此 reject，agent 工厂销毁建到一半的 agent——微信侧只看到「创建会话失败」。

**修复**（两层）：

- **升到上游已修好的 `dsh-wechat@0.10.0`**（[仓库](https://github.com/pan17/dsh-wechat)）：它的回调写成 `agentSetup(agentCtx, agent)`，从 agent 工厂本来就传递它的第二个参数取值，源码注释也写明「DSH 0.1.5 removed `ctx.agent`; `setup` now receives `(agentCtx, agent)`」。它声明的 `engines.dsh >=0.2.0-rc.2` 是元数据，插件路径上没有任何加载器强制它——在本基线上行会挂载、原生命令层与审批/提问 waterfall 应答器都会接上、扫码登录能走完，启动日志里没有任何模块解析或缺失接口的报错。
- **离线包里保留一份兜底补丁**：`apps/desktop/scripts/patch-wechat-sessions.mjs` 在 `prepare:seed` 里检查已安装的 `dsh-wechat/dist/dsh/sessions.js`——只要它还把 agent 当上下文属性读，就改写成从回调第二个参数取值（写临时文件再改名覆盖，因为 pnpm 把 store 条目硬链接进 profile）；0.10.0 的模块读不到这种读取，补丁什么都不做。它保护的正是「profile 里仍解析到 0.8.0」的情况（沿用旧离线包的 profile，或钉版回退），而无法锚定的模块会让构建直接失败，而不是发到用户手上才失败。

### 二、运行日志窗口不会再「什么都不显示」（本版新增）

**现象**：运行日志窗口打开后是一片空白——工具栏标签都在，但列表、状态行、错误提示一个都没有，而磁盘上的 `harness.log` 一直在写。

**根因**：页面脚本在读完语言包、把界面文字写上屏**之后**才去取日志快照，中间没有任何超时；而页面里的兜底脚本用「标题已经写上了」当作「模块还活着」的证据，于是模块卡在某一步时，兜底脚本不会介入，窗口就停在「标签画完、内容为空」的状态——它也如实显示不了自己为什么空。

**修复**（`apps/desktop-shell/rsc/log-viewer.js`）：

- 页面里两处「先读后画」的请求现在都**有上限**（各 5 秒）：界面文字读不到就用页面自带的文字继续（并写一行提示）；日志快照读不到就重试（最多 4 次，间隔 500ms × 次数），重试期间界面上写的是「读取运行日志失败，正在重试（已试 N 次）：<原因>」，而不是一片空白。
- 失败提示**按原因分格**：语言包、事件流、快照各自占一格（`reportBootFailure(text, key)`），某一格恢复后只撤掉自己那一格，不会把仍然成立的别的失败一起抹掉；快照成功画出列表后撤掉重试提示。
- 四次都读不出来时异常照旧抛出，页面照旧把原因写在提示区——**任何一条失败路径都不会再以「窗口什么都没有」收场**。

### 三、微信里的名字：DSH-MoBot（本版新增）

**能改的和不能改的**：微信里那个联系人显示什么名字，由腾讯 iLink 平台按 `bot_type` 分配——建码请求只带 `bot_type=3`，没有名字参数。这一点在 `dsh-wechat` 0.10.0 与 0.11.0，以及腾讯官方 `@tencent-weixin/openclaw-weixin@1.0.2` 的 `login-qr.ts` 里都一样，所以**桥接侧改不了微信里那个联系人名**（想改只能在自己微信里给该聊天改备注）。

**本版改的是我们这侧的名字**：桥接给每条微信消息注入的那段提示词（`DEFAULT_SURFACE_PROMPT`）原本只说「你正在通过微信聊天」，于是助手没有名字可用。现在它多一句「你在微信里的名字是 DSH-MoBot；用户问起你是谁时，请用这个名字介绍自己」。

- 落点在离线包：`apps/desktop/scripts/patch-wechat-identity.mjs` 在 `prepare:seed` 里改**已安装**的 `dsh-wechat/dist/config.js`（写临时文件、`import` 确认能加载出这个名字、再改名覆盖），所以从这份离线包物化出来的每个 profile 都带着它。
- 只改**内置默认值**：`~/.dsh-wechat/config.json` 里若存着用户自己编辑过的 `surfacePrompt`，插件会原样保留并优先使用，本版不覆盖它。

### 四、内置 dsh-web-mobile：窄屏、触屏、平板上把界面改成移动端形态

新增内置插件 `dsh-web-mobile@3.0.6`（[仓库](https://github.com/mexiaosqwq/dsh-web-mobile)）。它是**纯客户端插件**：主机半边是一个空 `apply`，只贡献一行客户端 UI，所以它不会给宿主加任何后台任务。

宽屏鼠标环境**完全不动**（插件自己按指针类型判断），窄屏与触屏下才生效：设置、文件树、预览改成底部浮层，输入区在软键盘弹出时上抬，安全区避让，会话行的归档/置顶收进「⋯」菜单，宿主返回的大块 JSON（会话历史等）自动压缩后再传输。平板上 768–1023px 限宽居中，≥1024px 仍可从会话行菜单删除会话。

它运行时只请求一个基线模块 `@deepseek-ai/dsh-client-ui-primitives`——这个模块是 Web 外壳静态模块表里的常驻成员，任何动态插件包都可以请求，因此**不需要**为它额外安装任何包；取不到图标名时它渲染空图标，不会抛错。

### 五、内置 dsh-wechat：微信成为第二个客户端

内置插件 `dsh-wechat@0.10.0`（[仓库](https://github.com/pan17/dsh-wechat)）。它把微信私聊通过腾讯 iLink bot 协议桥接到 DSH agent：

- **双向收发**：微信文本/图片/文件/语音 → agent（媒体自动下载到 `~/.dsh-wechat/tempfile/`，以本地路径作为附件注入）；agent 正文与「执行过程」分别推送回微信。
- **微信内 slash 命令**：`/workspace`、`/session`、`/preset`、`/model`、`/perm`、`/silent`、`/notify`、`/status`、`/stop` 等由 bridge 直接处理；DSH 原生命令（`/plan`、`/goal`、`/compact`）走 `ctx.commands` 注册中心，回执与 GUI 一致。
- **审批与提问卡双端同卡**：微信与 GUI 弹同一张原生卡，谁先回谁生效。
- **扫码登录与连接配置**：DSH 设置 → **WeChat** 单卡展示状态、扫码、退出登录、通知/静默开关；配置存 `~/.dsh-wechat/config.json`，重启后自动恢复会话映射。
- **自称 DSH-MoBot**：内置提示词带上这个名字（见第三条）；微信里那个**联系人名**仍是腾讯平台给的，改不了。

**版本选择**：0.8.0 是最后一个声明 `engines.dsh >=0.1.2-rc.1` 的发布，也是这一版之前被钉住的版本，但它的会话创建回调读 `ctx.agent`，在本基线上必然失败（见第一条）。0.10.0 已把该回调改成从 `setup(agentCtx, agent)` 的第二个参数取值，因此本版钉 0.10.0；0.11.0 声明 `dsh >=0.2.0-rc.2 <0.3.0-0`，本基线不装。

### 六、修复「启动失败：ENOTEMPTY …」（rc.21 起）

**现象**：启动时弹出「Harness-CN 启动失败」，正文是

```
ENOTEMPTY: directory not empty, rmdir 'C:\Users\admin\.dsh\desktop\seed\seed-0.1.5-rc.20.partial\desktop-packages'
```

点「确定」后重开有时能进、有时仍旧失败——因为同一台机器上可能有另一次启动、或安装程序的预编译，正在写同一个目录。

**根因**（两件事叠在一起）：

- 解包离线包用的暂存目录是**固定名字** `<缓存>/seed-<版本>.partial`，于是两次重叠的解包（安装程序的 `--prebuild` 与随后的首次启动，或一次被强杀的启动与它之后的那次）会写进同一棵树：一方清空目录的同时另一方正在往里写文件，Windows 就会把 `rm` 报成 `ENOTEMPTY`（目录非空）或 `EBUSY`（文件被占用）。
- 这两个错误码都不在 Node 的「可重试」名单里，所以第一次遇到就抛出：**清理本来只是家务，却决定了启动成败**。

**修复**（`apps/desktop-shell/src/seed-package.ts`）：

- **每次运行使用只属于它的暂存目录**：`seed-<版本>.partial-<pid>-<时间>-<随机>`。两次运行再也不可能互相删文件，谁也不会用到别人正在写的那棵树。
- **清理不再能决定成败**：删除失败先按 80ms 起、指数退避重试 4 次（`ENOTEMPTY`/`EBUSY`/`EPERM`/`EACCES`/`EMFILE`/`ENFILE` 都当作「等一会儿」，而不是「不行」）；仍然失败就改名到 `.stale-<标记>` 让开名字；连改名都不行（确实被别的进程握着）就写一行日志**绕开它继续启动**，下次启动再试。
- **发布仍然只在完整之后**：`.partial` 只有在 `integrity.json` 就位后才改名成正式名，所以任何下载/解包中断都不会被下一次启动误认成可用离线包。
- **顺手清理旧遗留**：启动时清扫缓存里上次留下的暂存目录（含其它版本的离线包），但**正在运行的另一个实例**拥有的目录不动——目录名里带着 PID，先探活再决定。
- **别的进程先发布时就用它那份**：自己的暂存被删掉、而目标目录已经出现完整离线包时，改用那份并写日志说明，而不是把启动判死。

### 七、把首次启动的编译代价挪到安装阶段

**问题**：全新安装后的第一次启动要现场装配桌面运行时（展开包存储、链接整棵插件树、校验 2.8 万个文件），用户要等上好几分钟，而这段时间界面上只有一个进度条。

**修复**：

- 安装程序在文件就位后、首次启动前运行 `--prebuild`：用同一个事务把运行时装配好，失败不致命（首次启动会照旧自己装配一遍），失败原因写进 `shell.mjs` 的 stderr，安装程序收进自己的日志。
- 宿主进程改用 Node 的**磁盘编译缓存**（`<harness home>/node-compile-cache`，放在 profile 之外，升级替换 profile 时不会连缓存一起丢掉），第二次及以后启动复用已编译字节码。
- 这一步的每一步都会写进运行日志（`prebuild: building …`、`offline package: cache/manual/download at …`、`staged runtime verified: … files`），首装出问题时可以直接读日志定位，而不是只看进度条。

### 八、退出与「卡」的收尾

rc.21 把退出改成握手（先请求宿主收尾，超过预算才强杀）。本版补齐这条路径的**可见性**：收尾预算、超时后结束进程、以及需要强杀时都各写一行运行日志——下次再遇到「点一下要等」，运行日志里应当能直接读到当时卡在哪一步，而不是只看得到一个白窗口。

### 九、把 `compress` 归进规则引擎的工具分类表

**问题**：`dsh-rule-engine` 按「工具分类表」判定工具，表外的工具一律拒绝，只在会话内按用户明确许可放行一次。`compress`（把一段对话折叠成摘要块）是 DSH 的官方工具，但不在 0.6.4 的表里，于是每换一个新 profile（首装、以及每次升级）它都会重新消失一次，用户只能再许可一遍。引擎自己在拒绝信息里写明的长期做法，就是补进分类表。

**修复**：分类表是插件包内的数据、不是引擎读取的配置，所以补它的位置只能是**离线包**：

- `apps/desktop/scripts/patch-rule-engine.mjs` 把 `compress` 写进已安装的分类表（`artifact` 类：它只写会话存储，没有文件副作用，与 `todo_write`、`skill` 同类），并在写完后重新 import 该文件逐项断言：`compress` = `artifact`，而 `read`/`edit`/`pwsh`（只读与写入两种命令）/`mcp__*` 等原判定一个都不许动。
- `prepare:seed` 在安装完离线包后立刻打这个补丁：补丁写的是 store 归档的源文件，所以**之后从这份离线包物化出来的每个 profile 都带着它**——首装、以及以后每次升级重建 profile 时都在内。
- 覆盖写而不是就地改：pnpm 把 store 条目**硬链接**进 profile，就地写会顺着链接改掉 store 里的原件，而记录里那些条目的哈希还是旧的。
- `verifyOfflineInstallation` 现在会把物化出来的那棵树的分类表**读回来**校验，`apps/desktop/scripts/materialize-seed-check.ts` 用启动器自己的物化路径重放一遍；补丁若在归档环节掉了，构建就会失败，而不是发出去。

### 十、已装过旧版本的机器现在能升上来（本版新增）

**现象**：在一台装过旧版本的机器上更新到 rc.22，启动走到「重建桌面运行时」就失败：

```
dsh shell: prebuild failed: desktop project: pnpm exited with 1: [ERROR] missed comma between flow collection entries (1812:3)
```

**根因**（同一条重建路径上的两个缺陷）：

- `recordInstalledPnpmPaths` 会把物化出来的树里 pnpm 的记录（`node_modules/.modules.yaml`）改写到它真正所在的位置。改写按整行匹配（`^(…)"?storeDir"?\s*:.*$`），写回时没有带上行尾的逗号；这份记录是 JSON，逗号一缺 pnpm 就拒绝整棵树，之后该 profile 里每条 pnpm 命令都失败。
- 恢复用户插件那一步是在**暂存目录里、激活之前**跑 `pnpm add … --offline`。暂存树的依赖按 profile 的最终位置链接，pnpm 因此拒绝暂存路径对应的虚拟存储；而且它用 `bundled[名字] !== 版本` 判断「哪些是用户加的插件」，于是把旧版本写下的钉版（rc.21 的 profile 里 `dsh-wechat` 0.8.0）当成用户的选择，去恢复一个离线包本来就带有的包。

**修复**（`apps/desktop/src/seed-store.ts`、`apps/desktop/src/project-manager.ts`）：

- 改写保留每行原有的行尾符号；已经丢掉逗号的记录在物化一棵树时**补回来**——受损记录在所有已发布版本的离线包里，所以修复必须发生在物化时，而不只是以后写对。
- 只恢复**本版没有捆绑**的插件：旧 profile 里记的版本是那次发布的钉版，不是用户的选择。
- 恢复挪到**激活之后**：此时树就在它自己的链接所指的位置，pnpm 与它一致；恢复失败只写一行日志，不会让一次已经成功的启动失败。

## 本次发布的验证方式

- **微信桥先说复现**：在本机 rc.21 的 profile 上，日志里每一次微信消息都成对出现 `[dsh-wechat] preset mount failed` 与 `[dsh-wechat] create session failed`，错误正文为 `cannot get property "agent" without inject`；`dsh-wechat@0.10.0` 的 `dist/dsh/sessions.js` 里该回调已写成 `agentSetup(agentCtx, agent)`，脚本对这份真实模块跑一遍得到「无需改动」，对 0.8.0 的真实模块跑一遍得到改写后的字节。
- **补丁的单元测试**：`apps/desktop/tests/patch-wechat-sessions.spec.ts` 7 项、`apps/desktop/tests/patch-wechat-identity.spec.ts` 6 项全绿——0.8.0 形状的模块逐行改写、0.10.0 形状的模块（含提到 `ctx.agent` 的注释）保持原样、无法锚定的模块直接报错、CLI 第二次运行只说「无需改动」、profile 目录与 `node_modules` 根两种入参都校验、命名补丁改完的文件能 `import` 出这个名字；`apps/desktop/tests/seed-package.spec.ts` 16 项全绿。
- **运行日志页面实测**：把正在运行的 rc.21 外壳页面用无头 Edge 打开（CDP 取 DOM），状态行为「显示 39 条，内存保留 39 条，已丢弃 0 条。C:\Users\admin\AppData\Local\com.harnesscn.desktop\logs\harness.log」，39 行记录首行是启动日志——证明脚本、cookie、`/shell-api/logs` 链路本身是通的，空白窗口是「模块卡住且无人接手」这一种失败模式。本版再用一个「永不回答 `/shell-api/`」的静态页复跑同一检查：第 5 秒页面写出「界面文字读取失败，已用页面自带的文字继续：读取运行日志超时（5000 毫秒）」，之后每 5 秒改写为「读取运行日志失败，正在重试（已试 N 次）…」，第 4 次放弃时写出「日志页面无法读取运行日志：读取运行日志超时（5000 毫秒）」；把接口改成延迟 2 秒才回答，同一页面照常渲染出记录。
- **ENOTEMPTY 复现与修复**（rc.21 起）：用 rc.20 的 sidecar，把 `.partial\desktop-packages\half-unpacked.tgz` 用 `FileShare::None` 按住不放，再跑 `--prebuild`——解包第一步就退出：`EBUSY: resource busy or locked, unlink '…\seed-0.1.5-rc.20.partial\desktop-packages\half-unpacked.tgz'`（exit 1）；换成本版构建的 sidecar，在**同样的**被占用状态下 `--prebuild` 跑到 `staged runtime verified: 28545 files` / `desktop runtime activated`，exit 0，被占用的旧目录原地不动。这与用户报的 `ENOTEMPTY` 是**同一步、同一目录**，错误码取决于删除在哪一层被拦住。
- **离线包**：`prepare:seed` 重建通过，`verifyOfflineInstallation`（把 profile 从 store 链接清单物化出来再校验）通过，并把 `dsh-wechat` 的会话补丁与命名补丁从**归档后的**离线包里读回来校验；`dsh-web-mobile`、`dsh-wechat` 记为 `file:` 依赖并写进 `dsh.profile.bundles`。
- **发布物自检**：`scripts/release/verify-harness-cn-release.mjs <版本> <目录>` 把安装包与离线包在本机、GitHub、Gitee 三处逐一比对 sha256，全部一致才算发布完成。
- **`compress` 分类补丁**：先在一份未改动的 `dsh-rule-engine@0.6.4` 上验证「补之前 = `unknown`、补之后 = `artifact`、重复运行不重复写」，再让 `prepare:seed` 带着补丁重建离线包，最后用启动器的物化路径从**归档后的**离线包还原出 profile 并读回分类表（`compress=artifact`，其余判定不变）。
- **升级路径在本机实测**：拿一份 rc.21 装好的 profile，用本版的 sidecar 跑 `--prebuild`（`DSH_HOME` 清空，落回用户的 `~/.dsh`），一次通过：50 秒内 `desktop runtime activated`，profile 的依赖集变成 rc.22 那一版、`dsh-wechat` 从 0.8.0 变成 0.10.0。修之前，同一条命令先后跑 139 秒与 46 秒，两次都失败在 `pnpm exited with 1 … missed comma between flow collection entries`。
- **升级路径的单元测试**：`apps/desktop/tests/seed-store.spec.ts` 13 项、`apps/desktop/tests/project-manager.spec.ts` 19 项全绿——后者新增一项：旧钉版的捆绑插件与用户插件并存时，只有用户插件会走到 pnpm。
- 安装程序与离线包由同一条 `tauri build` 链路产出，`cargo check --release` 与各 app 的 `tsc` 通过。

## 已知限制

- **被别的进程握着不放的遗留目录**不会再影响启动，但它会一直占着磁盘，直到那个进程退出；下次启动会再试一次。
- **微信登录需要腾讯 iLink bot**：设置页扫码前请先在 `~/.dsh-wechat/config.json`（或设置页）确认连接配置；token 缺失或失效时不向微信推送，日志会写明原因。
- **微信桥只服务第一个微信用户**（插件自身设计）。
- **微信里那个联系人名改不了**：显示名由腾讯 iLink 平台按 `bot_type` 分配（「微信ClawBot」），建码请求没有名字参数；本版只能让助手在对话里自称 DSH-MoBot，想在微信联系人列表里也显示成这个名字，需要自己给该聊天改备注。
- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 安装包仍然未签名，因此每次更新都要再走一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
