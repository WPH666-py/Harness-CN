---
description: "`ctx.fs` 的宿主文件系统后端：面向选择或排查本地文件访问的部署方与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-local

[English](README.md) | 中文

## 概述

使用 `dsh-fs-local` 可在宿主文件系统上读取、列出、原子写入和编辑文件。相对路径从可配置的基准目录解析，而绝对路径和父目录遍历不受限制。到达同一文件的路径和符号链接共享一个身份。写入保留文件权限，可选版本防护会拒绝陈旧覆盖。直接访问宿主文件时选择本包；需要约束变更时使用 `fs-sandbox`，文件位于远程执行世界时使用 `fs-e2b`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要由真实宿主文件系统支撑的 `ctx.fs`、且可以接受进程本地实现时，挂载此后端。常用路径是显式的：加载后端、给出基准目录，然后面向模型的工具（`dsh-tool-fs`）或你自己的插件即可读取、写入和编辑文件。

### 何时选择

普通宿主文件访问请选择 `fs-local`。会话的写入与编辑必须限制在工作区与临时根目录内时，选择 [`fs-sandbox`](../fs-sandbox/README.zh.md)——它扩展此后端，只增加模式围栏。文件必须位于与子进程共享的远程执行世界时，选择 [`fs-e2b`](../../e2b/fs-e2b/README.zh.md)。`config.cwd` 只是解析默认值，不是约束边界：绝对路径与 `..` 都可以逃逸它。

### 最小配置

加载后端并给出基准目录；相对路径以它为基准解析，绝对路径忽略它。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /absolute/path/to/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | `process.cwd()` | 相对路径的基准目录 |
| `diffBasisMaxBytes` | `10 MiB` | 每次覆写 diff 一侧的 UTF-8 字节上限；更大的覆写返回 `before: null` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-fs-local)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 你能做什么

完整或流式读取任意普通 UTF-8 文本文件，按你选择的上限或按字节窗口读取原始字节，并按稳定名称顺序列出一层目录。原子地创建或替换文件，并原子地应用字面量文本编辑；两个变更操作都按文件串行化，并发写入方绝不会交错。版本防护是可选的：省略它即无条件创建或覆盖，提供它则在文件自上次观察以来发生变化时失败。

创建目录（`recursive: true` 时连缺失的祖先一起创建）、创建空文件、删除文件或目录、复制文件或整棵子树、移动或重命名一个条目。创建、复制或移动的目的地已被占用时以 `FS_ALREADY_EXISTS` 失败，且什么都不改动；目录删除在未开启 `recursive` 而目标下仍有条目时以 `FS_NOT_EMPTY` 失败。复制会把链接按链接重现而不是跟随它，因此不会把被复制子树之外的东西拉进来。同一文件系统内的移动就是一次 `rename`；跨文件系统时先复制再删除源，这一步不是原子的。

### 变更路径的操作

`createDirectory` 创建一个目录，在 `recursive: true` 下则创建一整条缺失的祖先链。目标处已存在的目录只在 `recursive` 下算成功；非递归调用遇到被占用的目标、以及目标处存在任何文件或链接，都是 `FS_ALREADY_EXISTS`。`createFile` 用一次独占创建发布一个空文件，因此它绝不会替换探测之后才出现的条目，也不会继承 `writeText` 的「自动建父目录」行为。

`remove` 对应一次 `rm` 或 `rmdir`；非递归的目录情形走 `rmdir`，如果探测之后有条目进来，文件系统自己就会拒绝。`copy` 用 `lstat` 遍历源，按源的权限位创建每个目录、逐字节复制每个普通文件、并以 `symlink(readlink(...))` 重建每个链接而不是跟随它。`move` 在同一文件系统内是一次 `rename`；当两端位于不同文件系统时这次 rename 会抛 `EXDEV`，后端于是复制子树再删除源，因此目标先完整、源才被触碰，而那次删除失败会同时留下两者。

这五个操作都跑在 `writeText` 所用的每目标变更锁里，且 `move` 会同时持有两端的锁，因此并发写入无法与触碰同一目标的移动交错。

失败是携带稳定错误码的类型化 `FsError`——`FS_NOT_FOUND`、`FS_NOT_TEXT`（二进制内容）、`FS_STALE_VERSION`（自观察以来已变化）、`FS_EDIT_NOT_FOUND` 或 `FS_AMBIGUOUS_EDIT`（无唯一字面量匹配）等——因此调用方依据错误码分支，绝不解析消息文本。带防护的编辑遇到缺失目标时，无论哪种情况都报告 `FS_STALE_VERSION`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本地后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端建立在三个想法之上：

- **Realpath 身份。** `targetKey` 是文件的 `realpath`，因此经符号链接到达同一文件的两个输入路径共享一个身份，写入落在链接目标上，同时保留链接。
- **原子发布。** 写入先写入目标旁私有暂存目录内的独占临时文件，执行 fsync 后发布；现有文件的 mode 会保留，Windows 上的 DACL 也会在替换后存活。
- **单一变更临界区。** 每目标 FIFO 锁串行化读取→防护→写入窗口，并发写入与编辑因此被确定性排序——一方胜出，其余看到新版本并以陈旧拒绝。变更路径的操作持有同一把锁，`move` 同时持有两端的锁。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务接线：`LocalFileSystem`、`Config`、每目标变更锁 |
| [`src/fsio.ts`](src/fsio.ts) | 不依赖 Cordis 的原始 I/O：探测、读取、原子写入、字面量编辑、行尾处理，以及创建/删除/复制/移动 |
| [`src/win32.ts`](src/win32.ts) | 原子替换的 Windows 专属 DACL 保留 |

### 写入路径

每次写入先探测目标、执行可选防护（`createIfAbsent` 或 `replaceIfVersion`）、在两侧都足够小时捕获有界的 `before` diff 基础、把新内容暂存到目标旁、fsync，然后原子发布。带防护的创建使用绝不替换并发创建者的硬链接发布，并以 `FS_NOT_OBSERVED` 拒绝它。

### 编辑路径

每次编辑先探测、在字面量匹配前校验版本防护（陈旧编辑因此报告 `FS_STALE_VERSION`，绝不会给出误导性的无匹配）、读取文件、以 LF 规范化执行字面量替换、恢复文件主要的行尾风格，然后重新发布——全部在每目标锁内完成。

### 归属与不变式

原始 I/O 不依赖 Cordis，在 `src/fsio.ts` 中独立单元测试；`src/index.ts` 保持为轻量接线。`config.cwd` 只是解析默认值——约束是 `fs-sandbox` 或 `tools/execute` 权限插件的工作。取消是尽力而为的 `AbortSignal`，在每次异步探测前后检查。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从约定逐步进入相邻的后端、工具与策略。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——本后端实现的 `ctx.fs` 约定。
- [fs-sandbox](../fs-sandbox/README.zh.md)——扩展本后端的沙箱强制后端。
- [tool-fs](../tool-fs/README.zh.md)——消费 `ctx.fs` 的面向模型工具。
- [fs-observation-policy](../fs-observation-policy/README.zh.md)——通过 `fs/*` 事件防护变更的策略插件。
- [Windows DACL 保留笔记](../../../.agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.md)——原子替换为何复制目标的访问策略。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-fs` 间接产生影响；该消费方把本提供方带行窗口的 UTF-8 内容、变更确认与提供方消息原文渲染为有保留上限的结果，而版本、原子写入机制与目录元数据仍属内部细节。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本地后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **`config.cwd` 不是沙箱**：它是解析默认值，而非约束；绝对路径和 `..` 可以逃逸。请使用更严格的 `ctx.fs` 后端或 `tools/execute` waterfall（瀑布式事件）上的权限插件实施约束。
- **版本 token 依赖文件系统元数据**：它们组合设备、inode、大小、纳秒级 mtime 与纳秒级 ctime；如果存储层在重写时无法更新其中任何一项事实，仍可能绕过陈旧防护。
- **`editText` 会把整个文件及编辑后的副本保存在内存中**：只有读取路径支持流式处理。
- **低于上限的覆写仍会缓冲上下文基础**：`writeText` 除调用方持有的替换内容外，最多还会保留略低于 `config.diffBasisMaxBytes` 的旧文本；该上限不限制返回的 `after` 值，也不限制整文件展示回退。
- **二进制检测不对称**：读取只对前 8192 字节执行 NUL 采样，编辑则扫描整个 buffer，因此 NUL 出现在后部的文件可以读取，但编辑会被拒绝。
- **每目标变更锁仅限进程内**：即使跨进程，带防护的创建仍采用原子且不替换的发布方式；但只有当可选版本防护观察到元数据变化时，系统才能发现其他进程中的替换写入方，且绝不会将其串行化。
- **带防护的创建要求支持硬链接**：拒绝硬链接发布的文件系统或挂载点无法支持 `createIfAbsent`；后端会使目标保持缺失状态并报告 `FS_IO_ERROR`。
- **提交后清理采用尽力而为语义**：如果移除仅所有者可访问的暂存目录失败，成功发布仍视为成功，并留下私有残留供运维人员后续清理。
- **跨文件系统移动不是原子的**：无法 rename 的移动会先复制子树再删除源，因此那次删除失败会在原源旁边留下一个完整的目标，调用方必须重试或删掉其中之一。
- **子树复制不是原子的**：`copy` 逐个条目构建目标且不回滚，中途失败会留下已经创建的那些条目；需要全有或全无的调用方在失败后删除目标。此外 `copy` 与 `move` 都拒绝顶层源是符号链接的情形，因为结果必须报告它复制的种类。
- **创建需要父目录存在**：`createFile` 与非递归的 `createDirectory` 都要求父目录已存在，否则以 `FS_NOT_FOUND` 拒绝；只有 `recursive: true` 的 `createDirectory` 会创建祖先。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
