# Agent Note：两个桌面产品，两个 home

Status: implemented

[English](2026-10-18-two-products-one-home.md) | 中文

## 问题

在一台同时运行 DSH 桌面产品的机器上，装好的 rc.33 起不来：

```
desktop project: the Harness-CN runtime at C:\Users\admin\.dsh\profiles\desktop is in use and could not be moved;
close every Harness-CN window and any other program using this home, then start again
  [cause]: Error: EBUSY: resource busy or locked,
  rename 'C:\Users\admin\.dsh\profiles\desktop' -> 'C:\Users\admin\.dsh\desktop\rollback\profile'
```

它要搬走的那个目录并不属于 Harness-CN：那是另一个产品正在使用的 profile，它的 Host 进程正是从这个路径跑起来的。

## 原因

`adoptHarnessCnHome` 把任何非空的 `DSH_HOME` 都当成指示。这个变量属于 DSH 产品，而且经常被机器级地导出——一个 shell、一个启动器、或另一个产品自己的环境，都会把它传给每一个子进程。于是从这种环境启动的打包版 Harness-CN 把共享的 `~/.dsh` 当成了自己的 home，`DesktopProjectManager.activate` 随后按惯例处理「自己的」运行时：在铺开本版的运行时之前，把 `profiles/desktop` 挪进 `rollback/profile`。另一个产品占着这个目录时，rename 失败；如果它当时空闲，搬迁就会成功，把对方的 profile 一起带走。

## 决定

打包版一律解析 `~/.harness-cn`，不再读 `DSH_HOME`：

1. `HARNESS_CN_HOME` 指定本产品的 home，优先级最高，打包与否都算；
2. 打包启动（Electron 主进程的 `app.isPackaged`、Tauri 侧车由 shell 落下的 `HARNESS_CN_PACKAGED=1`）忽略继承来的 `DSH_HOME`，采用产品默认目录；
3. 开发与 CLI 启动继续认 `DSH_HOME`——在那里它是开发者自己的指示，不是邻居的环境。

## 考虑过的替代方案

- **继续认 `DSH_HOME`，只加一个「profile 被占用」的守卫。** 否决：守卫只覆盖被锁住的情形。空闲时同一段代码会把对方的 profile 搬进 `rollback/`，而且两个产品仍然共用会话、存储与凭据——共用一个 home 才是缺陷本身，占用只是它的症状。
- **全面改名 `HARNESS_CN_HOME`，不再支持 `DSH_HOME`。** 否决：仓库的开发与 CLI 流程是有意设置 `DSH_HOME` 的，`@deepseek-ai/dsh-home-paths` 为它们持有那条优先级规则；只有打包入口需要更窄的规则。
- **检测到另一个产品就换用按产品命名的 profile（`profiles/harness-cn`）。** 作为第二道防线考虑，而不是修复本身：换个 profile 名字并不会阻止两个产品共用一个 store、一份凭据文件或一个会话目录。

## 后果

- 有意用 `DSH_HOME` 挪动 Harness-CN home 的用户需要改用 `HARNESS_CN_HOME`；运行日志会写明本次启动采用的 home，所以这个变化是可见的，而不是悄悄发生的。
- 早前 Harness-CN 留在 `~/.dsh` 的用户数据仍会做一次性拷贝；当那个 home 带着另一个产品的痕迹时，仍然什么都不拷。
- 装好的侧车与 Electron 主进程基于同样两个变量做同样的选择，任何一半都不会单独漂回共享 home。
