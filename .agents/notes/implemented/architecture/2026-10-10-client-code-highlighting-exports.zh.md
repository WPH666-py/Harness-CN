# Agent Note：为第三方客户端 bundle 补全共享代码高亮 API

Status: implemented

[English](2026-10-10-client-code-highlighting-exports.md) | 中文

## 问题

`@xbzbing/dsh-git-panel` 在 Web GUI 中渲染文件内容与 diff。它的客户端 bundle 就是一个 `window.__ModuleLoader__.load` 工厂，只从模块表请求三个模块：`react`、`react-dom` 和 `@deepseek-ai/dsh-client-ui-primitives`。最后一个是平台词——shell 在 `packages/client/web/src/seed.ts` 里把它种进静态表，所以请求能解析——而该 bundle 会在解析出的命名空间上调用 `languageForPath(path)` 和 `useCodeHighlighter(language)`。

这两个导出在本基线上都不存在。于是 bundle 能成功实例化，却在属性访问处抛错，整个客户端半边随之失效，而没有任何模块解析层面的诊断指向它：插件看起来已安装，就是永远不出现。任何按更新的上游编写的客户端 bundle 都是同样的情形——失败形态是命名空间对象上缺一个属性，而不是缺一个模块。

同一个包的宿主半边有形状相同的缺口，已另行通过把 vendor 的 `schemastery` 提升到 3.18.4、使 `Schema.boolean(...).default(...).volatile()` 存在而闭合。

## 决定

**共享高亮器的"文件名到语言"入口属于 `ui-primitives`，本基线现在发布它。** 新模块 `packages/client/ui-primitives/src/code-highlighting.ts` 拥有后缀表、`languageForPath`、`CODE_HIGHLIGHT_EXTENSIONS`、`CodeHighlighter` 类型与 `useCodeHighlighter`，并由 `src/index.ts` 重新导出。

**上游已发布的产物是这里所缺 API 的事实来源。** 两个导出取自已发布的 `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.2`——签名取自它的 `code-highlighting` 声明，`useCodeHighlighter` 函数体取自它的 bundle——后缀表取自已发布的 `@deepseek-ai/dsh-util-code-language@0.1.7-rc.2`，即上游把该表抽出去后的那个包。这里的任何东西都不是本地设计的：消费者已经据此编译的那个形状才是需求。

**导出本身很薄。** `useCodeHighlighter` 就是上游那一行：`useCallback(code => highlightLines(code, language), [language, useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)])`。那个订阅是承重的而非装饰性的——本基线的 `highlightLines` 对语法尚未注册的语言返回 `undefined`，所以已经画了纯文本回退的调用方需要这个订阅触发的重渲染。`subscribeGrammarLoaded` 与 `grammarLoadCount` 本就存在于 `src/markdown/highlight.ts`，仍保持包内私有。

**语法表必须一起动，否则这个入口就是个陷阱。** `languageForPath` 依据一张覆盖 57 种语言的后缀表解析，而 `highlightLines` 先把提示经 `LANG_ALIASES` 解析，再加载 `LAZY_GRAMMARS` 指名的语法。只发布更宽的这个入口，会让该函数对三个启动语法之外的一切**静默**失效：`ensureGrammar` 把"没有加载器"读作"已注册"，于是指向空语法的别名会送进 shiki 并在渲染器内部抛错。因此 `LANG_ALIASES`（45 → 108 条）与 `LAZY_GRAMMARS`（24 → 57 条）被逐条扩展到上游已发布的集合。

**两张表都由已发布 bundle 生成，并检查了闭合性。** 用脚本从上游产物提取条目，而不是手工誊抄，并断言每个别名目标要么是启动语法、要么是 `LAZY_GRAMMARS` 的键。该断言正是这条不变量的守护者：更宽入口现在能识别的文件，不可能以未注册状态抵达 shiki；它当前报告零悬空目标，且 57 个 `@shikijs/langs` 子路径都已确认存在于已安装的 4.3.1 树中。

**`readLangHintForPath` 有意未移植。** 上游加它是为了 read 工具持久化的 `lang` 提示，而本基线在 `packages/fs/tool-fs/src/read-render.ts` 中生成该提示。移植它会给一个"已记录会话持有的精确字节"的值引入第二个生产者。

## 考虑过的替代方案

- **发布上游的 `dsh-util-code-language` 与更新的 `ui-primitives` 包。** 否决：本发行版只带一个基线，而在 shell 种入的静态表旁边再放一份 `ui-primitives` 副本，会让同一个 import 拥有两个身份——这正是平台词存在的意义所在。
- **不扩展语法表，只在已支持的 24 种语言上发布这两个导出。** 否决：`languageForPath` 随后会对高亮器无法解析的文件返回 `powershell` 或 `hcl`，而 `ensureGrammar` 的"缺失加载器"路径会把它变成抛错，而不是纯文本回退。
- **自己重写一张精简的惯用表。** 否决：决定兼容与否的是消费者已编译的约定，而每一处分歧都只会在事后、在 GUI 里以一个静默无高亮的代码块形式暴露。
- **不声明 `plugins.bundle.config`，指望插件大声失败。** 无此必要：`slots.inject` 会等待声明而非失败，所以该插件的设置面板缺席，而面板本身照常工作。把这记为一条限制，比凭空造一个本基线从不渲染的插槽更诚实。

## 后果

- 受影响的基线文件：`packages/client/ui-primitives/src/code-highlighting.ts`（新增），外加 `src/markdown/highlight.ts` 中的 `LANG_ALIASES` 与 `LAZY_GRAMMARS` 两张表，以及 `src/index.ts` 中的两行导出。
- 更宽的表改变了既有界面的高亮行为：`ReadBlock`、`CodeBlock` 与 `ui-sidebar-documentpreview` 的语言提示，现在能识别此前回退为纯文本的语言。`supportsHighlighting` 对更多提示返回 true，而这只会选出高亮分支；`.ps1`、`.tf`、`.rs`、`.fish` 等后缀由纯文本变为高亮。
- 新增的 33 个语法不进启动 chunk。`apps/web` 把它们产出为 118 个独立的按需 `langs/*` chunk（57 语法 × script + map），因此首屏负载不变，从不打开这类文件的会话也永不下载。
- 本基线上该插件的设置面板缺席，因为这里未声明 `plugins.bundle.config`。`@xbzbing/dsh-git-panel` 通过 `slots.inject` 注册其中，而它会等待声明；面板的其他部分不依赖它。
- 这闭合了"已发布客户端 bundle 所 import 的"与"本基线所导出的"之间最后一个已知缺口。下一个同类缺口仍会以缺属性而非缺模块的形式出现，所以要对症的诊断是：把 bundle 的 `require` 说明符与静态表的导出名做一次比对扫描。

## 测试

`packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx` 覆盖该入口：`languageForPath` 的后缀到语法 id 映射（大小写、两种分隔符、末段、前导点、未知后缀、dotfile、结尾点）、`Object.prototype` 的键会落空而非被解析、扩展名列表无重复；对 `useCodeHighlighter` 则覆盖启动语法同步高亮、惰性语法先纯文本而后在订阅触发后转为高亮、高亮器身份跨重渲染稳定、未知语言走纯文本分支。`highlightLines` 自身的惰性语法行为仍由 `read-block.client.spec.tsx` 覆盖。

改表之后跑了覆盖整个客户端与宿主面的 `pnpm run test:gui`：5399 通过、1 失败。失败项是 `ui-deliverables` 的符号链接拒绝用例，需要本 shell 不具备的 Windows 权限（`symlink` 报 `EPERM`），与本次改动无关，此处如实报告而非掩盖。

## 相关

- [Harness-CN GitHub 发布通道](2026-10-07-harness-cn-github-release-channel.md) 拥有分发这些 bundle 的那一侧；本 note 拥有"基线必须导出什么，其中一个 bundle 才能加载"这一侧。
