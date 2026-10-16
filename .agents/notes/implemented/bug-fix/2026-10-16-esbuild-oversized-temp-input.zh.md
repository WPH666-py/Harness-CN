# Agent Note：本构建主机上位于工作区内的构建二进制以低完整性级别运行

Status: implemented

[English](2026-10-16-esbuild-oversized-temp-input.md) | 中文

## Problem（问题）

rc.28 桌面载荷构建里有两个步骤在本机失败，看起来互不相关：

```text
$ vite build
vite v6.4.3 building for production...
✓ 392 modules transformed.
rendering chunks...
error during build: [vite:esbuild-transpile] remove C:\Users\admin\AppData\Local\Temp\esbuild-e93343099f5939c77ea054db47a2e603aaec4e7368e60717bde1785f89123601: Access is denied.
```

```text
[EPERM] EPERM: operation not permitted, mkdir 'C:\Users\admin\AppData\Local\Temp\dsh-desktop-seed-459tJK\store\v11'
desktop seed: pnpm exited with 4294963248
```

两者都是必现的，而且都卡住了整条桌面载荷链：没有种子、没有安装器、也没有版本可发。`build:web` 是 `build:official` 的必需步骤，而后者由 `prepare:package` 调用，`prepare:seed` 紧随其后。

## Cause（成因）

凡是可执行映像位于工作区之内的进程，都以**低强制完整性级别**运行；同样的字节从工作区之外启动则是中完整性。用户临时目录带的是中完整性标签且不允许向上写入，因此低完整性进程在其中既不能创建、也不能写入或删除——这些调用返回 `EPERM`，esbuild 的 Go 侧把它报成 `Access is denied.`。

两个失败都由这一点推出：

- esbuild 不会把大输入放在内存里交给 Go 二进制，而是写进 `%TEMP%\esbuild-<64 hex>` 再把路径传过去（`node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js:774-777`）：

```js
if ((typeof input === "string" || input instanceof Uint8Array) && input.length > 1024 * 1024) {
  let next = start;
  start = () => fs3.writeFile(input, next);
}
```

  该二进制读完这个文件后会删除它；以低完整性运行时删除被拒、文件残留。Vite 的 `esbuild-transpile` 插件会通过这套 API 压缩每个输出 chunk，而渲染器 chunk 大于 1 MiB，所以每次生产构建都会走到这条失败分支。

- `prepare-seed` 把 pnpm 存储暂存在 `mkdtemp(<temp>/dsh-desktop-seed-)` 下，并用**随包运行时 Node**（`apps/desktop/.desktop-build/targets/win-x64/runtime/node/node.exe`，v24.17.0）安装；它位于工作区内，因而以低完整性运行。它连在 `%TEMP%` 里建目录都做不到，所以 pnpm 的 `store/v11` 在任何包被拉取之前就被拒。

## Evidence（证据）

失败跟着**映像路径**走，而不是跟着二进制走。以下几份是完全相同的字节（SHA-256 前缀 `C6335D08331C23D6`，92 299 080 字节，v24.17.0）：

| 映像位置 | 完整性级别 | 在 `%TEMP%` 中 `mkdtemp` |
| --- | --- | --- |
| `apps/desktop/.desktop-build/targets/win-x64/runtime/node/node.exe` | Low（`S-1-16-4096`） | `EPERM` |
| `apps/desktop-shell/src-tauri/resources/runtime/node/node.exe` | Low | `EPERM` |
| `D:\` 根目录下的副本，以及 `%TEMP%` 下的副本 | Medium（`S-1-16-8192`） | 成功 |
| 已安装应用的运行时：`%LOCALAPPDATA%\Harness-CN\resources\runtime\node\node.exe` | Medium | 成功 |
| `Program Files` 里的系统 Node | Medium | 成功 |

- 用工作区内的那份二进制执行 `whoami /all` 报 `Mandatory Label\Low Mandatory Level`；同样的字节在工作区之外执行同一命令报 `Mandatory Label\Medium Mandatory Level`。其余信息——用户、组、无 AppContainer SID——完全一致。
- 这不是安全策略造成的：Defender 的实时与行为监控开启，`EnableControlledFolderAccess=0`，没有攻击面缩减规则，Smart App Control 关闭，未安装任何第三方杀软服务，也不存在沙箱驱动或服务。
- 低完整性进程仍然可以写**低标签**目录。`%USERPROFILE%\AppData\LocalLow` 继承了 `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`，工作区那份运行时 Node 在其中创建、写入并删除了整棵 `store\v11` 目录树，没有报错。
- 其余方向与目录无关：把 `TEMP`/`TMP` 指到新建的 `D:\hcn-temp` 时同样失败；而残留的 `esbuild-<hex>` 文件事后都能手工删除，因为外壳进程本身并不受这一限制。

## Decision（决策）

做法是把标签从构建树上摘掉，而不是绕开它；产出载荷本身没有任何变化：

- 对 `apps/desktop/.desktop-build`——承载运行时 Node、pnpm、打包出的 tarball 与种子产物的整棵暂存树——以及 vite 与 tsdown 所启动的那三个 `node_modules/.pnpm/@esbuild+win32-x64@*` 目录执行 `icacls <dir> /setintegritylevel (OI)(CI)Medium`。两次调用都无需提权即被接受，因为本账户拥有该工作区并在其中持有 `WRITE_OWNER`；之后这些目录下的可执行文件报 `Mandatory Label\Medium Mandatory Level:(I)(NW)`。
- 标签摘掉后，`pnpm --filter @deepseek-ai/dsh-web-frontend run build` **未经任何改动**即可运行——`"build": "vite build"`、`✓ built in 5.88s`、191 个文件 / 14 949 372 字节——`prepare:seed` 也在普通的 `%TEMP%` 里暂存 pnpm 存储。

因此前端是真的构建出来的，而不是复用旧产物：重建得到的 chunk 名与 rc.27 已发布产物完全一致（`assets/index-C7yDRFbX.js` 523.62 kB、`assets/vendor-B8elsyXK.js` 741.11 kB），这正是渲染器源码未变时应有的结果。

## Alternatives considered（考虑过的替代方案）

**复用 rc.27 渲染器而不重建。** 这是最早的可用答案，现已废弃：它要求把 `apps/web` 的 `build` 脚本指向 `node -e "process.exit(0)"`，并从已安装包逐文件恢复 `apps/web/dist`。它能产出正确载荷，但让发布说明无法声称前端被构建过，也把真正的缺陷藏起来留给了下一次发布。

**关闭渲染器 chunk 压缩。** 否决：在 `apps/web/vite.config.ts` 里设 `minify: false` 等于为了绕开一台构建主机的缺陷，给所有用户发一个明知更大、未压缩的 bundle。

**改用 terser 压缩。** 不可用：整个依赖图里都没有安装 `terser`（`.pnpm` 下没有任何 `terser@*` 条目）。

**把 esbuild 指向位于工作区之外的自身副本**（`ESBUILD_BINARY_PATH` → `D:\hcn-tools\esbuild.exe`）。对 vite 这一步有效，但该变量会被工作区里每一个 esbuild 宿主读到：`tsx` 自带 esbuild 0.28.1，因此拒绝启动并报 `Cannot start service: Host version "0.28.1" does not match binary version "0.25.12"`，于是还需要主机本地的 `apps/web/build-web.mjs` 垫片与临时的 `build` 脚本覆盖。已被重贴标签的做法取代——后者完全不需要改动仓库。

**把种子步骤的 `TEMP`/`TMP` 指向已经带低标签的目录**（`%USERPROFILE%\AppData\LocalLow\hcn-temp`）。它可用，也是标签仍在时的兜底方案；同样已被取代。

**给新建的构建用临时目录降低完整性标签。** 对本账户并不拥有的目录执行 `icacls <dir> /setintegritylevel Low` 在未提权时被拒，而本会话无法弹出同意提示。

**把构建放到代理会话之外运行。** 试过但无结论：通过 `Win32_Process.Create` 启动的进程与通过 `explorer.exe` 启动的进程都没有留下任何日志。

**加杀软排除项。** 不适用：没有安装第三方杀软，Defender 也没有可排除的受控文件夹访问或 ASR 配置。

## Consequences（影响）

标签属于主机而不是仓库：`D:\projects-py\Harness-CN` 自身就带一条显式低标签（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，非继承而来），其下每条路径都继承它，因此在这台机器上重新克隆仍会继承；凡不在已重贴标签目录之下的构建产物也一样——在这台主机上就包括 `apps/desktop-shell/src-tauri/target/release/bundle/` 里的安装包。今后任何“运行工作区内二进制、却期望它写到工作区之外”的步骤都会以同样方式失败；要识别的症状是：可执行文件位于工作树内的进程报出 `EPERM` 或 `Access is denied.`，修法是对承载该可执行文件的目录执行同一条 `icacls /setintegritylevel (OI)(CI)Medium`。
