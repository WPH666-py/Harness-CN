# Agent Note: Workspace file mutations

Status: implemented

[English](2026-09-10-workspace-file-mutations.md) | 中文

## Problem

Workspace Files 能读取文件，却无法修改文件。Web GUI 的文件管理器需要新建目录或空文件、删除条目、复制子树、移动或重命名条目，而 Host 既没有对应的 verb，文件系统能力也没有对应的原语：`FileSystem` 服务定义只暴露 `writeText`、`writeBytes` 和 `editText`，因此任何不是整文件写入的修改都没有可调用的实现。

这些操作还带来一个读取路径从未需要回答的策略问题。[Workspace file read authority](2026-09-09-workspace-file-read-authority.zh.md) 已经决定读取继承 Session 文件系统后端的权限，因此预览可以指名工作区之外的文件。而同样行为的删除或移动，会让客户端删除或搬走 Session 只被允许读取的文件。

## Decision

`@deepseek-ai/dsh-fs` 服务定义新增五个操作：`createDirectory`、`createFile`、`remove`、`copy`、`move`。每个操作接收由 `resolve()` 解析出的 `FsTarget`、一个可选 options 对象、一个可选的末尾 `AbortSignal`，以及一个可选的按调用生效的 `SandboxExecutionPolicy`，并返回说明其所创建或删除条目类型的 outcome。

`FsErrorCode` 集合新增两个成员。`FS_ALREADY_EXISTS` 表示 create、copy 或 move 的目标已被占用；既有的 `FS_NOT_OBSERVED` 指受保护的写入落到未读取的文件上，`FS_STALE_VERSION` 指调用方持有的版本已经改变，两者都无法表达单纯的目标冲突。`FS_NOT_EMPTY` 表示未带 `recursive` 的目录删除在目标之下发现条目。把任一者并入 `FS_IO_ERROR`，都会让每个调用方改为匹配消息文本。

该目录确定四项契约。目标已被占用的 create 直接失败，不合并也不覆盖。`copy` 与 `move` 要求目标不存在。`remove` 只有在带 `recursive` 时才删除非空目录，且位于目标处的符号链接会被拒绝而不是被解除链接。同一文件系统内的移动是一次 rename；跨文件系统时则先复制、再删除源，这不是原子操作，并且当删除失败时源可能仍然存在。最后这一事实同时写在 JSDoc 和每个 provider 的 README 中，因为它是调用方唯一不能盲目重试的结果。

`dsh-fs-local` 在 `src/fsio.ts` 中基于 `node:fs/promises` 实现全部五个操作，其中包括一个把链接复制为链接、而非跟随链接的递归复制，因此被复制子树内的链接无法从外部拉入内容。一个测试钩子可替换 rename 边界，跨设备回退路径正是借此在没有第二个挂载文件系统的情况下得到覆盖。

`dsh-fs-sandbox` 为这五个操作全部加围栏。包含性检查作用于删除所删除的条目、复制操作的目标，以及移动操作的**两端**：若缺少对源的检查，移动就会成为删除策略所保护条目的途径，而向工作区内移动则会从外部引入条目。多端操作的所有端在任何一端返回之前都会被重新规范化并逐一检查，因此双端移动绝不会以一端已校验、另一端未校验的状态开始。

`dsh-fs-e2b` 把这五个操作映射到控制器的 `makeDir`、`write`、`remove` 和 `rename`，并以一次读写遍历构建跨设备回退路径。E2B 只暴露递归的目录创建，因此非递归情形会在委派之前先核对父目录与既有目标；未带 `recursive` 的非空目录删除，则由 provider 自己取得列表后拒绝，而不是依据控制器的错误文本。

Host 的 `WorkspaceFiles` 服务在同一个 `workspaceFiles` 命名空间下新增 `createDirectory`、`createFile`、`remove`、`copy`、`move` 五个 Typert Remote verb，并使用与读取 verb 相同的 `workspaceFileScope` 查找。它们全部限定在工作区内：该查找给出 Session workspace root，目标据此解析，结果必须满足 `ctx.fs.contains(root, target)`。包含性检查复用 `list` 已经在用的判定，因此服务只有一套包含性机制而不是两套。工作区之外的路径以既有的 `workspace-file/outside-workspace` 拒绝，两个新的后端错误码映射为 `workspace-file/exists` 与 `workspace-file/not-empty`。

create 由父目录加一个路径段组成。该段必须匹配 `^[^/\\]+$`、不得为 `.` 或 `..`，且不得带首尾空白；随后子路径由受限父目录的 process path 与该段拼接而成。在拼接前校验路径段，正是防止名称抵达上级目录、其他卷或 `..` 逃逸的关键，而且因为线路不说明另一端运行在哪个平台，这一规则在两种路径约定下都成立。`copy` 与 `move` 拒绝被受限源所包含的目标，否则会把子树复制进自身，或让被移动的目录脱离自己的父目录。

Client 需要分支的三类拒绝是：`gateway/bad-request`，用于畸形名称、畸形路径、把工作区根作为复制或移动的源，以及目标嵌套在自身源之内；`workspace-file/outside-workspace`，用于任何解析到根之外的对象；以及上面两个新错误码。

## Alternatives considered

**只暴露一个带判别字段的通用 `mutate` verb。** 单一 verb 会在线路上引入四臂判别字段，并使每个调用方的参数都变成可选，而这五个操作除路径外没有共享参数。五个 verb 让每个参数列表保持必填，也让每处错误映射保持局部。

**复用 `writeBytes` 实现 `createFile`。** 创建空文件确实是一次合法的受保护写入（以空内容做 `createIfAbsent`），但它无法成为一个 Remote verb，除非客户端同时发送内容和 intent，而文件管理器的契约是“创建这个名称，若已被占用则失败”。独立的 `createFile` 把该契约表述一次，并放在执行该契约的操作里。

**为了对称，把读取也像修改一样限定在工作区内。** 上文读取权限决定已经否决：预览 Session 可读文件这一消费者不受这些 verb 影响。这种不对称正是重点：导航与修改描述工作区，指名读取不然。

**像 `cp -r` 那样，让复制合并进已存在的目标目录。** 合并会让结果取决于此前已存在的内容，于是部分失败与成功合并无法区分，Client 也无法告诉用户改动了什么。目标已被占用即拒绝，由调用方决定是否先删除它。

**在本地 provider 中跟随被复制子树内的符号链接。** 跟随会复制目标的内容，产出内容来自被复制根之外的目录树，而这正是工作区受限调用方绝不能收到的东西。链接被复制为链接。

## Consequences

文件系统接缝不再只是读取加整文件写入；新的后端必须实现另外五个成员，而抽象类让这件事成为编译错误而不是静默缺口。这些包之外的四个测试替身也因此必须实现它们。

跨设备移动不是原子的，子树复制也不是。JSDoc 同时写明这两点，并且 `remove` 被记录为一次要么完成要么失败的操作，而已失败的递归删除可能留下被部分删除的子树。没有任何后端能撤销它已经删除的条目，因此另一种选择是文件系统无法兑现的回滚承诺。

`WorkspaceFiles.remove` 拒绝工作区根本身。清空根使用 `contentsOnly`，它删除根所含内容并保留根，因此经由本服务无法删除 Session 的 workspace root。

三个 provider README 与两个包 README 都写明了操作集合、两个新错误码，以及非原子的移动。`dsh-fs` 的 README 不再声称该接缝只有十三个原语且没有 delete、rename 或 copy。

## Related

- [Workspace file mutation gestures](2026-09-10-workspace-file-mutation-gestures.zh.md) —— 文件树在这些 verb 之上的新建、删除、复制、剪切与粘贴手势，以及打开这棵树的 Session 头部控件。
