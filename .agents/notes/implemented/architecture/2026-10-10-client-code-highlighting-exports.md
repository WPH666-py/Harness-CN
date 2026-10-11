# Agent Note: Completing the shared code-highlighting API for third-party client bundles

Status: implemented

English | [中文](2026-10-10-client-code-highlighting-exports.zh.md)

## Problem

`@xbzbing/dsh-git-panel` renders file contents and diffs in the Web GUI. Its client bundle is one `window.__ModuleLoader__.load` factory and takes exactly three module requests from the table: `react`, `react-dom`, and `@deepseek-ai/dsh-client-ui-primitives`. The last of those is a platform word — the shell seeds it into the static table from `packages/client/web/src/seed.ts`, so the request resolves — and the bundle calls `languageForPath(path)` and `useCodeHighlighter(language)` on the resolved namespace.

Neither export existed on this baseline. The bundle therefore materialized successfully and then threw on the property access, which takes the whole client half down with no module-resolution diagnostic to point at; the plugin looks installed and simply never appears. The same is true for every other client bundle written against a newer upstream: the failure is a missing property on a namespace object, not a missing module.

The host half of that package had the same shape of gap, closed separately by raising the vendored `schemastery` to 3.18.4 so `Schema.boolean(...).default(...).volatile()` exists.

## Decision

**The shared highlighter's filename-to-language entry point belongs to `ui-primitives`, and this baseline now publishes it.** A new module `packages/client/ui-primitives/src/code-highlighting.ts` owns the suffix table, `languageForPath`, `CODE_HIGHLIGHT_EXTENSIONS`, the `CodeHighlighter` type, and `useCodeHighlighter`, and `src/index.ts` re-exports them.

**Upstream's published artifacts are the source of truth for the API we were missing.** The two exports were taken from the published `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.2` — its `code-highlighting` declaration for the signatures and its bundle for the `useCodeHighlighter` body — and the suffix table from the published `@deepseek-ai/dsh-util-code-language@0.1.7-rc.2`, which is the package upstream extracted it into. Nothing here was designed locally; the shape a consumer already compiles against is the requirement.

**The exports are thin.** `useCodeHighlighter` is the one-liner upstream ships: `useCallback(code => highlightLines(code, language), [language, useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)])`. The subscription is load-bearing rather than decorative — this baseline's `highlightLines` returns `undefined` for a language whose lazily imported grammar has not registered yet, so a caller that drew the plain fallback needs the re-render the subscription triggers. Both `subscribeGrammarLoaded` and `grammarLoadCount` already existed in `src/markdown/highlight.ts` and stay internal to the package.

**The grammar tables had to move with it, or the entry point would be a trap.** `languageForPath` resolves against a suffix table covering 57 languages, and `highlightLines` resolves a hint through `LANG_ALIASES` and then loads the grammar named by `LAZY_GRAMMARS`. Shipping the wider entry point alone would have made the function *silently* useless for everything outside the three boot grammars: `ensureGrammar` reads a missing loader as "already registered", so an alias pointing at no grammar reaches shiki and throws inside the renderer. `LANG_ALIASES` (45 → 108 entries) and `LAZY_GRAMMARS` (24 → 57) were therefore extended to upstream's published sets, entry by entry.

**Both tables were generated from the published bundle and checked for closure.** A script extracts the entries from the upstream artifact rather than transcribing them by hand, and asserts that every alias target is either a boot grammar or a `LAZY_GRAMMARS` key. The assertion is what keeps the invariant that files the wider entry point now recognizes cannot reach shiki unregistered; it currently reports no dangling target, and each of the 57 `@shikijs/langs` subpaths was verified present in the installed 4.3.1 tree.

**`readLangHintForPath` was deliberately not ported.** Upstream added it for the read tool's persisted `lang` hint, and this baseline generates that hint in `packages/fs/tool-fs/src/read-render.ts` instead. Porting it would introduce a second producer of a persisted value whose exact bytes recorded sessions already hold.

## Alternatives considered

- **Publish the upstream packages `dsh-util-code-language` and the newer `ui-primitives`.** Rejected: the distribution carries one baseline, and a second copy of `ui-primitives` beside the shell-seeded static table would give the same import two identities, which is exactly what the platform word exists to prevent.
- **Do not extend the grammar tables; publish only the two exports over the 24 languages already supported.** Rejected: `languageForPath` would then return `powershell` or `hcl` for files the highlighter cannot resolve, and the missing-loader path in `ensureGrammar` turns that into a throw rather than a plain-text fallback.
- **Reproduce a minimal idiom table of our own.** Rejected: it is the consumer's compiled contract that decides what is compatible, and every divergence would be found later, in a GUI, as a silently plain code block.
- **Leave `plugins.bundle.config` undeclared and expect the plugin to fail loudly.** Not needed: `slots.inject` waits for a declaration instead of failing, so the plugin's settings pane stays absent while the panel itself works. Recording it as a limitation is more honest than inventing a slot this baseline never renders.

## Consequences

- Affected baseline file: `packages/client/ui-primitives/src/code-highlighting.ts` (new), plus the `LANG_ALIASES` and `LAZY_GRAMMARS` tables in `src/markdown/highlight.ts` and the two export lines in `src/index.ts`.
- The wider table changes what existing surfaces highlight: `ReadBlock`, `CodeBlock`, and `ui-sidebar-documentpreview`'s language hints now recognize languages they previously fell back to plain text for. `supportsHighlighting` returns true for more hints, which only ever selects the highlighting arm; `.ps1`, `.tf`, `.rs`, `.fish`, and comparable suffixes render highlighted instead of plain.
- The 33 added grammars stay out of the boot chunk. `apps/web` emits them as 118 separate on-demand `langs/*` chunks (57 grammars × script + map), so the initial payload is unchanged and a session that never opens such a file never fetches one.
- The plugin's settings pane is absent on this baseline because `plugins.bundle.config` is not declared here. `@xbzbing/dsh-git-panel` registers into it through `slots.inject`, which waits for a declaration; nothing else about the panel depends on it.
- This closes the last known gap between what published client bundles import and what this baseline exports. The next such gap will again present as a missing property rather than a missing module, so the diagnostic to reach for is a scan of the bundle's `require` specifiers against the exported names of the static table.

## Testing

`packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx` covers the entry point: suffix to grammar id via `languageForPath` across the table's shape (case, both separators, final segment, leading-dot, unknown, dotfile, trailing dot), that `Object.prototype` keys miss rather than resolve, that the extension list has no duplicates, and — for `useCodeHighlighter` — that a boot grammar highlights synchronously, that a lazy grammar renders plain first and re-highlights after the subscription fires, that the highlighter identity is stable across re-renders, and that an unknown language yields the plain arm. The lazy-grammar behavior of `highlightLines` itself stays covered by `read-block.client.spec.tsx`.

`pnpm run test:gui` was run over the whole client and host surface after the table change: 5399 passed, 1 failed. The failure is `ui-deliverables`' symlink refusal case, which needs a Windows privilege this shell does not hold (`EPERM` from `symlink`), is unrelated to this change, and is reported rather than silenced.

## Related

- [Harness-CN GitHub release channel](2026-10-07-harness-cn-github-release-channel.md) owns the distribution side that ships these bundles; this note owns what the baseline must export for one of them to load.
