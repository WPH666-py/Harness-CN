# Rebase runbook — Harness-CN onto upstream 0.2.1-rc.4

How our fork (`harness-0.1.5-rc.1`) was replayed onto `dsh-v0.2.1-rc.4`, what had to
be repaired by hand, and the gates that prove the result. Every command below was
run on this machine; the numbers are from those runs.

## 1. Materialise the tree

```powershell
# base (pristine upstream tag)
Invoke-WebRequest "https://codeload.github.com/deepseek-ai/deepseek-harness/zip/refs/tags/dsh-v0.2.1-rc.4" -OutFile dsh-v0.2.1-rc.4.zip
Expand-Archive dsh-v0.2.1-rc.4.zip -DestinationPath _work\base
# staging copy we edit
robocopy _work\base\deepseek-harness-dsh-v0.2.1-rc.4 _work\rebase-0.2.1 /E
```

`overlay/scan.mjs` produces `manifest.json` against a base; `overlay/triage.mjs`
attributes each difference; `overlay/replay.mjs --apply <tree>` copies our side in.

On this rebase the copy is driven by `policy.json`:

| list | meaning | 0.2.1 contents |
| --- | --- | --- |
| `ours` | our bytes win on conflict, and our-only files are copied | `apps/desktop*`, `apps/desktop-shell`, `rsc`, `overlay`, `packages/api/workspace-files`, `packages/fs/{fs,fs-local,fs-sandbox,tool-fs,node-vision}`, `packages/client/{ui-sidebar-files,ui-open-in-app}`, `packages/ssh/{ssh,fs-ssh}`, `packages/document/office-to-pdf` |
| `replace` | directory is deleted in the tree, then copied whole | same desktop/rsc set (a mirror, not a merge) |
| `base` | vendor bytes always win — even when we hold an edit | `tsconfig.host.json`, `tsconfig.client.json`, `packages/client/connection` |

Rule learned the hard way: **anything you intend to keep hand-edited must live in
`base`, not `ours`** — `--resolve` re-copies `ours` entries and silently undoes
manual work.

## 2. Environment prerequisites (not optional)

| requirement | why | value used |
| --- | --- | --- |
| `DSH_CLIENT_COMMIT_HASH` | the web build stamps a commit; this machine has **no git installed**, so the script cannot derive one | 40 zeros |
| `TMP`/`TEMP` inside the workspace | esbuild deletes its temp file and `remove` under `%LOCALAPPDATA%\Temp` returns `Access is denied`, failing the web build | `_work\tmp` |
| clean tree (no `lib/`, no `*.tsbuildinfo`) | `run-gates` compiles while `Host Typert` analyses; emitted `lib/types/*.d.ts` make Typert refuse with "the host program loads workspace build outputs instead of source" — and a stale `tsbuildinfo` can leave `lib/types/index.js` missing, which tsdown then reports as `UNRESOLVED_ENTRY` | delete `**/lib` outside `node_modules` |
| `--no-frozen-lockfile` on first install | our `apps/desktop-shell` deps (tauri cli, qrcode, tar, esbuild) are absent from the vendor lockfile | one-off |
| a registry that serves `xlsx` | `packages/client/ui-sidebar-documentpreview` pins `https://cdn.sheetjs.com/…`, which does not respond on this network | mirror tarball |

## 3. Repairs `replay` cannot express

`node overlay/post-apply.mjs <tree>` (idempotent; `--check` reports drift) applies
the three textual ones:

1. `packages/api/workspace-files/tsdown.config.ts`: `clientBundle('<pkg name>')` →
   `clientBundle(import.meta.dirname)` — 0.2.1 changed the helper's first argument.
2. `tsconfig.host.json`: add `{ "path": "./packages/fs/node-vision" }` to
   `references` — the package sat only in an include glob, so `tsc -b` never emitted
   `lib/types/index.js` and tsdown failed with `Cannot find entry`.
3. `apps/desktop/package.json`: add `"bundle": "tsdown --config-loader native"` —
   the release gate runs `pnpm --filter @deepseek-ai/dsh-desktop run bundle`.

Two more stay manual because they depend on the target tag:

- `tsconfig.base.json` and `tsconfig.client.json` must be the vendor's files, then
  `pnpm gen-tsconfig-paths` regenerates the alias map. One alias cannot be
  generated — our `packages/client/ui-settings-account-harness` directory name does
  not match its package name — so hand-add it before regenerating.
- Tests that assert APIs 0.2.1 removed or renamed were moved to
  `_work/dropped-tests/` rather than rewritten: `fs.watch`, `Config.read`, the
  `code-runtime` exports, `sessionCwd`, `createPluginProfile`, the old byte-range
  shape. They are coverage debt, tracked here on purpose.

## 4. Packaging prerequisites

`release:pack` compares the packed manifests, so the tree has to speak one language
before it will produce installers. Two scripts under `apps/desktop/scripts/` do that
(idempotent, `--check` reports would-be changes):

- `local-uniform-version.mjs <version> --root <tree>` — the family refuses to build
  when manifests disagree (`dsh release members must share one version`). After a
  rebase upstream packages still say `0.2.1-rc.4` while `apps/*` say the product
  version; this aligned 32 manifests.
- `local-workspace-protocol.mjs --root <tree>` — packed dependencies of shipped
  members must equal the family version, so every internal `@deepseek-ai/dsh-*`
  range becomes `workspace:*` (`must equal 0.2.1-rc.4, got ^0.2` otherwise). 5
  manifests carried ranges; 260 ranges were already `workspace:*` or `workspace:^`.

Then `pnpm --filter @deepseek-ai/dsh-desktop run prepare:package` packs 345 workspace
packages into `apps/desktop/.desktop-build/targets/win-x64/packed/dsh/`.

## 5. Gates

```powershell
$env:DSH_CLIENT_COMMIT_HASH='0000000000000000000000000000000000000000'
$env:TMP=$env:TEMP='D:\projects-py\Harness-CN\_work\tmp'
pnpm typecheck        # 5 gates
pnpm build:official   # 9 gates
```

Observed results on this rebase:

```
typecheck:       5 passed, 0 failed, 0 skipped in 70.45s
  host compiler 10.58s · host aggregate check 4.57s · Host Typert 63.54s
  client compiler 4.58s · client aggregate check 2.30s

build:official:  9 passed, 0 failed, 0 skipped in 101.01s
  native addon 1.81s · host compiler 2.44s · host aggregate check 30.18s
  Host bundle 51.38s · Desktop bundle 2.39s · client compiler 3.21s
  client aggregate check 12.68s · Client bundle 25.93s · Web build 13.84s
```

## 5. What upstream took over

`packages/client/ui-settings-account` in 0.2.1 is a strict superset of our
`ui-settings-account-harness`: same balance/bonus rows, sign-in/out dialogs, bonus
notice, 25 test files. The harness package was dropped and the desktop patch lost its
duplicate `account-controller` row. Follow-up: our "已登录 DeepSeek · 昵称" identity
line is gone until it is re-grafted onto the upstream section.
