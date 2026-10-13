# Agent Note: 微信桥在对话里自称 DSH-MoBot

Status: implemented

[English](2026-10-13-wechat-bridge-name.md) | 中文

## Problem

微信桥给每个绑定微信的会话注入一段提示词（`dsh-wechat-surface` 段），它的内置文本——`dsh-wechat/dist/config.js`
里的 `DEFAULT_SURFACE_PROMPT`——只说「你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式……」。
于是通过桥接聊天的助手没有名字可用，用户因此提出「在微信里显示的，要起名叫 DSH-MoBot」。

微信联系人列表里显示的名字不归桥接管：腾讯 iLink 平台按 `bot_type` 分配它，而创建 bot 的请求只带这一个参数
（`ilink/bot/get_bot_qrcode?bot_type=3`）。`dsh-wechat` 0.10.0 与 0.11.0 都是如此，腾讯官方
`@tencent-weixin/openclaw-weixin@1.0.2` 的 `login-qr.ts` 也构造同一个参数，因此没有可以填产品名的字段。

## Decision

本产品能定的名字，是桥接聊天时用的那个。`apps/desktop/scripts/patch-wechat-identity.mjs` 往已安装的内置
提示词末尾追加一句：

```
你在微信里的名字是 DSH-MoBot；用户问起你是谁时，请用这个名字介绍自己。
```

该脚本在 `apps/desktop/scripts/prepare-seed.ts` 里与会话补丁并列接线：在生产安装之后、`archiveLinkedProfile`
之前对已安装的树跑一遍，因此归档的 store、链接清单、以及之后从这份离线包物化出来的每个 profile 都带这句话。
同一次运行还会从物化出来的树上把名字读回来校验——内置提示词没带上它就构建失败。

改写后的字节先写到临时文件，`import` 确认它仍能加载且导出的提示词里有这个名字，然后才改名覆盖。临时文件后缀是
`.mjs`，因为加载器会拒绝解析它不认识的扩展名——否则这步验证还没开始就失败了。改名同样是为了不让 pnpm 硬链接进
store 的那一份失真，与会话补丁同理。

这只是内置默认值。`~/.dsh-wechat/config.json` 里可能有用户自己编辑过的 `surfacePrompt`，插件会原样保留该值，
只有与某个已被取代的内置值相同的存储值才会被丢弃——所以编辑过的提示词继续生效，本补丁不会覆盖它。

## Alternatives considered

**在平台侧改 bot 名字。** 平台自己的 SDK 不接受名字参数，没有可发的字段。

**在离线包里放一份默认的 `~/.dsh-wechat/config.json`。** 该文件在 harness home 里，不在离线包物化出来的
profile 里，离线包没有地方放它。

**Fork 这个插件包。** 缺口只是一个提示词字符串；fork 之后要跟住上游每一次发布才能维持一行差异。

**让外壳在启动时写配置。** 那样每次启动都会从发布物验证范围之外改写用户状态，而且会覆盖的正是用户编辑过的
那个提示词。

## Consequences

从这份离线包物化出来的每个 profile，其微信桥都会自称 DSH-MoBot；用户编辑过提示词的则保留自己的文本。微信联系人
列表里显示的仍是平台给的名字；发行说明写明了这一点，并指向微信自己的改名入口。

补丁锚在一个导出上，找不到时构建失败：插件将来若改名或重构 `DEFAULT_SURFACE_PROMPT`，会在发布运行里停下来，
而不是悄悄发出一个没有名字的桥接。

`apps/desktop/tests/patch-wechat-identity.spec.ts` 覆盖改写、第二次运行的幂等、无法锚定时的报错、对已安装
profile 跑命令行、两种入参形式的校验，以及完全没有 `dsh-wechat` 的树。
