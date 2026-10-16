# Agent Note: 桌面端视觉插件的挂载与本线缺失的 configForms 服务

Status: implemented

[English](2026-10-16-desktop-vision-plugin-config-forms.md) | 中文

## Problem

0.1.5-rc.27 的桌面壳没有打开聊天界面，而是打开了客户端的失败屏：

```text
Failed to load plugins
web boot: 2 entries did not activate
@lp181818/dsh-vision-plugin: pending (waiting for service: configForms)
```

`apps/desktop/src/bundled-plugins.ts` 把视觉插件列为 active 行，于是 profile 的 `dsh.profile.bundles` 把它自带 `cordis.patch.yml` 里的 insert 组合进配置，宿主加载了该行，而 `packages/client/modules` 因为该包声明了 `dsh.client` 而为它创建了浏览器端条目。它的浏览器半边声明 `inject = ['slots', 'locale', 'configForms']`，并在 `apply` 开头读取 `ctx.configForms.get('vision-plugin')`，这发生在它于同一函数末尾注册 `settings.section` 席位之前。`configForms` 是 0.1.7 线的插件配置表单服务；本 profile 里没有任何包提供它，而 Cordis 对一个无法满足的服务 inject 会保持 pending，且没有超时。客户端正是把这一状态变成上面的报错（`packages/client/web/src/boot.ts`），渲染成 `Failed to load plugins`（`packages/client/web/src/boot-page.ts`），并放弃启动——一个第三方行把整个 Web GUI 一起拖垮了。

本线拥有的服务是同一能力换了个名字，而不是缺了一项能力：`SettingsScopeBinder`（`packages/client/ui-settings/src/client/settings-scope.ts`）按命名空间绑定 `settingsScope` 控制器，提供 `getSnapshot`、`subscribe` 与 `mutate`，而这正是该插件自己那层鸭子类型适配器所调用的契约——`scope.getSnapshot().value`、`scope.getSnapshot().revision`、`scope.subscribe(publish)`，以及带 `{ op: 'set', path: [field], value }` 操作的 `scope.mutate(ops)`。它也注册进 `settings.section`，也就是本线自己的设置包注册的槽位。所以这并不是一个本线装不下的包，而是一个浏览器半边点名要了更新线服务名的包。

## Decision

该插件继续安装、继续钉在 `1.2.3`，但不再被列出：在 `apps/desktop/src/bundled-plugins.ts` 中 `active: false`，理由与上述证据写在该条目自己的注释里，并且 `active` 的文档注释把这种情况列为第四类「已安装但不列出」的条目。

取消列出之所以能去掉这个等待，是因为捆绑清单是挂载该行的唯一来源。`createSeedMetadata` 用 `bundledPluginDependencies()`（无论 active 与否的每一条）写出种子清单的 `dependencies`，用 `bundledPluginNames()`（只含 active 条目）写出它的 `dsh.profile.bundles`；而 `loadProfileDirectory`（`packages/boot/app-boot/src/profile.ts`）只按这份清单组合行。`materializeProfile` 随后把种子的元数据覆盖到暂存 profile 上，并且从不把捆绑包名恢复成用户插件，因此全新 profile 与由发行种子重建的 profile 都带着这份更短的清单。该插件自己的 patch 也没有别的层会触及：`apps/desktop-host/config/desktop.cordis.patch.yml` 里没有任何视觉插件的行。

激活检查本身没有任何改变。失败屏依旧会报出 pending 条目以及它等待的服务；这次改动去掉的是那个等待。

## Alternatives considered

**由本线客户端提供一个 `configForms` 服务。** 否决，因为它不是一个中立的兼容缝：已有捆绑插件按这个名字探测。列在 active 里的 `dsh-chat-import` `0.17.1` 会在客户端根 ctx 上读取 `ctx.get('configForms')`，一旦该服务存在，它就拒绝注册自己的 `settings.section` 整页——新宿主把插件设置搬进 `plugins.bundle.config` 槽位，而本线客户端并不声明该槽位。于是提供这个名字，等于为了让另一个插件拥有一页设置而删掉一个可用插件的设置页；而要让两者共存，就得在本线实现更新的 `plugins.bundle.config` 槽位及其按插件配置的整套界面——那是一项远比它所修的缺陷更大的能力。这个服务名还属于本产品并不携带的那条线，任何架在 `settingsScope` 之上的垫片都得随每个改名或扩展它的上游发行版重新推导。

**给已发布的 bundle 打补丁，让它不再点这个名字。** 否决，理由与 [DeepSeek 账号那篇笔记](../feature/2026-10-16-desktop-deepseek-account-and-bonus-credits.zh.md) 针对同一份 inject 列表里的 `"configForms"` 已记录过的一致：这样的补丁必须在本仓库并不拥有的包上、针对每个上游发行版重新验证。这里的形态也更糟——inject 列表与 `ctx.configForms` 读取在同一个模块里，去掉名字就得同时改写那处读取，而插件此后仍然需要绑定到本线的设置服务才能工作。

**把该插件从 `BUNDLED_PLUGINS` 中彻底删除。** 否决：这个条目既是钉版也是记录。删掉它，种子就不再安装该包，代码树里也不再有地方说明为什么它不能在本线挂载，而且 `assertNotBundled` 将不再拒绝这个名字——用户可以手工把 `1.2.3` 装进同一个 profile，原样复现启动失败，而源码里没有任何注释解释其原因。

**把钉版退回某个浏览器半边只要 `slots` 与 `locale` 的更早发行版。** 未采用：profile 的 `node_modules` 里没有任何更早的发行版，因此能从这棵代码树里确定「可用版本」的做法并不存在；选定一个版本还需要一次 registry 往返与种子 store 的重新预热——而这个能力的设置页本来也只能通过一个适配器渲染，而这个未列出的条目已经把它留在了一行之外。

## Consequences

桌面启动不再等待 `configForms`，而视觉插件的设置页在更新线提供该服务、或该包不再注入它之前不会出现在应用里。这项能力并没有从机器上消失：该包的文件仍留在种子 store 和每个已安装的 profile 中，与另外三个「已安装但未列出」的同伴完全一样；它的宿主半边只是一行 profile 不再组合的行。

`apps/desktop/tests/bundled-plugins.spec.ts` 把这一状态的两半都钉住：插件仍被安装并钉版，而 `bundledPluginNames()` 不含它；同时由 `createSeedMetadata` 写出的种子清单把它列在 `dependencies` 里，而 `dsh.profile.bundles` 不含它。

这次修复只有经过重新构建的桌面捆绑包才能到达用户。profile 的捆绑清单是从种子清单复制来的，所以已安装的 rc.27 profile 会一直带着该行，直到它安装一个种子已将其省略的版本；安装器、归档的 pnpm store 与 profile 清单位于同一次构建之中。

本笔记部分取代 [捆绑插件集那篇笔记](../feature/2026-10-16-desktop-bundled-plugin-set-and-offline-package-size.zh.md)，后者把视觉插件算在会激活的条目之中。那篇笔记对它拥有的插件集、钉版与种子体积决策继续有效，并在这一条目上指向本笔记。
