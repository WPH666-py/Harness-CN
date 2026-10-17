# Agent Note：授权接缝让流程通过会话提交凭证

Status: implemented

[English](2026-10-17-authorization-session-commit.md) | 中文

## 问题

rc.28 桌面版能启动 DeepSeek 账号登录，却永远走不完。点「登录」后平台页面在浏览器打开，回调回到本机回环地址，`POST /auth-api/v0/dsh/auth_init` 与 `POST /auth-api/v0/dsh/auth_exchange` 都返回 `200`（`code: 0`），随后 Host 打出

```text
[deepseek-account] sign-in failed { errorCode: 'storage' }
```

设置里的账号面板停在未登录形态。凭证库里只多了一条 `deepseek-account-platform/device`，授权本身该写入的 `deepseek-account-platform/default` 始终没有出现。

## 原因

`@deepseek-ai/dsh-deepseek-account-platform`（0.1.7-rc.2，从 npm 装进桌面种子）在兑换成功后用授权接缝提交授权：

```js
await session.commit({ kind: 'grant', payload: { … } })
```

而运行时自带的是本仓库打包的 `@deepseek-ai/dsh-authorization`（0.1.5-rc.29），其 `AuthorizationSession` 只有 `method`、`signal`、`notify`、`prompt` 四个成员，流程要自己调用 `ctx.credentials.modifyRecord` 写记录；接缝靠监听 `credentials/record-updated` 确认提交。旧契约因此可用，但 `session.commit` 不存在，平台把提交失败归类为 `storage`。

这两个包从来没有一起跑过：[2026-10-17-account-login-namespace](../bug-fix/2026-10-17-account-login-namespace.zh.md) 里的命名空间缺陷让界面根本走不到 `startSignIn`，版本错配一直没暴露。

## 证据

- 平台包**所有**已发布版本都通过会话提交：0.1.7-alpha.1、0.1.7-alpha.2、0.1.7-rc.1、0.1.7-rc.2 与 0.2.1-rc.1 里都只有一处 `session.commit(`。所以「钉一个更老的平台版本」这条退路不存在。
- 已安装的 `dsh-authorization@0.1.5-rc.28` 在 `lib/types/index.d.ts` 里声明的 `AuthorizationSession` 只有四个成员，`lib/index.js` 里没有任何 `commit(` 调用。
- 上游（`origin/master`，浅取到 `1517a4dbca`）已经长出同一个成员——`commit(record: CredentialRecord): Promise<void>`——以及支撑它的 `committing` 记账，因此这是对上游接缝的前向移植，不是本地发明。
- 把接缝补进安装副本后，兑换路径不再停在缺失的成员上：下面的单元用例把提交契约钉住，重建后的载荷才是端到端复验浏览器往返的地方。

## 决定

给接缝补上提交成员，同时保留本仓库更严格的结算行为：

- `AuthorizationSession.commit(record)` 经 `ctx.credentials.modifyRecord(flow.key, …)` 写记录；尝试已结束或信号已撤回时直接拒绝，迟到的提交不能复活已取消的尝试。
- `InFlight.committing` 记录写入正在进行；`cancel()` 与调用方撤回只在没有提交进行时才 abort 控制器，取消会等存储写完，而不是把写拆成两半。
- 本仓库 `settle()` 里对 `INVARIANT` 码监听器异常的重抛保留：那是本地保证，上游文件已不带它，整文件替换会让 `authorization.spec.ts` 变红。
- 两个用例钉住新契约：通过会话提交的流程以 `authorized` 结算且记录落库；尝试被撤回后才提交的流程被拒绝且不写入任何记录。

## 考虑过的替代方案

**钉一个更老的平台包。** 不可行：没有早于会话提交的已发布版本。

**让桌面种子改用 npm 的 `dsh-credentials` / `dsh-authorization`（0.1.7-rc.2）。** 那会为修一个接缝而替换运行时所有消费方（包括各 LLM provider）都在用的凭证栈，还会让本仓库自己的 0.1.5 线永远跑不了账号包。

**让平台自己走 `ctx.credentials` 写。** 平台是已安装的 npm 包，不是仓库源码；在种子里改它等于分叉一个已发布依赖。

## 影响

桌面种子里的 `dsh-authorization` tarball 带上了提交成员，0.1.7 线上的账号平台都能与本运行时配对。流程现在既可以经会话提交，也可以直接写 `ctx.credentials`；接缝两种都确认，且提交期间的取消会等存储写完再结算。
