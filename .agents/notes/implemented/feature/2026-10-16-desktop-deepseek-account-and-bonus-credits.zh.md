# Agent Note: The desktop signs in to a DeepSeek account and grants its bonus credits

Status: implemented

[English](2026-10-16-desktop-deepseek-account-and-bonus-credits.md) | 中文

## Problem

Harness-CN 的桌面包此前没有任何账号面：用户无法用 DeepSeek 账号登录，无法看到账号持有的余额，也无法领取平台赠送的赠金。npm 上的官方账号包恰好带着这一整套界面，所以问题从来不是「要不要自己写平台客户端」，而是「哪个上游发行版能在本线跑起来、其中哪一半能在本线渲染」。

带赠金读取与确认的发行版是 `0.1.7-rc.2`：`getUnnotifiedBonuses` 与 `ackBonusNotified` 在更早的包里都不存在（`0.1.7-alpha.1`、`alpha.2`、`rc.1` 全都没有）。这个发行版与本线之间隔着三个障碍，每一个都是实测出来的，而不是假设的：

- 它生成的 typert 清单用 `create()` 工厂描述 codec schema，本线的 loader 会以 `parameter codec is not backed by a zod v4 schema` 拒绝它，并让整棵插件树失败。[已单独修复](../architecture/2026-10-16-typert-codec-schema-forms.zh.md)。
- 它的 peers 声明为 `^0.1.7-alpha.1`（`dsh-authorization`、`dsh-credentials`、`dsh-host-webserver`、它自己的基础包、`dsh-typert-protocol`），而 profile 携带的是 `0.1.5-rc.26`。profile 的 workspace 设了 `autoInstallPeers: false`，所以 pnpm 只警告、不会在旁边装第二份 seam；而这些包调用的 API 正是本线已有的那些。
- 它的**浏览器半边在这里根本没法出货**。上游客户端把行注册进 `settings.launcher`、`settings.models.sign-in` 与 `shell.quota-notice`；本线的客户端只有 `settings.section` 与 `shell.overlay`，所以包装上了却渲染不出任何入口。`0.1.7-rc.2` 的构建还额外注入本线没有的 `configForms` 服务，并且整个 apply 都以 `"dshDesktop" in globalThis` 为门禁。

## Decision

宿主半边用上游，浏览器半边我们自己写。

**宿主。** `@deepseek-ai/dsh-deepseek-account-platform` 与 `@deepseek-ai/dsh-api-account-controller` `0.1.7-rc.2` 以 `active: false` 的内置插件身份进入桌面种子，`@deepseek-ai/dsh-deepseek-account` `0.1.7-rc.2` 声明为它们的运行时依赖（它是 peer，pnpm 不会代它们安装）。四行把它们挂起来——`authorization`、`deepseek-account`（`desktopPlatform` 由 `process.platform` 推导）、`account-controller`，以及我们的客户端包——挂载点是 `apps/desktop-host/config/desktop.cordis.patch.yml`。那是唯一能点名它们的层：这些包只由桌面种子安装，而共享的 bundle 补丁会被所有 profile 加载，在那里 insert 一个不存在的包会让整棵树失败。这些行不列入 `dsh.profile.bundles`，因为这些包都没有声明 `dsh.bundle.patch`，而 `inspectPlugin` 对列入 bundles 的项有此要求。

**浏览器。** `packages/client/ui-settings-account-harness` 自己挂载生成的 Remote 贡献——`import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote'`，然后在 `apply` 的第一句 `await ctx.remote.$mount(accountRemote)`，并把它注册为**第一个** effect，好让 Cordis 在状态流与读它的那一行之后才回收命名空间——并且只注册一行 `settings.section`（`id: 'account'`、`order: -10`）。它注入的是 `['slots', 'locale', 'remote']` 而不是 `remote.account`：本线的客户端装配（`packages/api/remotes/src/client/index.ts`）只挂载十五个固定贡献、其中没有 account，等这个名字会永远等下去，而且这个等待本就是自指——提供它的正是这段 `apply`。挂载一个 Host 并不服务的命名空间不会让启动失败：`validateContribution` 只校验贡献自身的描述符与已挂载的命名空间，从不核对 Host 的脸，所以账号栈缺席只表现为一次失败的读取，由那一行渲染出来。因此这个插件不设自己的产品门禁，而上游客户端改以 `"dshDesktop" in globalThis` 门禁整个 apply，本线出货的 Windows 载体（Tauri 外壳）并不暴露它，那行会在它本为之而写的产品里始终不渲染。这一行就是界面本身：没有标题、说明或其他常驻文案，只有在登录尝试自报阶段（`initializing`、`waiting-browser`、`exchanging`、`committing`、`expired`）时才打印一行状态。未登录时，这一节提供登录（`startSignIn(client, window.location.origin, 'desktop')`），以及相位进行中的取消。已登录时，它把余额分成两行显示——充值余额与赠金余额——并给出账号状态携带的平台链接（`usageUrl`、`topUpUrl`）和退出登录（退出前先调 `hasRunningAccountTasks()`）。离开产品的链接由载体打开、而不是就地跳转，两个载体在这里并不一样。出货的 Tauri 外壳把页面发出的新窗口请求交给平台浏览器处理（`on_new_window` → `open_in_browser`，只放行 `http`/`https` 且拒绝回环地址，因此 `<a target="_blank">` 不会成为替换外壳自身页面的途径），这两个平台链接即由此到达用户，登录尝试的 `authorizeUrl` 也由此打开：账户服务只产生该 URL、自己不打开任何东西，因此一次尝试进入 `waiting-browser` 时由该行在新窗口里打开它一次——以 attempt id 为键，因为状态流每一帧都会重发——并在状态行旁保留一个 `open` 链接，供同样拒绝该自动请求的 Electron 外壳使用。本仓库开发所用的 Electron 外壳则拒绝同一请求（`setWindowOpenHandler` 返回 `deny`，`will-navigate` 只放行 `dsh-app:`），所以这些链接只在开发载体里点不动。

**赠金。** 未通知赠金只在账号进入登录态时读一次、在设置节挂载时读一次，绝不按定时器读。第一条未通知赠金渲染成一张非模态卡片，文案就是服务端给的 `message`，原样渲染；`expiresAt` 已过的直接丢弃、不展示。展示即排队对该订单号的一次确认（`ackBonusNotified(accountId, orderId, client)`），在该节仍挂载期间以 1000 ms 起、逐次翻倍、上限 60 000 ms 的延迟重试；确认成功会刷新余额，因为平台给出的答复可能改变账号持有的内容。这一节需要的所有订阅都放在插件注入的 hooks 里，因此一节被卸载时它的订阅流与重试一并取消。

客户端在每次调用时传入平台要求的元数据——客户端版本、当前界面语言、UTC 偏移秒——由这些包推导请求头（在桌面宿主下 `x-client-platform` 是 `desktop-win`/`desktop-mac`）。协议、PKCE 流程、端点 URL（`/api/v0/users/get_unnotified_bonuses`、`/api/v0/users/ack_bonus_notified`、`/auth-api/v0/users/current`、`/api/v0/users/get_user_summary`、`/auth-api/v0/users/logout`）与会话过期规则仍然由上游包拥有；本产品不重新实现它们。

## Alternatives considered

- 直接出货上游客户端包（`@deepseek-ai/dsh-client-ui-settings-account`）并让它渲染。它做不到：它注册的每一个 slot 在本线都不存在，这是 slot 注册表的性质，不是配置问题。
- 像仓库给第三方包（`dsh-wechat`、`dsh-rule-engine`）打补丁那样给上游客户端包打补丁。把 `"configForms"` 从它的 inject 列表里去掉、再给 onboarding 块加护卫，确实能让包装上，但那些入口依然没有 slot 可渲染，而且这份补丁在每个上游发行版上都要重新验证。
- 继续用 `0.1.7-alpha.1`，它的宿主包在本线本来就能装载。已否决：赠金读取与确认在那个发行版里不存在，而「登录后领取赠金」正是这个功能。
- 把这一节放进已有的第一方客户端包（例如 `ui-settings`）。这个界面需要只有桌面种子才安装的宿主包，于是其它每个 profile 都要携带死代码，客户端覆盖率门禁也会去覆盖其它 profile 根本执行不到的代码。
- 用定时器读未通知赠金，或者在渲染之前就确认。两者都因为同一个理由被否决——上游的行为之所以是现在这个形状：确认是关于「用户被展示过什么」的事实，轮询式的读取可能让同一笔赠金出现两次，或者确认一张从未画出来的卡片。

## Consequences

账号栈是用真实 profile 启动验证的，不是靠阅读代码。一个同时注入两个服务的探针报告出货路径在 15.4 秒就绪，且 `getState`、`getBalance`、`startSignIn`、`getUnnotifiedBonuses`、`ackBonusNotified` 全部存在；同一配置在 codec 改动之前于 16.1 秒失败。未登录 profile 上 `getState()` 返回 `{"status":"signed-out","attempt":null,"links":{"usageUrl":"https://platform.deepseek.com/usage","topUpUrl":"https://platform.deepseek.com/top_up"}}`，`getProfile()` 返回 null——未登录界面就是从这些值渲染的。

种子因此多出三个 npm 包，profile 多出它们的文件；无论用户是否登录，每次安装都要付出这份代价。赠金卡片的确认是尽力而为的：失败会在该节挂载期间重试，而在成功之前就关掉这一节的用户会让那笔赠金保持未通知状态——这正是安全的方向。

真实的平台登录与真实的赠金到账没有在这里演练：到达平台的是这些包自己的客户端代码，而这次验证的是它们能在本线挂载、暴露 Remote 面，并启动到就绪。
