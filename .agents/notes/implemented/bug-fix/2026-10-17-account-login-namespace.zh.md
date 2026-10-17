# Agent Note：账号面板自己挂载 Remote 命名空间，却经由错误的上下文读回

Status: implemented

[English](2026-10-17-account-login-namespace.md) | 中文

## Problem（问题）

rc.28 桌面版的设置对话框把「账号与余额」渲染成 `充值余额 登录后查看`、`赠金余额 登录后查看` 和一个**点了没反应**的「登录」：点击后控件保持禁用，账号状态始终没有到达。Harness 日志里一条 `[deepseek-account]` 都没有，说明没有任何请求到达 Host —— 浏览器登录流程根本没启动，尽管平台包、控制器和面板都在载荷里。

面板本身是完整的：Host 侧的 `startSignIn` 会 POST `/auth-api/v0/dsh/auth_init` 并给出平台授权地址，外壳会用系统浏览器打开该地址，回调侧再兑换授权码。坏的只是第一步 —— 插件读不到自己挂载的命名空间。

## Cause（原因）

`packages/client/ui-settings-account-harness/src/client/index.ts` 声明 `export const inject = ['slots', 'locale', 'remote']`，并在自己的 `apply` 里安装 `remote.account`：

```ts
const unmount = await ctx.remote.$mount(accountRemote)
```

随后状态存储又通过注入的投影把它读回：`this.ctx.remote.account`（`account-store.ts`）。Cordis 的 `ctx.remote` 用服务代理解析带点号的服务名，而该代理拒绝任何未在 `inject` 里声明的名字：

```text
RemoteError: cannot get property "remote.account" without inject
```

这个插件无法声明 `remote.account`：那个服务正是它自己安装的，fiber 会等待自己的贡献而永不启动。于是每次账号调用都抛错 —— 状态流的 `open` 回调抛错（面板保持未登录的默认值），`signIn()` 在解析命名空间之前就把 `busy` 置位，结果行永远停在忙碌态、控件保持禁用。

## Evidence（证据）

- rc.28 出货的客户端在对话框里抛出 `cannot get property "remote.account" without inject`；这是通过 WebView2 调试端口与面板默认标记一起抓到的。
- 整轮运行 `harness.log` 里 `[deepseek-account]` 条目为零。改为从注册表读取命名空间后，一次点击就产生 `POST /auth-api/v0/dsh/auth_init` → `200`（`code: 0`），面板切到 `请在浏览器中继续`，并出现取消控件与授权链接 —— `https://platform.deepseek.com/dsh/authorize?authorize_id=…`。
- 浏览器这一跳不需要改动：授权链接本来就带 `target="_blank" rel="noreferrer"`，而桌面外壳既拒绝把窗口导航离开 `127.0.0.1`，又把非回环的新窗口交给系统浏览器（`apps/desktop-shell/src-tauri/src/main.rs` 的 `open_in_browser`），所以平台页面在 Edge 里打开。
- 仓库里每个「消费由别的插件挂载的命名空间」的包都会在 `inject` 里声明它（`packages/api/workspace-controller/src/client/index.ts:38`、`packages/client/ui-settings/src/client/index.ts:43`，以及其余设置分区），这恰恰是自挂载的包做不到的。

## Decision（决定）

从注册表读取插件自己安装的服务，并让本地失败可见：

- `AccountSectionController.account()` 改为返回 `this.ctx.get('remote.account')`，缺失时抛出有名字的错误，而不是依赖投影守卫。文档注释记下为什么 `inject` 不能声明它。
- `signIn()`、`cancelSignIn()` 与 `signOut()` 在解析命名空间抛错时恢复 `busy` 并置 `failed`，本地失败会渲染失败分支，而不是把行卡在禁用态。
- 测试脚手架改为把假命名空间装进支持 `ctx.get` 的注册表（不再经由 `remote.account`），并新增一个回归用例：命名空间缺失时驱动 `signIn()`，断言 `busy: false`、`failed: true`，且没有发出任何 Remote 调用。

## Alternatives considered（已考虑的备选）

**在 `inject` 里声明 `'remote.account'`。** 死锁：该服务由同一个 fiber 的 `apply` 贡献，fiber 会等待自己，面板永远不挂载。

**把挂载移到祖先插件，再注入带点号的名字。** 其余设置分区正是这样消费命名空间的，而且能让 UI 包使用常规投影。暂不采用：账号贡献来自只有桌面种子才安装的 npm 包，祖先只能是桌面客户端补丁，它就要承担一个仅限 Host 的依赖和一次离开该面板便无意义的挂载。从注册表读取让挂载与消费者都留在拥有两者的包里。

**在 `apply` 里把命名空间对象往下传，而不是读上下文。** 控制器还要服务之后注册的副作用（赠金通知、登出），把对象穿过去只会增加管线，换不到更多安全。

## Consequences（后果）

凡是从自己的 `apply` 安装 Remote 命名空间的插件，都必须经由 `ctx.get` 读回，因为带点号投影的门槛是静态的 `inject` 声明，而不是运行时可见性。已发布的 rc.28 安装包带着该缺陷、无法登录；修复随下一份桌面载荷发布。
