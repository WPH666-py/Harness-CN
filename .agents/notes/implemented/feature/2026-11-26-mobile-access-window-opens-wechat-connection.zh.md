# Agent Note：移动访问窗口默认打开微信连接页

Status: implemented

[English](2026-11-26-mobile-access-window-opens-wechat-connection.md) | 中文

## Problem

「移动访问」窗口渲染的是 `apps/desktop-shell/rsc/lan.html`：一个局域网开关、一张二维码、一条配对链接和一个重新生成按钮。而本产品实际使用的手机入口是微信桥（`dsh-wechat`）：用户通过微信配对手机，插件本身已经有完整的设置页——登录状态、Bot id、`cwd`、`cardTimeoutMs`、跨会话开关、渠道提示词、保存配置、重新扫码、退出登录以及平台限制说明。两个独立的配对界面意味着要改两处，而且菜单项并没有指向用户真正会去配置的页面。

## Decision

`lan` 菜单项改为在工作区页面打开 `/?settings=wechat`，窗口尺寸 1120×820。设置外壳（`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`）在挂载时读取一次 `?settings=<id>`，并以该分区打开设置对话框；参数缺失或为空时保持原有的关闭状态。id 就是插件注册的那个（`wechat`，见 `dsh-wechat/dist/client.js`），因此窗口渲染的是插件自己的页面，并随插件版本一起更新。

在该分区注册之前，面板沿用已有的回退逻辑先显示第一行；账本条目到达后自动切到 `wechat`，因为 `SettingsRoot` 每次渲染都会用实时的 `settings.section` 行投影当前激活 id。

局域网门本身未改动：`apps/desktop-shell/src/lan-access.ts` 仍然持久化开关和密钥，`/shell-api/lan*` 仍然提供链接和二维码。只是外壳窗口不再展示它们，手机能否访问由已持久化的状态决定。

## Alternatives considered

**在 `lan.html` 里重写微信设置控件。** 该页有十五个字段和三个会话操作，插件随时会改；复制出来的页面会随插件下一次发布而失真。

**用注入脚本驱动设置对话框**（先点触发器，再点 WeChat 导航行），QQ 群管理窗口就是这么做的。分区 id 本身就可以寻址，而按本地化文本点击会在标签变化时失效。

**在窗口里保留两个页面并加标签页。** 需求是替换窗口内容；标签页会把这次要去掉的重复界面重新留下。

## Consequences

窗口标题仍是「移动访问」，显示的是覆盖在工作区页面上的设置对话框；关掉对话框后该窗口留在工作区页面上。没有安装 `dsh-wechat` 的配置会打开第一个已注册分区，这是外壳的正常回退而不是报错。

本版本的局域网门没有屏幕上的控制入口。开启或轮换只限于原本已经开启过的机器，配对链接只能直接读取 `/shell-api/lan`。

`packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` 覆盖了挂载时打开指定分区，以及参数为空时对话框保持关闭。
