---
description: "dsh Web 客户端桌面发行版专用的 DeepSeek 账户设置行：带实时阶段状态的登录、两行余额、经确认的赠送额度提示，以及退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account-harness

[English](README.md) | 中文

## 概述

**账号与余额**是桌面发行版的 DeepSeek 账户界面：设置中的一行，负责登录、展示两行余额、呈现赠送额度，以及退出登录。它经 `ctx.slots.inject()` 注册一个 `settings.section` 贡献，因此只在桌面宿主各行为 `remote.account` 提供来源时出现，其余位置什么都不做。这一行本身就是完整界面——没有标题、说明或常驻文案——它渲染的一切，包括进行中的登录阶段与提示卡片，都是该分区自身挂载所持有的快照订阅。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

**账号与余额**行是设置中的一行，也是桌面发行版上的整个账户界面：它本身就是接口，没有标题、说明或其他常驻文案，只渲染当前持有的状态与该状态提供的唯一操作。

### 未登录

未登录时，该行提供登录，调用 `startSignIn(client, window.location.origin, 'desktop')`——当前页面源成为回跳地址，`'desktop'` 选择桌面客户端类型。当一次尝试报告阶段（`initializing`、`waiting-browser`、`exchanging`、`committing`、`expired`）时，状态行取代该操作，并提供取消；没有进行中的尝试时，该行只显示登录操作。当一次尝试进入 `waiting-browser` 时，该行会在新窗口中打开它的 `authorizeUrl` 一次——账户服务只产生该 URL，没有别的组件去打开它——并在状态行旁保留一个 `open` 链接，供拒绝该自动请求的载体使用。

### 已登录

已登录时，该行显示两行余额——充值余额与赠金余额——赠送钱包按正余额过滤，随后是账户状态携带的平台链接（`usageUrl`、`topUpUrl`），最后是退出登录。退出登录先询问宿主的 `hasRunningAccountTasks()`，再根据答案选择三者之一的确认文案，因此点击退出登录不会承诺超出宿主所能确认的内容。

### 赠金提示

未通知的赠金在账户进入已登录状态时读取一次，在分区挂载时再读取一次——从不按定时器读取。第一条会渲染为非模态卡片，其文案就是服务端自己的 `message`；`expiresAt` 已过的提示会被丢弃，而不是迟到展示。展示卡片会按订单恰好排队一次确认（`ackBonusNotified(accountId, orderId, client)`），确认成功后会刷新余额。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该分区是一份快照的纯渲染：`src/client/AccountSectionController` 持有一个 `SnapshotStore<AccountSectionState>` 并订阅账户状态流，因此视图不会偏离收到的状态。

### 注册

浏览器插件注册一个 id 为 `account`、`order: -10`、`locale: 'settings.account'` 的本地化 `settings.section` 贡献；其 label 为 `nav` 键。注册经 `ctx.slots.inject('settings.section', ...)` 完成，`inject = ['slots', 'locale', 'remote', 'remote.account']`，因此能跟随延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。这里没有产品门禁：账户宿主包缺席时 `remote.account` 不会出现，插件什么也不做。上游 Client 包（`@deepseek-ai/dsh-client-ui-settings-account`）注册进 `settings.launcher`、`settings.models.sign-in` 与 `shell.quota-notice`，这些都不在本线 slot 注册表声明的范围内，因此本线拥有自己的浏览器半边。

### 状态与生命周期

`AccountSectionState` 携带 `view`、`profile`、`balance`、`failed`、`busy` 与 `notice`；控制器通过 `account.watch` 上的 `ctx.remote.$stream` 填充它。分区渲染该快照，只持有一处本地状态，即退出登录确认。所有订阅都活在插件注入的回调里，因此卸载分区会取消其数据流与重试。

### 确认

确认是由挂载拥有的重试循环：只要分区仍处于挂载状态，就会尝试 `ackBonusNotified`，延迟从 1000 ms 逐步翻倍到 60 000 ms 上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖本行注册进的 Settings 领域、其背后的 Remote 表面、与它并列的同类行，以及其文案解析所经的本地化层。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 的领域底座。
- [api-remotes](../../api/remotes/README.zh.md)——`account.watch`、`startSignIn` 与 `ackBonusNotified` 背后的 Remote BFF 表面。
- [ui-settings-general](../ui-settings-general/README.zh.md)——用同一套 primitive 与本地化约定构建的同类 Settings 行。
- [locale](../locale/README.zh.md)——`settings.account` 文案解析所经的字典层。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置行，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述该行在桌面发行版上的行为；它们是当前包约束。

- **Electron 开发外壳中的外部链接**——已发布的 Tauri 外壳把页面的新窗口请求交给平台浏览器（只放行 `http` 与 `https`，从不放行 loopback），因此一次尝试进入 `waiting-browser` 后该行打开一次的 `authorizeUrl`、以及 `usageUrl`/`topUpUrl` 链接，在已发布应用中正常打开；开发所用的 Electron 外壳拒绝每一个新窗口（无论是自动打开还是点击），因此授权页在那里始终不会出现，只剩状态行旁的 `open` 链接。
- **尽力而为的确认**——失败的 `ackBonusNotified` 只在分区保持挂载期间重试，因此过早关闭分区会让该额度保持未通知（安全的方向）。
- **退出登录确认依赖一次宿主读取**——`hasRunningAccountTasks()` 失败时，未知情形会用更弱的断言提出同一个问题，而不是阻塞退出登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

提供 `remote.account` 的宿主各行——`authorization`、`deepseek-account` 与 `account-controller`，版本 `0.1.7-rc.2`——由 `apps/desktop-host/config/desktop.cordis.patch.yml` 插入，属于桌面补丁层而非 bundle 补丁，因为这些包只由 Desktop seed 安装；`deepseek-account` 从 `process.platform` 推导 `desktopPlatform`。

</details>

**运行时不变式：** 不发布伴生入口。本包只持有一个桌面专用 Settings 贡献。
