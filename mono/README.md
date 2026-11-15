# Harness-CN Mono（单体重构骨架）

目标形态对齐 ChinaClaude：**薄壳 + 零依赖 Node bridge + 单个前端 bundle + 懒启动重活**。

## 为什么是骨架而不是一次替换

现有产品是 Cordis 插件平台：275 个 npm 包、23 个插件、19.5 MB 客户端载荷、启动 29 s。
单体化要重写的能力面是这些（月级工作量），所以这里是**第 1 阶段**：把主干跑通并量化，
让后续每个能力有明确落点，而不是把现有产品改死。

## 本阶段已实现

| 能力 | 状态 | 说明 |
|---|---|---|
| 单进程 bridge | ✅ | `node src/server.mjs`，仅 node: 内置模块，零 npm 依赖 |
| 会话持久化 | ✅ | 每会话一个 JSONL，落在 `data/sessions/` |
| 流式对话 | ✅ | `POST /api/sessions/:id/messages` → SSE（`delta`/`tool`/`approval`/`tool_result`/`denied`/`done`） |
| 工具循环 | ✅ | `read_file` `write_file` `list_dir` `grep` `run_shell`，最多 12 轮 |
| 工作区约束 | ✅ | 所有路径 `resolve` 后必须落在会话 cwd 内 |
| **1 审批与权限门** | ✅ | 三档模式 `ask` / `auto` / `read-only`；破坏性命令在 `auto` 下也必须确认；决定落盘为 `approval` 记录 |
| **2 模型 + 强度** | ✅ | 会话级覆盖，持久化，未知模型回退到目录内的默认值 |
| **3 轨迹 UI** | ✅ | 工具调用折叠卡、内联审批卡、三档选择器、token 用量 |
| **4 上下文压缩** | ✅ | 超预算时把旧消息折叠成摘要（系统提示永不折叠、最近 K 条原样、原文仍在 JSONL）；MONO_CONTEXT_BUDGET / MONO_KEEP_RECENT 可调 |
| **5 附件与图片** | ✅ | POST /api/attachments 收图（≤5 MiB，仅 png/jpeg/webp/gif），GET /api/attachments/:id 取回；转录只存 id，base64 只在发请求时生成 |
| **6 旧会话迁移** | ✅ | `node src/migrate.mjs`：按 zstd 魔数切帧解码 DSH 的 `session.v3.jsonl.zstd`，映射 user/assistant/tool 消息，空会话跳过，幂等可重跑 |
| **7 壳层切换** | ✅ | HARNESS_CN_MONO=1 时 Tauri 壳跳过种子/profile，改为拉起 mono bridge 并代理全部 /api；实测 bridge 就绪 **0.36 s**、窗口由 mono 提供、SSE 穿壳层完整、退出时子进程被回收、数据落在 data/mono |
| 前端 | ✅ | 单个 `public/index.html`（内联 CSS/JS，无构建） |
| 无模型环境自测 | ✅ | `MONO_FAKE_MODEL=1` 走脚本化流，验证循环与门逻辑而不烧 token |

`node test/smoke.mjs` 覆盖以上全部，63 项断言（含打包布局检查）。

## 未实现（迁移清单，按收益排序）

1. **子代理 / 工作流 / 技能 / MCP / LSP / 终端**：全部未迁，这是与现有产品最大的功能差。
2. **会话搜索、导入（除 DSH 迁移）、导出**：未迁。
3. **工具面收窄**：现在只有 5 个工具（read/write/list/grep/shell），现有产品有几十个。
4. **流式工具输出**：`run_shell` 一次性返回，长命令没有增量输出。
5. **审批的策略记忆**：同一命令每次都要确认，没有「本会话内一律允许」。
6. **移动端门、局域网配对**：壳层已有，`HARNESS_CN_MONO=1` 时直接复用，无需另做。
7. **重启菜单**：mono 模式下 `restart` 仍走壳层的就地重启，会重新拉起 bridge。

## 与现有产品的关系

- 现有 `harness-0.1.5-rc.1` 保持可用，不动。
- 单体在 `mono/` 独立演进，达到下表「可直接替换」的判据后再谈切换：

| 判据 | 目标 |
|---|---|
| 冷启动到可输入 | ≤ 2 s |
| 前端载荷 | ≤ 400 KB |
| 单轮对话 + 工具调用 | 与现有产品行为一致 |
| 长会话 200 轮不崩、上下文可控 | 需要压缩能力 |
| 会话文件格式 | 需要与现有 JSONL 兼容或明确一次性迁移 |

## 壳层里的两种模式

| 模式 | 启动方式 | 后端 | 数据目录 |
|---|---|---|---|
| 默认（dsh） | 直接双击 | dsh Host + 275 包 | <install>/data/{profiles,sessions} |
| 单体（mono） | 设 HARNESS_CN_MONO=1 再启动 | mono bridge（零依赖） | <install>/data/mono |

两种模式共用同一个壳层、同一个控制面端口、同一套移动端门；切回默认只要去掉环境变量。

## 运行

```powershell
cd mono
$env:DEEPSEEK_API_KEY = '...'        # 或 DEEPSEEK_BASE_URL
node src/server.mjs                   # 默认 127.0.0.1:7801
```

自测（不调真实模型）：

```powershell
$env:MONO_FAKE_MODEL = '1'
node src/server.mjs
```
