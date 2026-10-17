# Agent Note: 配对过的手机不到一小时就要重新登录，dsh-mobile 现在把会话保留一年

Status: implemented

[English](2026-10-17-mobile-pairing-persistence.md) | 中文

## 问题

这个功能的承诺是「扫一次，一直用」：局域网访问开着、桌面应用开着，手机随拿随开。实际使用里，手机却总在问它已经回答过的问题：

- 闲置大约四十五分钟后，访问应用地址打开的是 DSH 登录页（`/mobile-access/login`），而不是应用本身；
- 桌面面板二维码生成的配对链接被手机浏览器留在历史里，扫过一两分钟后再打开就是 `{"error":"not_found"}`；
- 三个月没用的手机不再自动续期，必须重新扫一次。

这些都不是故障，而是出厂默认值；只是这些默认值是按演示场景定的，不是按「用户会让桌面应用一直开着」定的。

## 原因

`dsh-mobile` 把三个有效期编死在配置解析里，任何 setup 文件都抬不高：

```js
const deviceTtlMs = integer(value.deviceTtlMs, "deviceTtlMs", 7776e6, 6e4, 316224e5);
const sessionTtlMs = integer(value.sessionTtlMs, "sessionTtlMs", 288e5, 3e4, 864e5);
```

`288e5` 表示会话 48 分钟，而 schema 把会话上限压死在 `864e5`（一天）；配对设备是 90 天（`7776e6`）。配对窗口更短：

```js
pairingTtlMs: integer(value.pairingTtlMs, "pairingTtlMs", 12e4, 1e4, 6e5),
```

默认两分钟，最多十分钟。窗口一关，配对路由就不再应答：

```js
if (!this.access.pairingStatus().open) throw new HttpError(404, "not_found");
```

已有的恢复路径本身是成立的，但范围很窄：`/mobile-access/login` 会执行 `renderLoginScript`，带着设备 cookie POST `/mobile-access/auth/renew`，成功就继续进入应用。也就是说，过期的会话是能恢复的——但前提是 90 天的设备还在，而且用户打开的是应用地址，不是那条已经失效的配对链接。

## 证据

- 已安装的 profile `C:/Users/admin/.harness-cn/profiles/desktop/node_modules/dsh-mobile/lib/index.mjs`（0.6.4）里，三个字面量分别在第 1086 行（`deviceTtlMs`）、1087 行（`sessionTtlMs`）、1111 行（`pairingTtlMs`）；配对路由的闸门在 5772 行。
- 面板的窗口关闭后，在 Edge 里打开 `https://192.168.1.16:3443/mobile-access/pair` 渲染出的正是 `{"error":"not_found"}`——就是上面那个 404 分支，不是路由问题：窗口开着时 `/mobile-access/pair` 显示正常。
- 打完补丁的模块能通过 `node --check`，大小 `717 257` 字节，sha256 `782c1bed7bffcf0508f27533b2a12303ccfee21d579b00ba563d88360f00c9e6`；seed 步骤打印 `patch-mobile-session: patched … (717257 bytes, sha256 782c1bed…)` 并以 0 退出。

## 决定

在打包期修补 vendored 插件，脚本是 `apps/desktop/scripts/patch-mobile-session.mjs`，做法与 `patch-mobile-listen.mjs` 以及 `patch-rule-engine.mjs` / `patch-wechat-*.mjs` 一致：趁 `prepare-seed` 构建 seed 时改写已安装的字节，随后校验，锚点一旦移动就让打包失败。

1. 会话和配对设备的默认有效期都改成一年（`31536e6` 毫秒）；会话上限抬到与设备相同的 `316224e5`，于是手机不会在用到一半时被送回登录页，应用重启后也仍能用设备 cookie 静默续期。
2. 配对窗口的默认值改成它自己的上限十分钟（`6e5`，仍限定在 `1e4…6e5`），这才是「拿着手机走过来」实际需要的时间。
3. 配对窗口关闭后不再回 404，而是回一个页面：它在后台重试 `/mobile-access/auth/renew`（已配对的手机于是直接进入应用），否则说明桌面面板里二维码的位置，并给出指向 `/` 的入口。

每处改写都由 `DSH_MOBILE_SESSION_LONGEVITY` 标记守护，并在安装目录之外的临时副本上跑 `node --check` 校验；`prepare-seed` 会给它 materialize 出来的 profile 打补丁，`verifyOfflineInstallation` 在这些锚点将来被移动时让构建失败（`desktop seed: the profile the seed produced has no long-lived dsh-mobile sessions`）。

## 考虑过的其他方案

- **改用配置而不是打补丁。** 出厂状态做不到：这些默认值和上限是 `parseGatewayConfig` 内部 `integer(…)` 的实参，setup 文件不可能超过编死的上限。
- **把会话持久化到磁盘、跨重启保留。** 为了同样的结果去动插件的状态存储，代价更大；设备 cookie 本来就能换一个新会话，重启只是多一次看不见的往返。
- **设备仍保留 90 天，只延长会话。** 日常使用里过期的是会话，可跨季节过期的是设备；只延长一个等于把麻烦挪个位置，而不是消掉。
- **升级 dsh-mobile。** 现有版本仍然编死这三个默认值，升级不会改变结果。

## 影响

- 扫过一次的手机，在应用反复重启的一年里都能继续用；留在浏览器历史里的链接也会自我解释，不再只给一个光秃秃的 404。
- 代价是明确的：配对手机的 cookie 现在会越过原来的 90 天窗口。撤销手段是面板里的设备列表，移除设备后它的访问会在下一次续期时结束。
- 打包从此依赖三个字面量锚点外加配对路由闸门。dsh-mobile 升级挪动它们时，seed 构建会带着具名错误失败，而不是悄悄发出旧的有效期。
- 补丁在 seed 日志里可见：`patch-mobile-session: patched …`（复用缓存树时是 `already`），漏打补丁的构建可以被认出来。
