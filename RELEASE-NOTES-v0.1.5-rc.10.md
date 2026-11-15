# Harness-CN 0.1.5-rc.10（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版内置两个新的社区插件，并把两个共享底层库抬到插件所要求的版本。

> **关于版本号**：本发行版的 `0.1.5-rc.10` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.10_x64-setup.exe` | 26.54 MB（27,830,239 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.10.tar.zst` | 78.69 MB（82,513,239 字节） | 离线包：Node 24.17 + pnpm 11.7 + 插件树 + 预热的包存储 |

SHA-256：

```
4D1EE20A4B09BDC2427A8B8B0E50F7D58E49F7504C934DB48A63315C39B3516D  Harness-CN_0.1.5-rc.10_x64-setup.exe
078DC6E770BBD566BCC7D93592E8FE59B68C2596559315850405801F844B1C1F  Harness-CN-seed-0.1.5-rc.10.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

> 离线包从 71.45 MB 涨到 78.69 MB（新增插件的完整依赖闭包）。Gitee 单附件上限是 100 MB，
> **余量还剩 21.3 MB**；再内置两三个同量级插件就会顶到上限，届时需要把离线包拆成多个附件。

## 本版改动

### 一、内置 `dsh-defend`（提示注入 / 越狱 / 密钥外泄防护）

`dsh-defend@0.3.21`，Apache-2.0。它在**官方 seam** 上拦截三个点并给出 allow / ask / block 裁决：

| 拦截点 | 扫描对象 | 动作 |
| --- | --- | --- |
| `agent/pre-step` | 入站用户消息 | allow → `next()`；ask → 转审批；block → 拒绝该步 |
| `tools/pre-execute` | 工具参数 | allow → `next()`；ask → 转审批；block → 拒绝 |
| `tools/post-execute` | 工具结果 | allow → `next()`；ask → 转审批；block → 回注纠正反馈 |

另有一条**危险递归删除门禁**：递归删除类 shell 命令一律拒绝，除非每个目标都是会话工作区内、
且不在受保护前缀（家目录配置、`.dsh`/`.claude`、系统目录）里的绝对路径。`-WhatIf`、`--dry-run`、
`git clean -n` 这类干跑标记放行——它们本就是这条规则要求的那种检查。

它的 peer 区间 `>=0.1.5-alpha.1 <0.2.0` 覆盖本发行版的 `0.1.5-rc.9`，实测已挂载为
`include:dsh-defend(active)`，`/defend` 命令与 `defend_report` 工具随之可用。

**这一线上的一处已知降级（上游文档亦如此说明）**：`defend/detection` 审计事件需要一个
`ignorable` 标记，而本基线（以及上游已发布的各条线）的 `Session.append` 无法打上它；
该类事件若未标记地写进会话日志，会让会话在更严格的宿主上无法恢复。因此插件**主动停用会话日志审计**
并告警一次，而不是写出会损坏会话的事件。**检测与拦截不受影响**，只有审计留痕被停用。

### 二、内置 `@goodandready/dsh-time-machine`（工作区快照与一键回滚）

`@goodandready/dsh-time-machine@0.1.22`，MIT。它在后台用**影子 git 快照**记录工作区，
不碰你的提交历史、不碰当前分支、也不碰暂存区；出问题时可以整树或单文件回滚，
并带可视化 diff。工具面（7 个）包括 `time_machine_checkpoint_create` / `_list` / `_rollback` /
`_diff` / `_delete` / `_prune` 与单文件回滚，另有右侧栏时间线页签。

**为什么钉在 0.1.22 而不是最新的 0.1.28**：它从 **0.1.23 起**把 peer 改成
`^0.1.7-rc.2 || ^0.2.0-rc.1`——那是本产品没有的版本线（基线是上游 `dsh-v0.1.5-rc.1`）。
0.1.22 声明 `^0.1.0-rc.6`（tools / settings / host-webserver 三者），`0.1.5-rc.9` 正好满足，
实测已挂载为 `include:dsh-time-machine(active)`。0.1.23+ 相对 0.1.22 的新增能力
（单文件回滚、暂存区隔离、diff 弹窗的文件浏览、pre-tool 自动检查点等）**本版不含**。

### 三、共享底层库升级：`cosmokit` 1.8.3 → 1.8.5、`schemastery` 3.18.2 → 3.18.4

这一项**不是可选的**：多个已发布插件依赖 schemastery 的 **volatile 配置引用协议**——
让设置界面把某个字段渲染成"实时可编辑控件"，而该字段不进入 profile 的持久化配置。

`@xbzbing/dsh-git-panel` 在 3.18.2 上就是硬失败：

```
failed to load ... git-panel (@xbzbing/dsh-git-panel):
Schema.boolean(...).default(...).volatile is not a function
```

`@jieai/dsh-plugin-vet` 与 `@goodandready/dsh-time-machine` 也都声明 `^3.18.4`。
schemastery 的 3.18.4 清单把 cosmokit 钉在 `~1.8.5`，而 `createVolatile` 正是 1.8.5 才导出的
（1.8.3 没有），所以两者必须一起抬。

**改动面是可控的**：cosmokit 只有 3 个文件变化（新增 `volatile.ts`、`index.ts` 加一行导出、
`types.ts` 学会把两个 volatile 引用判为相等），另外四个源文件逐字节相同；schemastery 是单文件源码，
`.volatile()` 与配套的 `validateVolatileSchema` 都在其中。两个包都是 patch 级、向上兼容。

**注意**：它不能靠"给 3.18.2 补一个空方法"绕过——3.18.4 的 `.volatile()` 与
`validateVolatileSchema` 校验器成对工作，只补标记会在校验时报错。

升级后实测：既有插件（acp / hindsight / modlens / vet / cost-meter / chat-import / rule-engine）
全部仍为 active，共 167 个组合条目，无回归。

### 四、关于 `@xbzbing/dsh-git-panel`：本版**未**内置

你给的第三个插件是 `@xbzbing/dsh-git-panel`（MIT，IDE 风格 Git 面板）。本版**没有内置它**，
原因不是上面那个共享库——那个已经修好了——而是它还有一个**独立的硬阻塞**：

它的客户端半边声明依赖 `@deepseek-ai/dsh-client-ui-primitives`，而在本基线上这个包
**根本没有浏览器半边**：

| 包 | `exports` 里有 `./client` | `dsh.client` 声明 |
| --- | --- | --- |
| `dsh-client-ui-conversation`（可加载的浏览器模块） | ✅ | ✅ `platform: web` |
| `dsh-client-ui-primitives`（本基线的） | ❌ 只有 `default` 入口 | ❌ 无 |

也就是说它在本线上是纯 React 组件库，从未被声明为客户端模块——这正是 git-panel
**全部 15 个已发布版本**都要求 `dsh >= 0.1.7-rc.2` 的原因。

**为什么没有强行装上去**：把 share 库补好之后，它的 host 半边确实能加载了，但客户端半边
仍会因为找不到那个模块而失败。硬要让它跑，需要给它补一个浏览器半边（或改写它的客户端加载方式），
那已经不是"改必要的兼容点"，而是替它实现一个新的客户端模块——按你先前定的范围，我没有做。

## 已知限制

- 安装包**未签名**，SmartScreen 会拦一次；按用户安装，不需要管理员权限。
- 需要 **WebView2**：Windows 11 自带，Windows 10 由安装包自动补装。
- 升级到本版后**第一次启动会重建运行时**（约 2 分钟，界面有逐步百分比）；之后每次约 15–20 秒进入工作区。
- 离线包距 Gitee 100 MB 附件上限余 **21.3 MB**。
- `~/.dsh` 与 `dsh` CLI 共用；同一台机器上混用其他构建会互相覆盖 profile 与 store。

## 本次发布的验证方式

- **插件挂载实测**：在本机安装 rc.10 后，向运行中的宿主查询插件清单，确认
  `include:dsh-defend(active)` 与 `include:dsh-time-machine(active)`，共 **167 个组合条目**；
  既有插件（`compaction-acp`、`hindsight`、`modlens`、`plugin-vet`、`cost-meter`、
  `import-claude`、`dsh-rule-engine` 三项）全部仍为 active——共享库升级没有回归。
  `dsh-vault` 仍未进默认组合（它需要 `DSH_VAULT_PASSWORD`，属上一版既定设计）。
- **共享库产物按字节核对**：`deepseek-ai-cosmokit-1.8.5.tgz` 与
  `deepseek-ai-schemastery-3.18.4.tgz` 内确实含 `createVolatile` / `isVolatile` /
  `.volatile()` / `validateVolatileSchema`。
- **构建链**：`vendor` 两包 `pnpm run build:lib:host` 通过；`prepare:package` 产出
  `desktop seed: recorded 27953 profile files as store links`（较 rc.9 的 27,621 增加 332，
  即两个新插件及其依赖闭包）；`tauri build` 产出安装包。
- **编码核对**：升版脚本以 UTF-8 读写，`tauri.conf.json` 与 `Cargo.toml` 的中文（"水哥"等）完好、无 BOM。
