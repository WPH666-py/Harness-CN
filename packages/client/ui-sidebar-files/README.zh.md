---
description: "dsh Web 客户端右侧 Sidebar 的文件树 tab 类型：逐层经线上列出会话工作区根目录，按资源地址把文件打开到 Sidebar，并可新建、删除、复制与移动条目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

[English](README.md) | 中文

## 概述

右侧 Sidebar 的导航器 tab 类型：把会话的工作区根目录画成一棵树，逐层经线上列出，把文件打开到 Sidebar 里，并在列目录之上补上文件管理器的那几个操作。它是从引导页进入的页类型，不认领任何地址；它按地址打开文件，交给 `dsh-resource://file` 的查看器认领：`ui-sidebar-right` 里没有任何东西认识本包。

## 目录

- [注册了什么](#what-it-registers)
- [树](#the-tree)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `files`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-files`，档位 `builtin`，没有 patterns，另有一个打开该类型的引导页入口（order 10，标题与描述取自 `sidebarFiles` 命名空间，图标是共享的文件夹图标）。
- **正文**：以该 id 为键的 `sidebar.right.pane.tab` 坑位：strip 下的一行标题行，然后是树。标题行与文档预览（`ui-sidebar-documentpreview`）的相同：根路径，目录部分灰色、最后一段正色，从不省略号截断（比行宽的路径保留末尾、淡出开头），右端是文件操作与重新读取。这一行是复制而非共享，因为插件 bundle 只经平台模块共享运行时代码；待 artifact 与各 slot 的形态定下来后，可以在 `ui-primitives` 放一份供每个 pane 标题行使用。
- **标签页标题**：以该 id 为键的 `sidebar.right.pane.tab.title` 坑位：类型标签前的一枚 16px 共享 `FileTypeIcon` 文件夹图标。树本身的行不画这枚图标。
- **会话标题栏控件**：以 id `workspace-files` 注册进 `conversation.session.header.utilities` 列表坑位的 `FilesToggleAction`，一枚图标：把文件树打开到右列，或在文件树正是右列当前显示的 tab 时把这一列折叠起来。动手那一刻才去读列自己的服务，因此控件自身不保存状态。

`src/client/` 下八个源文件：`definition.tsx`（类型是什么）、`store.ts`（它保存什么）、`face.ts`（它如何列目录、如何改动条目，含 Remote 绑定）、`FilesBody.tsx`（它画什么，含排序、失败行与落点三个辅助函数）、`FilesTitle.tsx`（标签页标题）、`FilesToggleAction.tsx`（会话标题栏控件）、`locales.ts`（它说什么）、`index.ts`（接线）。

<a id="the-tree"></a>
## 树

根是会话的工作目录，读自 `useSessions().byId[sessionId].cwd`，标题行里的拆分由 `@deepseek-ai/dsh-util-workspace-path` 的 `pathPartsOf` 给出。每一层以绝对路径为键；子路径是父路径以 `/` 拼上条目名。一层在首次展开时经 `@deepseek-ai/dsh-api-workspace-files` 命名空间的 `remote.workspaceFiles.list(sessionId, absolutePath)` 列出；适配层保留列表的条目与截断标志，丢弃其工作区相对路径。行序为目录优先，其后按自然序、不分大小写的名称排列；dotfiles 与其他条目一样显示。

| 条目类型 | 行 |
|---|---|
| `directory` | 切换展开与折叠；该层在首次打开时拉取，折叠期间保留。 |
| `file` | 经 `useTabInfo().tab.actions.openResource` 打开 `dsh-resource://file/session/<sessionId>/<encoded path relative to the root>`，地址由 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` 从条目的绝对路径与树的根生成，落在该 tab 自己的 pane 里。 |
| `other` | 灰显且不可点击，使目录被完整报告。 |

被端点条目上限截断的层以一条标记收尾；空层如实说明；失败的层按错误码各显示一行（`workspace-file/not-found`、`outside-workspace`、`not-directory`），其他情况显示传输层自己的消息。重新读取丢弃所有已列出的层并只对展开中的层重新请求；折叠的层在下次打开时重新拉取。没有工作目录的会话只显示一行说明，而不是树。

行同时也是文件管理器的行：读者选中一行，标题行的控件就作用在这个选择上——选中的是目录就用它，是文件或什么都没有就用树的根。右键在同一行上打开同样的操作：打开（打开或折叠）、复制、剪切、粘贴（仅目录）、删除。新建会在父目录下显示一个内联的名字输入框，回车提交、Escape 或失焦取消；在 Host 接受这个名字之前输入框一直开着，所以被拒绝的名字会保留读者已经输入的文本。删除会先在面板里等一次确认，才去调用 Host；删除目录时连同其中的全部内容一起删除。

新建、删除与粘贴各自给出自己的落点：新建的条目落在选定目录下，删除的条目由它所在的行指名，粘贴把源条目自己的名字放到那里。Host 拒绝已存在的落点，因此不会覆盖、也不会合并；落地成功的粘贴会重新列出它改动过的目录——落点，以及剪切离开的那个目录。剪切落地后会释放剪贴板，并忘掉被移走子树的层级、展开状态与选择；复制则留在剪贴板上。被拒绝的操作会在树的顶部显示对应的一行（`workspace-file/exists`、`workspace-file/not-empty`、`workspace-file/not-found`），而不是什么都不做。

状态住在类型自己的存储里，按 tab id 分桶：`root`、`levels`（每个绝对路径的 loading / ready / failed）、`expanded`、读者选中的 `selected` 行、下一次粘贴要放置的 `clipboard`、名字输入的 `draft`，以及上一次操作的 `notice`。owner 的 `signal` 终结一个桶：中止时忘掉该 tab，其后才结算的列表或改动什么也不写。

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器里绘制工作区文件树，不注册任何面向模型的内容。

#### KV Cache 影响

无；目录列表经 Remote 传输，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **只有列目录与文件操作。**没有搜索、产物过滤、拖拽、重命名、标出查看器正在显示的那个文件，或文件系统监听；一层只会因重新读取或本面板自己发起的操作而变化。
- **只有一个根。**树以会话工作目录为根；没有办法浏览到它之上，而 Host 本来也拒绝工作区根之外的路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。树唯一的运行时状态是每 tab 一份的 Slot store，由持有它的正文写入、随 tab 的中止信号忘掉；没有第二个观测源可与之比对。
