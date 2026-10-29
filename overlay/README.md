# overlay —— 我们相对于上游到底改了哪些文件

Harness-CN 不是从源码分叉出去、然后自己维护一份完整副本的项目。它的绝大多数文件是上游
`deepseek-ai/deepseek-harness` 的原始文件，只有一小部分是我们的：外壳、打包、web 侧的几处、
以及少数几个上游包的补丁。

问题在于，**上游升级时没有任何东西告诉你这个边界在哪里**。`git diff` 不再可用（这里没有 git，
发布物是解压的源码包），而"哪些文件是我们的"这个知识只存在于过去几周的对话和记忆里。一次
不谨慎的 rebase 就会把某个我们改过的文件换回厂商版本——和 `apps/desktop/scripts/patch-*.mjs`
防的是同一类事故，只是发生在源码层而不是运行时。

这个目录把边界变成数据。

## 三个文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 机器读的清单：我们新增的每个文件（含 sha256）、修改过的每个文件（含我们的和基线的 sha256）、以及被删除的文件 |
| `scan.mjs` | 重新生成清单：拿一份解压好的上游源码树当基线，逐文件比对 |
| `replay.mjs` | 用清单做事：`--check` 验证某棵树是否还完整带着 overlay；`--apply` 把新增文件复制到新基线上 |

## 用法

```powershell
# 重新生成清单（需要一份上游源码：从 tag 下载 zip 解压即可）
node overlay/scan.mjs --base D:\_work\base\deepseek-harness-dsh-v0.2.2-alpha.2 --write

# 验证一棵树（比如重放后的新基线、CI 上刚解压的发布物）
node overlay/replay.mjs --check <tree>

# 把我们的新增文件铺到一棵新基线上；改动过的文件默认不动，只列出来等人工决定
node overlay/replay.mjs --apply <tree>            # 只复制新增文件
node overlay/replay.mjs --apply <tree> --take-ours # 改动过的也用我们的覆盖（危险，需复核）
```

## 分层：rebase 时先看层，再看文件

清单里每个路径都带 `layer`，因为不同层的处理策略完全不同：

| layer | 含义 | 升级时怎么做 |
| --- | --- | --- |
| `shell` | `apps/desktop-shell/`、`apps/desktop-host/`：Tauri 外壳、窗口、内嵌服务器、传输层 | 整体保留，只在被上游协议变更影响时改 |
| `packaging` | `apps/desktop/`：打包脚本、seed 管线、`patch-*.mjs` | 整体保留；`patch-*.mjs` 必须重新 `--check` |
| `web` | `apps/web/`：前端 | 逐文件比，尽量回到上游，我们的改动越少越好 |
| `upstream` | `packages/`：上游自己的包，我们改了少数几个 | **最危险**：每个都要判断是"修上游 bug"还是"已被上游修好" |
| `monolith` | `mono/`：独立单体实现 | 整体保留（与上游无关） |
| `meta` | 根配置、脚本、文档、`.agents/` 笔记 | 尽量跟随上游 |

## 基线必须同版本，否则清单会骗人

`scan.mjs` 只做文本比对，它不知道"这个差异是上游自己改的还是我们改的"。如果基线选错，上游
在两次发布之间的正常改动会被算成我们的修改，清单立刻失去意义。

选择基线的方法很简单：**对几个候选 tag 各跑一次，取 `removed` 为 0、`modified` 最少的那个**。
`removed` 先说话：只有基线里的每个文件在我们树里都存在，它才可能是我们的出发点。本仓库实测：

| 候选基线 | added | modified | removed | 结论 |
| --- | --- | --- | --- | --- |
| `dsh-v0.1.5-rc.1` | 349 | 406（137 真改动 + 269 版本号） | 0 | **采用**：`removed` 为 0，`modified` 最小 |
| `dsh-v0.1.5-rc.3` | 2136 | 462 | 7 | 更差 |
| `dsh-v0.1.6-alpha.2` | 530 | 3312 | 2082 | 目录结构已变，不是我们的出发版本 |
| `dsh-v0.2.2-alpha.2` | 1457 | 5003 | 10814 | 差了一整代 |

### 基线不精确的部分，清单会如实保留

即便是最接近的 `rc.1`，也不是逐字节的出发版本：我们的树比这些 tag 都新一点
（`packages/e2b/fs-e2b/src/index.ts` 在我们树里 926 行，在 rc.1/rc.3 里都是 628 行；
`packages/client/connection/src/rpc.ts` 我们 269 行、tag 251 行）。这类差异来自上游在 tag
之后继续提交的工作，它和"我们自己的修改"在文本比对里长得一样，都记成 `kind: "edit"`。

所以 `packages/` 层的 84 条 `edit` **不要**当成"我们改过的"，而是"需要逐条判断的清单"：
带着我们指纹的（产品串、中文说明、`Harness-CN` 字样）是我们改的；其余多半是上游在我们出发
点之后的正常改动。`--apply --take-ours` 在这一层等于把上游的修复一起丢掉——所以它默认不做。

被排除在比对之外、也不该进清单的路径：依赖与构建产物（`node_modules`、`dist`、`target`、
`lib/*.js|*.d.ts|*.map`、`vendor/*/lib`、`apps/desktop/.desktop-build`、
`apps/desktop-shell/dist-artifacts`、`website/.generated`）、本地数据（`data`、`_work`）、
清单自身（`overlay/manifest.json`），以及一份文件是另一份的拷贝
（`apps/desktop-shell/rsc/` → `src-tauri/resources/shell/`）。

## 和 `verify:overlay` 的分工

- `overlay/` 管**源码层**：升级、rebase、重新铺基线。
- `apps/desktop/scripts/verify-overlay.mjs` 管**运行时层**：安装完以后，7 个 `patch-*.mjs` 是否
  还锚得住、注入的样式类是否还在厂商的 bundle 里。它跑在真实 profile 上，是发布前的门禁：

```powershell
node apps/desktop/scripts/verify-overlay.mjs            # 默认检查已安装的 desktop profile
node apps/desktop/scripts/verify-overlay.mjs --seed <seed 目录>   # 打包机上顺带检查 seed 的插件决策
```

状态含义：`applied` 已生效、`anchor ok, applies` 还没打但锚点完好、`ANCHOR GONE` 上游改写了
锚点（必须修）、`not installed` 这棵树里没有该包（不算失败）。

## 归因：`overlay/triage.mjs`

清单只说"和基线差在哪"，不说"这处差异是谁写的"。我们的树比基线 tag 新，所以差异里混着两种东西：
我们的改动，和上游在 tag 之后自己提交的工作。靠眼睛逐条猜，rebase 时要么丢掉我们的改动，要么丢掉
上游的修复。

`triage.mjs` 按证据强弱判定，每条结论写进 `overlay/triage.json`：

1. **与更晚的 tag 字节相同** —— 那份内容是上游产出的，我们只是持有。
2. **改动行在更晚 tag 中的占比 ≥60%** —— 路径搬过、文件被重排也认得出；同时按同名文件搜索。
3. **只有版本行** —— `bump` 会重写，不需要决定。
4. **产品指纹** —— `Harness-CN`、`HARNESS_CN_*`、`shell-api`、`stream-mux`、中文 UI 文案，以及
   `apps/desktop*`、`mono/` 这类只属于本仓库的目录。
5. **包内多数票** —— 同一个包里已知归属的文件 ≥80% 一致时，没有指纹的文件跟随多数。

判不出来的一律不猜成"我们的"：写进 `overlay/triage-review.md`，每条附三行真实差异供人读。宁可留
一个待决项，也不要静默丢掉上游的修复。

```powershell
node overlay/triage.mjs --base <基线树> --corpus <更晚的 tag> [--corpus …] --write --review
```

`replay --apply` 读 `triage.json`：`mechanical` 交给 bump；`upstream` 取基线版本；只有 `ours` 和
`unknown` 进入待决清单。
