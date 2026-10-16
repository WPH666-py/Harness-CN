# Agent Note: Typert codecs accept the lazily created schema form newer releases emit

Status: implemented

[English](2026-10-16-typert-codec-schema-forms.md) | 中文

## Problem

本产品要装载的 DeepSeek 账号包，把它们的 Remote 面以生成的 typert 清单形式携带。在带有赠金读取与确认的那些发行版（`0.1.7-rc.2`）里，这些清单把 codec 的运行时 schema 描述成一个 `create()` 工厂——`codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-deepseek-account/types#SignInAttemptId', create: () => z.intersection(z.string(), z.unknown()) }`——而本线的生成器产出的是急切对象形式 `schema: <ZodType>`。具名 schema 记录也随之变化，从 `{ name, schema }` 变成 `{ name, create }`。

于是被挂载的行在启动时失败；又因为一个注册不上的 typert contributor 会让整棵树失败，这个失败是全局的而不是局部的：

```
dsh desktop: plugin tree failed to load: failed to apply loader entry typert-loader (@deepseek-ai/dsh-typert-loader):
typert-loader: 1 typert contributor(s) failed to register:
  - typert-loader: @deepseek-ai/dsh-api-account-controller invocation "@deepseek-ai/dsh-api-account-controller#account/cancelSignIn" parameter codec is not backed by a zod v4 schema
```

0.2 一代的 loader、registry、gateway 与 protocol——从生产环境里真正装载这些行的桌面发行包中提取——读的是同一个字段，只是经由那个工厂：校验器要求 `typeof codec.create === 'function'`，registry 用 `record.value ??= record.create()` 物化记录，gateway 用 `codec.create().parse(value)` 解码。同一个声明同时存在两种生成形式，而本线只能读其中一种。

## Decision

每一处解析已声明 codec schema 的地方都同时接受两种形式。codec、派发、线格式与类型链接的其它部分都不变。

`packages/typert/protocol/src/types.ts` 声明 `TypertSchemaSource`（两个字段都可选）与 `typertSchemaOf(source)`：后者对急切的 `schema` 原样返回，否则调用 `create()`；严格 codec 变体不再要求急切字段，而是把 `schema?` 与 `create?` 都标为可选。两者都从包索引再导出，因为 API gateway 本来就以运行时依赖的方式依赖 protocol 包。

`packages/typert/loader/src/index.ts` 在把结果校验为 zod v4 schema 之前，先用本地 `generatedSchema(source)` 解析描述符，具名 schema 检查与 `requireStrictCodec` 同样处理。这个解析器是本地实现而非导入的：loader 的 peers 是 cordis 的 loader 与 registry，它唯一的运行时依赖是 `schemastery`，而它的消费者是启动路径——五行解析器比给「负责启动的那些包」新增一个依赖更便宜。`packages/typert/registry/src/service.ts` 出于同样的理由保持 zod 是它唯一的运行时依赖，并用本地 helper 物化。

`packages/typert/registry/src/types.ts` 把原本同一个接口里的两种形式分开：`TypertSchema` 是声明形式（`schema` 可选、`create` 可选），`TypertSchemaRecord` 是物化形式（`schema` 必填），于是 registry 的消费者在类型层面拿不到未物化的记录。`validateSchemas` 先物化再记录，并对两个字段都没有的声明报 `typert: schema "<name>" declares neither a schema nor a create() factory`。

`packages/api/gateway/src/index.ts`（宿主 `decode`）与 `packages/api/gateway/src/client/index.ts`（`requireStrictCodec`、`parseInput`）改为经 protocol 包的 `typertSchemaOf` 解析。两处现在都会报出「未声明运行时 schema」的 codec——`strict codec for wire field <field> declares no runtime schema` 与 `client api: generated Remote <endpoint> field <field> has no runtime schema`——而不是去解引用一个清单里可能不存在的字段。

## What this does not change

本仓库自己的生成器仍然产出急切形式，因此每个已提交的 catalog 产物都逐字节不变，`gen-cordis-catalog` / `verify-cordis-catalog` 没有任何东西需要重写。校验与之前一样严格：两个形式都没声明的 codec，或者解析出来不是带 `parse` 的 zod v4 schema 的东西，仍然会让该行乃至整棵树在启动时失败。

重复调用生成的工厂在构造上就是安全的：产出的工厂会记住自己的值（`const _schema = () => (_schema$value ??= …)`），所以 gateway 每次解码都解析一次也不会在首次调用之后再分配。

## Alternatives considered

- 把生成出来的账号清单补丁成急切形式。它是另一个包的构建产物，每个上游发行版都会重新生成；这样的补丁每次升级都要重写并重新验证，而且是在掩盖不兼容，而不是把它定义下来。
- 继续用 `0.1.7-alpha.1` 的账号包，它们的清单在本线本来就能读。它们能在本线装载，但赠金读取与确认（`getUnnotifiedBonuses`、`ackBonusNotified`）最早出现在 `0.1.7-rc.2`，而「登录后领取赠金」正是这个账号界面存在的理由。
- 把本线的 typert 包整体搬到 0.2 一代。在 `dsh-v0.1.5-rc.1` 基线上再携带第二套协议代际，比接受第二种「已声明 schema 形式」要大得多，而且会牵动仓库里每一个生成产物。
- 让 loader 与 registry 导入 protocol 的 helper，而不是各自保留本地解析器。那样等于为了共享五行代码让启动路径依赖 protocol 包；两个包现在都保持各自唯一的运行时依赖。
- 只接受新形式并不再产出急切形式。那会为没有任何行为收益的改动，重写仓库里每一个已提交的 catalog 产物与每一份生成的清单，并让读路径依赖只有更新一代生成器才会产出的形式。

## Consequences

账号包可以在本线出货：`@deepseek-ai/dsh-deepseek-account-platform` 与 `@deepseek-ai/dsh-api-account-controller` `0.1.7-rc.2` 能把它们的行从 Desktop Host 的补丁层挂载起来并启动，出货路径探针报告 host 就绪，且 `getState`、`getBalance`、`startSignIn`、`getUnnotifiedBonuses`、`ackBonusNotified` 全部存在。同一次启动在这次改动之前以 `parameter codec is not backed by a zod v4 schema` 在 16.1 秒处死掉，改动之后在 15.4 秒报告就绪。

只要本线还携带由更新一代生成器产出的包，就必须读两种生成形式，所以这些读点按设计保持双形式：未来生成器再变，是「两个分支」的事，而不是「一个分支」的事。

`packages/typert/loader/tests/loader.spec.ts` 改为经任一字段断言解析出的 schema（`codec.schema ?? codec.create?.()`）。`packages/typert/generator/tests/cordis-catalog.spec.ts` 的两个失败（`ctx.workspaceFiles` 与 `ctx.fs` 的 14 处签名类型链接覆盖缺口）不是这次改动造成的：把 typert 与 gateway 的改动 stash 掉之后它们照样复现。

这些读点共同遵守的声明由 [Typert remote method calls](../architecture/2026-08-02-typert-remote-method-calls.zh.md) 拥有，而需要它的包钉在 `apps/desktop/src/bundled-plugins.ts` 里。
