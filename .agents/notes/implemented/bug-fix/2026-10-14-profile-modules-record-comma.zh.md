# Agent Note: the profile's pnpm record keeps its commas

Status: implemented

[English](2026-10-14-profile-modules-record-comma.md) | 中文

## Problem

安装 0.1.5-rc.22 之后重建桌面 profile 失败：

```
dsh shell: prebuild failed: desktop project: pnpm exited with 1:
[ERROR] missed comma between flow collection entries (1812:3)
```

重建会先展开随包发布的 profile 目录树，然后让 pnpm 把桌面插件装回去。在第二步之前，
`apps/desktop/src/seed-store.ts` 的 `recordInstalledPnpmPaths` 会把目录树的 pnpm 记录
（`node_modules/.modules.yaml`）指向它实际所在的仓库与 profile。它替换了 `storeDir` 与
`virtualStoreDir` 整行，而替换文本结尾没有逗号——于是记录丢掉了分隔下一条目的逗号，
pnpm 便拒绝使用这棵树。

由于这次改写发生在展开过程内部，每次尝试都会重新造成损坏，而被该缺陷版本构建出来的种子
也会带着损坏的记录一起发布。故障现象离原因很远：某个插件恢复步骤报 `pnpm exited with 1`，
而应用一直从它没能替换掉的那个 profile 启动。

## Decision

改写时保留行尾，并修复已经丢掉逗号的记录：`rewriteRecordedPath` 沿用被替换行原有的逗号，
`restoreRecordedComma` 在该行后面紧跟另一个带引号的键时把逗号补回来。两者都在
`apps/desktop/src/seed-store.ts` 写入记录之前执行，因此从受影响种子展开出来的目录树可以
重新使用。

`apps/desktop/tests/seed-store.spec.ts` 覆盖两种情况：改写后的记录保留两条路径行末尾的逗号；
以及丢掉逗号的记录被修复、而相邻条目保持原样。

## Alternatives considered

- 解析记录再重新序列化。该文件是「看起来像 JSON」的 YAML，JSON 往返会拒绝 pnpm 合法写出的
  形态，而且会给一个刻意只维护该文件两项事实的模块引入 YAML 依赖。
- 不动记录，交给 pnpm 自行修正。pnpm 根本拒绝使用这棵树，这正是要修的故障。
- 只修写入方。早期版本构建的种子已经带着损坏的记录，不重新构建并发布种子，已安装的应用会
  一直失败。

## Consequences

受影响的安装可以正常升级，而从 rc.21 时代种子展开出来的目录树在展开过程中即被修复。该模块
仍然只改写两项事实，也仍然不拥有 pnpm 的记录格式；修复仅限「行尾没有逗号、且后面紧跟另一个
带引号的键」这一在任何情况下都非法的情况。
