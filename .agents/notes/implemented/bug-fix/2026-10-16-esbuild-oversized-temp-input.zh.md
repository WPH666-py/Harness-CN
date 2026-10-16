# Agent Note：本构建主机上超大 esbuild 输入无法删除其临时文件

Status: implemented

[English](2026-10-16-esbuild-oversized-temp-input.md) | 中文

## Problem（问题）

本机上每一次跑到 Web 前端的发布构建都死在同一个位置，而转换阶段其实已经成功：

```text
$ vite build
vite v6.4.3 building for production...
✓ 392 modules transformed.
rendering chunks...
error during build: [vite:esbuild-transpile] remove C:\Users\admin\AppData\Local\Temp\esbuild-e93343099f5939c77ea054db47a2e603aaec4e7368e60717bde1785f89123601: Access is denied.
```

调用栈指向 `esbuild/lib/main.js:718`，所以故障在 esbuild 内部，而不在渲染器源码里。由于 `build:web` 是 `build:official` 的必需步骤、而后者又被 `prepare:package` 调用，这一个错误就卡住了整条桌面载荷链：没有安装器、没有种子、也没有新版本可发。

## Cause（成因）

esbuild 的 JavaScript API 不会把大输入放在内存里交给它的 Go 二进制，而是把输入写到 `os.tmpdir()` 下的临时文件，再把路径传过去（`node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js:774-777`）：

```js
if ((typeof input === "string" || input instanceof Uint8Array) && input.length > 1024 * 1024) {
  let next = start;
  start = () => fs3.writeFile(input, next);
}
```

文件名形如 `esbuild-<64 位十六进制>`（`main.js:2096`）。二进制读完后会 unlink 该文件，而在本机上这个 unlink 以 `Access is denied.` 失败——这是 Go 的错误文案，不是 Node 的 `EACCES`，所以消息读起来是 `remove <path>: Access is denied.`。文件因此被留在原地。Vite 的 `esbuild-transpile` 插件会经这个 API 压缩每个产出的 chunk，渲染器的 chunk 超过 1 MiB 阈值，于是每次生产构建都会走到这个失败分支。

## Evidence（证据）

用三个探针脚本在 Vite 之外复现（它们不属于仓库，调查期间放在工作树里，发布提交前已删除）：

- 大于 1 MiB 的输入在所有模式下都失败：`transform` 与 `build`、`minify: true` 与 `minify: false`、Promise 与同步 API。每次尝试都会在临时目录留下一个 `esbuild-<hex>` 文件，并打印同样的 `remove ...: Access is denied.`。
- 低于阈值的输入正常；同一个探针用被故意截断的源码（产生了 758 个语法错误）也正常返回，说明二进制本身能跑。
- 与版本无关：`esbuild@0.21.5`、`0.25.12`、`0.28.1` 表现完全一致，各自对应自己的 `@esbuild/win32-x64` 二进制。
- 与目录无关：把 `TEMP`/`TMP` 指到一个全新的空目录 `D:\hcn-temp` 仍复现，只是错误里的路径换了。
- Node 不受影响：用 Node 在同一个目录写入并删除一个 1.5 MB 文件耗时 0 ms，且事后每个遗留的 `esbuild-<hex>` 都能手动或用 Node 删掉。
- 遗留文件的 ACL 是普通的继承权限（`SYSTEM`、`Administrators`、用户本人都是完全控制），也没有只读属性，所以拒绝不是文件本身的静态权限。
- 拒绝也不是安全策略：`Get-MpPreference` 显示没有任何攻击面缩减规则、`EnableControlledFolderAccess=0`、实时保护开启；没有第三方杀毒服务在跑（`LAVService`、`HRWSCCtrl` 已不在本机）；`whoami /all` 在 shell、其 Node 子进程、以及 WMI 拉起的进程里完全一致——同用户、同组、中等完整性、无 AppContainer SID。本机没有沙箱服务或驱动，普通子进程里 `DSH_*` 变量为空。

## Decision（决定）

rc.28 的桌面构建复用已发布 rc.27 线本来就在服务的 Web 前端，而不重建它：`apps/web/dist` 从已安装的 `@deepseek-ai/dsh-web-frontend` 包逐文件还原（125 个文件，5.13 MB），并把 `apps/web` 的 `build` 脚本临时指向 `node -e "process.exit(0)"`。第一次尝试替换的是 `apps/web/node_modules/.bin` 下的 `vite` 启动器，pnpm 在下一次链接时把它们重建了回来，所以空操作放在 pnpm 实际调用的脚本上。两处改动都只作用于本机，在发布提交前还原，也不改变任何受跟踪行为：本次发布携带的桌面侧修复（账号命名空间挂载、vision 插件下架、更新对话框文案）都不在 `apps/web` 内。

## Alternatives considered（考虑过但未采用）

**对渲染器关闭 chunk 压缩。** 否决：在 `apps/web/vite.config.ts` 里设 `minify: false`，等于为了绕开一台构建主机的缺陷，向该版本的所有用户发布一个明知更大的未压缩包。

**改用 terser 压缩。** 不可行：整张依赖图里没有安装 `terser`（`.pnpm` 下没有任何 `terser@*` 条目），而为此把一个新的压缩器塞进发布路径会改变该版本产出的每一个产物。

**在 agent 会话之外运行构建。** 尝试过但无结论：经 `Win32_Process.Create` 启动和经 `explorer.exe` 启动的进程都没有留下任何日志，因此都不能证明失败与会话相关。上面的证据指向 esbuild 二进制的 unlink 调用，而不是进程树——因为同一会话里的 Node 在同一个目录删除同样的文件是成功的。

**加杀毒排除项。** 不适用：本机没有安装第三方杀毒，Defender 也没有受控文件夹访问或 ASR 配置可供排除。

## Consequences（后果）

rc.28 的安装器与种子在新版本号下携带的仍是 rc.27 的渲染器字节，而这本来就是桌面产品已在服务的版本；本次发布没有任何待发的 Web 可见改动。不会复现该 unlink 失败的机器可以正常重建 `apps/web`，上面的临时改动不属于任何提交。写下这篇 note 是为了让下一次在本机构建的发布不必重新发现 1 MiB 阈值：如果 `build:web` 以 `remove <temp>\esbuild-<hex>: Access is denied.` 失败，那就是输入对 esbuild 的内存路径而言过大，前端可以复用而不必重建。
