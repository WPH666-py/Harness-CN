# Harness-CN 0.1.5-rc.11（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版内置社区插件 `@xbzbing/dsh-git-panel`（rc.10 曾说明未内置），并为此把它所依赖的共享高亮 API 补进基线。

> **关于版本号**：本发行版的 `0.1.5-rc.11` 是**发行版自己的版本**；它的**代码基线仍然是上游 `dsh-v0.1.5-rc.1`**，
> 并未包含上游 rc.2 及以后的内容（上游也没有发布过这些版本）。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.11_x64-setup.exe` | 26.55 MB（27,837,633 字节） | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.11.tar.zst` | 78.84 MB（82,665,115 字节） | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

SHA-256：

```
6314DCA25A0023836B3C0B9FE540155F532ED381AE5DDC96334402636D8986F8  Harness-CN_0.1.5-rc.11_x64-setup.exe
DB3DF29CA3C7727781BCDE69B66E9C995CED35ED97A6885CBBAFB08EF95419F6  Harness-CN-seed-0.1.5-rc.11.tar.zst
```

安装包**未签名**，首次运行会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

## 本版改动

### 一、内置 `@xbzbing/dsh-git-panel@1.4.0`（IDE 风格 Git 面板）

rc.10 曾明确说明**未**内置它，原因是它的两头都踩在本基线之上：

- **宿主半边**调用 `Schema.boolean(...).default(...).volatile()`，这是 `schemastery` 3.18.3 才有的方法，
  而基线 vendor 的是 3.18.2 —— 该行在加载时抛错。rc.10 已把 vendor 的 `schemastery` 抬到 3.18.4、`cosmokit` 抬到 1.8.5，
  这个缺口在 rc.10 里已经闭合。
- **浏览器半边**从 `@deepseek-ai/dsh-client-ui-primitives` 取两个导出：`languageForPath` 与 `useCodeHighlighter`。
  本基线**没有**这两个导出 —— 它们是上游在 `dsh-v0.1.5-rc.1` 之后新增的。本版把这一半补齐（见第二节）。

补齐后，该插件在本版是**完整内置并激活**的：分支/历史概览、未提交改动的提交与 amend、diff 统计，
以及输入栏里的分支标记。它的配置项（超时、字节上限、变更数上限、刷新间隔、默认 diff 视图）随 bundle patch 一并带上默认值。

> **一处如实说明**：该插件还会向名为 `plugins.bundle.config` 的插槽注册一个设置面板，而本基线没有声明这个插槽
> （它同样是上游后加的）。`slots.inject` 的语义是**等待声明**而不是失败，所以面板不出现，但**面板本身的功能不受任何影响**。
> 这是本版唯一一处已知的功能缺失，且不影响 Git 面板的主体使用。

### 二、为基线补上共享的代码高亮 API（`ui-primitives`）

这不是"新增功能"，而是**补齐消费者已经据此编译的约定**。新增 `packages/client/ui-primitives/src/code-highlighting.ts`：

| 导出 | 作用 |
| --- | --- |
| `languageForPath(path)` | 由文件名后缀得到高亮语言 id（大小写不敏感，识别两种路径分隔符） |
| `CODE_HIGHLIGHT_EXTENSIONS` | 全部可识别后缀，一个后缀一条 |
| `useCodeHighlighter(language)` | 把共享的惰性高亮器绑定到一种语言，并在该语言的语法加载完成后重渲染调用方 |
| `CodeHighlighter` | 其返回的函数类型 |

同时把两张语法表对齐到上游已发布的集合：`LANG_ALIASES` 45 → 108 条，`LAZY_GRAMMARS` 24 → 57 条。
**这一步不是可选的**：基线把"没有对应加载器"读作"语法已注册"，所以只补入口而不补表，会让新识别出的语言
（`.ps1`、`.tf`、`.rs` 等）带着未注册的语法进入 shiki 并抛错 —— 那比不做更糟。两张表都由上游已发布产物提取生成，
并校验了每个别名目标都有对应语法（当前零悬空）。

顺带的效果：`ReadBlock`、`CodeBlock` 与文档预览的语言提示现在能高亮更多语言（原先回退为纯文本）。
新增的 33 个语法**不进首屏**，按需切分为独立的 `langs/*` 分块（共 118 个）。

完整决策记录见 `harness-0.1.5-rc.1/.agents/notes/implemented/architecture/2026-10-10-client-code-highlighting-exports.md`。

### 三、统一 `micromark-util-types` 到 2.0.3（构建修复）

`mdast-util-from-markdown` 与 `micromark-extension-gfm` 各自锁定该**类型包**的 2.0.2，其余二十个依赖锁到 2.0.3。
两份的类型在 `exactOptionalPropertyTypes` 下互不兼容，`tsc -b tsconfig.client.json` 会以 `TS2769` 拒绝
`ui-primitives/src/markdown/parse.ts`。所有依赖方声明的都是 `^2.0.0` 或 `^2.0.3`，因此 2.0.3 对它们全部满足；
已在 `pnpm-workspace.yaml` 的 `overrides` 中统一，并在该处记录了理由。

这个冲突**先于本版改动存在**，只是被 `tsconfig.tsbuildinfo` 的增量缓存挡住了；清缓存后即暴露。

## 已知限制

- `@xbzbing/dsh-git-panel` 的设置面板在本基线不出现（缺 `plugins.bundle.config` 插槽），面板功能不受影响。
- `dsh-defend` 的会话日志审计在本基线上不可用（它需要基线无法设置的 `ignorable` 标记），
  插件会禁用该审计并告警一次；检测与拦截不受影响。此限制自 rc.10 起存在。
- `dsh-vault` 与 `@anionex/dsh-vision-toolkit` 为已安装但未激活（原因见 rc.10 说明）。
- `dsh-vault`：缺少 `DSH_VAULT_PASSWORD` 时拒绝加载（它 fail-closed 的设计），激活它会让缺少环境变量的机器无法启动。

## 本次发布的验证方式

- `pnpm run test:gui` 覆盖全部客户端与宿主面：**5399 项通过，1 项失败**。失败项是
  `ui-deliverables` 的符号链接拒绝用例，需要本 shell 不具备的 Windows 权限（`symlink` 报 `EPERM`），
  与本次改动无关，如实记录。
- `packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx` 覆盖新增入口：
  后缀映射的各类边界（大小写、两种分隔符、末段、前导点、未知后缀、dotfile、结尾点）、
  `Object.prototype` 的键会落空而非被解析、扩展名列表无重复；
  以及 `useCodeHighlighter` 的启动语法同步高亮、惰性语法"先纯文本、订阅触发后转高亮"、
  跨重渲染身份稳定、未知语言走纯文本分支。
- 完整构建（`build:lib` 全量类型检查 + `apps/web` Vite 打包）通过：前端产出 306 个客户端产物，
  含 118 个按需 `langs/*` 分块；`ui-primitives` 的 `lib/index.js` 与 `lib/types/code-highlighting.d.ts`
  确认包含上述三个导出。
