# Agent Note：由壳层自己把界面交给手机

Status: implemented

[English](2026-10-17-lan-door-serves-the-gui-itself.md) | 中文

## 问题

桌面版过去用 `dsh-mobile` 做手机访问：在 3443 端口再起一个 HTTPS 监听、自带私有 CA、代理到本机前门，并重写页面。为了让它能用，打包期对已安装的包打了三个补丁（`patch-mobile-listen.mjs`、`patch-mobile-session.mjs`、`patch-mobile-panel.mjs`）；而每修好一处，下一处就露出来：手机不信任自签证书；浏览器一旦拒绝过，重启后仍然拒绝，因为服务器证书每次启动都重签；代理去 Host 的私有端口取首页，那个端口回 `404`；被重写的启动脚本覆盖 `window.__DSH_TRANSPORT__` 后抛错；一年的会话寿命把 `setTimeout` 撑溢出。rc.33 删掉了这个插件，也一并失去了它提供的访问能力。

## 原因

`dsh-mobile` 把手机访问建模成「第二个 origin 代理第一个 origin」。于是两个 origin 之间所有会出错的东西都在路径上：证书信任、HSTS、cookie 交换、页面重写、上游寻址。`D:\Claudecode-CN` 在 `packages/bridge/src/remote.mjs` 与 `packages/bridge/src/webhost.mjs` 里做的是相反的事：bridge 进程**本身就是** Web 服务器，跑明文 HTTP、监听局域网网卡，并把应用自己的 `dist/` 直接以手机看到的 origin 提供出去。它的源码写明了为此放弃 TLS 的理由：没有安装步骤，手机不会信任自签证书；访问由配对时签发的 cookie 把守，页面通过 `/bridge-origin.js` 得知自己由 bridge 提供。

这个模型只有一个 origin、一个 cookie，没有需要重写的东西。而壳层本来就有这个条件：`apps/desktop-shell/src/shell-server.ts` 早已通过管道把 Host 的响应转发给 WebView，本来就在充当唯一的 origin。

## 证据

- 三个补丁及其接线已从 `apps/desktop/scripts/prepare-seed.ts` 移除；`dsh-mobile` 已从 `apps/desktop/src/bundled-plugins.ts` 去掉。
- `@linxin666/dsh-remote-web-ui@0.4.7`（`dsh-web` 的移动端部分）无法服务这条载体：它只在 `ctx.webServer.host === "0.0.0.0"` 时计算局域网地址，而桌面 Host 被 `apps/desktop-host/config/desktop.cordis.patch.yml` 固定在 `127.0.0.1:0`；手机需要的界面由壳层提供，不在 Host 上。它的聚合包 `@linxin666/dsh-web-all` 还依赖 0.2.x 的 `plugin:` 行约定：本线上 `packages/client/modules/src/index.ts` 用行自身的模块说明符解析客户端行，子路径说明符（`@linxin666/dsh-web-all/remote-web-ui`）被判为「永远不会成为客户端行」，于是它 14 个面板注册不出浏览器半身。
- 针对真实服务端的验证脚本（`_work/lan-door-test.mts`，后续删除）输出为：本机 `/` → `200 host:/` 且带 `hcn` cookie；`/shell-api/lan` → `200 {"enabled":false,"address":"192.168.1.16",…}`；门关着时局域网 `/` → `200` 与 `dsh-lan-door=off` 提示页；开启后拿到链接；局域网 `/` 无 cookie → `notice=locked`；打开链接 → `302` 到 `/` 并带 `hcn_lan=…`；带该 cookie 的局域网 `/` → `200 host:/`；局域网 `/shell-api/lan` → `403`（只答本机）；`/shell-api/lan/qr` → SVG；重新生成后旧 cookie 被拒；关闭后 → `notice=off`。
- 第二个探针在本线的临时 profile 里只装 `@linxin666/dsh-remote-web-ui@0.4.7` 并打开界面：首部 `200` 带着它的行，boot 图里也有它，但页面始终不绘制。它的 `apply` 注入了 `configForms` —— 本线没有提供者（那是 0.1.7 线的插件配置表单注册表；本线的等价物叫 `settingsScope`，但顶替不了：`dsh-chat-import` 会探测这个名字，发现它存在就拒绝注册自己的设置页）。一条 pending 会让 boot 审计判整页失败，所以把该包装进来等于把「没有手机访问」换成「没有界面」。聚合包用另一种方式掩盖同一个缺口：它的行是子路径说明符，客户端扫描不注册浏览器半身，于是根本没有 pending 出现。

## 决定

`startShellServer` 绑定 `0.0.0.0`，并按请求判断谁可以读到界面：WebView 与手机因此落在同一个监听、同一个 Host 上。

- 回环对端就是 WebView：拿到界面、`hcn` 控制 cookie，以及控制接口。
- 非回环对端就是手机：永远拿不到控制接口（`403`）；只有门开着且 cookie 匹配时才拿到界面。
- 门是 `LanAccess`（`apps/desktop-shell/src/lan-access.ts`）：`state/lan-access.json` 里一枚 32 字节密钥，对应 `/__lan?key=<密钥>`；密钥匹配时回 `302 /` 并写入 `hcn_lan` —— `HttpOnly`、`SameSite=Lax`、有效期一年。重新生成密钥会让所有手机同时失效；关闭开关则拒绝所有手机，但保留密钥供下次开启。
- 没有有效 cookie 的手机会收到一个很小的提示页，写明当前状态（`off` 或 `locked`）以及链接从哪里来。这个页面不含界面代码也不含凭据，扫到端口的扫描器没法从中得到可重放的东西。
- 二维码由壳层进程绘制（`qrcode`，`GET /shell-api/lan/qr`），窗口本身不需要编码器；新增的**移动访问**窗口（`apps/desktop-shell/src-tauri/resources/shell/lan.html`）只有一个开关、一张码、一条链接。

## 考虑过的其它做法

**继续给 `dsh-mobile` 打补丁。** 每个补丁解决一个故障、又暴露下一个；上面那份清单是顺序，不是抽样。架构本身保证了故障会继续出现。

**引入 `@linxin666/dsh-remote-web-ui` 并让 Host 绑定局域网。** 这会把界面从壳层挪走（本线 Host 不提供首页），与壳层自己的入口重复，而且客户端半身依然注册不出来。

**改写 Host 的桌面补丁去绑 `0.0.0.0` 再加一个局域网配对插件。** 这会在每次桌面启动时都改变 Host 的安全姿态，包括用户根本没开手机访问的那些启动。

## 后果

手机访问不再需要装证书、也不需要配对码：链接本身就是凭据。局域网流量是明文 HTTP —— 这正是 `D:\Claudecode-CN` 为同一个理由（没有安装步骤，手机不会信任自签证书）记录下的取舍；这里把它写在窗口里，而不是让用户在浏览器警告前自己猜。

控制接口仍然只对本机开放，所以已配对的手机可以使用界面，但不能装插件或更新。关闭开关或重新生成链接后，所有手机在下一次请求时失效。
