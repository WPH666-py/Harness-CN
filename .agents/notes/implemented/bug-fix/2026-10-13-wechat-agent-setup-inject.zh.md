# Agent Note: dsh-wechat 通过 setup 上下文读取 agent

Status: implemented

[English](2026-10-13-wechat-agent-setup-inject.md) | 中文

## Problem

桌面 profile 直到 0.1.5-rc.21 都发行 `dsh-wechat@0.8.0`，它在创建每个微信会话时，用一个 `setup` 回调
把 agent 当作 setup 上下文的属性来读：

```js
async function agentSetup(agentCtx) {
    const ctx = agentCtx;
    const presets = ctx.get?.("agentPresets");
    if (presets) {
        try {
            await presets.mount(agentCtx, ctx.agent?.session?.header?.agentPreset);
```

Cordis 对该作用域上未声明的属性读取会返回 `Error: cannot get property "agent" without inject`。这次
mount 位于一个只记录失败的 `try` 内，而紧接着的
`const logged = ctx.agent?.session?.requestHeader?.()?.config;` 不在其中，于是该回调 reject，agent
工厂销毁构建到一半的 agent，`agents.create` 随即 reject。此后每条微信消息都收到
`⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。`，日志中依次出现
`[dsh-wechat] preset mount failed: Error: cannot get property "agent" without inject` 与
`[dsh-wechat] create session failed: …`。

已发布的包后来自己修好了这一点。`dsh-wechat@0.10.0` 把同一个回调写成
`export async function agentSetup(agentCtx, agent)`，读取 `live?.session?.header?.agentPreset` 与
`live?.session?.requestHeader?.()?.config`，并在注释里写明「DSH 0.1.5 removed `ctx.agent`; `setup`
now receives `(agentCtx, agent)`」。它声明的 `engines.dsh: >=0.2.0-rc.2` 是元数据，插件路径上没有任何
加载器强制它——在本基线上把它装起来，行会挂载、原生命令层与审批/提问 waterfall 应答器都会接上、扫码
登录也能走完——因此 profile 的钉版移到了它。`0.11.0` 不可用：它声明 `dsh >=0.2.0-rc.2 <0.3.0-0`。

## Decision

profile 钉住 `dsh-wechat@0.10.0`，这就是修复本身。`apps/desktop/src/bundled-plugins.ts` 承载该钉版与
理由；本分支没有任何地方配置这个插件。

`apps/desktop/scripts/patch-wechat-sessions.mjs` 保留下来，作为仍然解析到 `0.8.0` 的目录树的防线——
沿用旧离线包的 profile，或者钉版又滑回去的情况。它在
`apps/desktop/scripts/prepare-seed.ts` 构建离线包时修正该已安装模块。回调从 agent 工厂本来就传递它
的位置取值——`AgentSetup = (agentCtx: Context, agent: Agent)`，调用形式为
`setup?.(prepared.agent.ctx, prepared.agent)`——因此补丁把签名改为
`async function agentSetup(agentCtx, agent)`，并把两处读取改写为
`agent?.session?.header?.agentPreset` 与 `agent?.session?.requestHeader?.()?.config`。模块中其他内容
不变。

补丁先把修正后的字节写入临时文件，再用重命名覆盖该模块。pnpm 会把 store 条目硬链接进 profile，
因此就地改写会通过链接改写 store 副本，而 store 索引记录的仍是改写前的字节。

`prepare-seed.ts` 在生产安装之后、`archiveLinkedProfile` 之前运行该补丁，因此归档 store、链接清单，
以及 `verifyOfflineInstallation` 由它们物化出的目录树都带有修正后的模块；同一次构建会从物化出的
目录树重新读取锚点，一旦锚点缺失或未改变就让构建失败。该脚本既接受 profile 目录，也接受
`node_modules` 根目录，因此同一条命令也能修复机器上已存在的 profile。

锚点是精确匹配且失败即报。补丁先判断该模块是否真的把 agent 当作 setup 上下文的属性来读；不这样读的
模块——0.10.0 从回调的第二个参数取值——什么都不需要做。若确实读过、但读法不在补丁锚点覆盖的范围内，
构建会以它找不到的那一行中止，因为未打补丁的插件会在用户的第一条微信消息上失败，而不是在发布构建中
失败。

## Alternatives considered

**留在 `0.8.0` 上，只靠字节补丁。** 那是本修复最初的样子，它把修正绑定在某一版分发的确切文本上。
`0.10.0` 在自己的源码里写明了修正后的契约，因此钉版移了过去，补丁留下来当防线。

**钉 `dsh-wechat@0.11.0`。** 它需要 dsh 0.2.x，该 profile 无法安装。

**在插件自身的上下文上声明 `agent`。** setup 上下文属于 agent 工厂；插件若不发布新的构建就无法为它
添加注入，而那条升级路径正是本记录所否定的。

**由外壳在启动时修复 profile。** 每次启动都要改写一个 profile 文件，而且该修复位于本次发行所校验的
产物之外。把修正后的字节构建进离线包，可以在一处同时修好安装包、归档 store，以及由它物化出的每个
profile。

## Consequences

离线包仍携带一份对第三方分发文件的字节补丁，因此它能修好钉住 `0.8.0` 的目录树；在本版发行的
`0.10.0` 上，它读该模块、发现 setup 上下文上没有 agent 读取，于是什么都不改。修正一个 `0.8.0` 模块
每次构建离线包只多一次文件重命名，本身不引入任何运行时行为。

插件其余失败仍由各自的报告承担：登录超时、微信服务不可达、预设挂载被拒绝，仍走插件既有的消息。

`apps/desktop/tests/patch-wechat-sessions.spec.ts` 覆盖改写、对无法锚定模块的拒绝、未改动的 `0.10.0`
模块、针对已安装 profile 的命令行调用，以及对两种目录树形态的补丁后校验。
