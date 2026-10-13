# Agent Note: An installed profile restores only the plugins its user added

Status: implemented

[English](2026-10-13-profile-upgrade-plugin-restore.md) | 中文

## Problem

在已安装的机器上升级、重建桌面 profile 时，失败在「把用户自己加的插件放回去」这一步：

```
dsh shell: prebuild failed: desktop project: pnpm exited with 1
```

重建会先物化发布出来的那棵树，再在暂存 profile 里跑 `pnpm add <插件> --save-exact --offline`，把用户装过的
插件恢复回来。这一步有两处不对。

它在激活之前跑。物化出来的树的依赖是按 profile 的最终位置链接的，所以 pnpm 拒绝暂存路径所对应的虚拟存储
（`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`）——这个位置上的这一步不可能成功。

它还读了错误的插件集合。`materializeProfile` 用 `bundled[名字] !== 版本` 挑出 profile 里记着的插件，于是
「本版捆绑的插件、但记录的版本不同」会被当成用户的选择。rc.21 写下的 profile 记着 `dsh-wechat` 0.8.0，
rc.22 捆绑的是 0.10.0，因此每一次升级都会去离线恢复一个离线包本来就带有的包——而这一步按设计不允许联网。

两个缺陷和 pnpm 记录里那个缺失的逗号（见 `2026-10-14-profile-modules-record-comma.md`）在同一条路径上：
那个先让 pnpm 停下，这个在它被修好之后再让 pnpm 停一次。

## Decision

`materializeProfile` 只恢复本版**没有捆绑**的插件（`bundled[名字] === undefined`）：profile 里记的版本是
写下它的那次发布的钉版，不是用户的选择；而树里已经带着本版要发的那个版本。

`rebuildRuntime` 在**激活之后**恢复用户的插件——此时树就在它自己的链接所指的位置——并且把失败报告出来，
而不是让一次已经成功的启动失败：不管恢复成不成功，这个 profile 都能用，只是少了那个插件。

## Alternatives considered

在激活之前按 profile 的最终路径恢复插件（否决：安装过程会去改一个仍在运行的 profile，而且重建中途失败会把
它留在半移动状态）。

从 `dsh.profile.bundles` 读用户插件集合（否决：这份清单同时也列着本版要激活的插件，区分不出哪些是用户加的；
依赖里记录的版本可以）。

把版本不同当成用户升级、从桌面 registry 装（否决：重建按设计离线运行；捆绑插件的钉版是发布方的决定，不是
「去别处取一个」的请求）。

## Consequences

已安装的机器一次就能升级完成：本版捆绑的插件来自离线包，只有用户自己加的插件会被恢复——且在树激活之后恢复，
此时 pnpm 与它的链接一致。`project-manager.spec.ts` 覆盖「旧钉版的捆绑插件」与「用户插件」并存的情况，并断言
只有后者会走到 pnpm。
