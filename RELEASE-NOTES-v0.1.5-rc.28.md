# Harness-CN 0.1.5-rc.28（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版修掉 rc.27 装上后**开屏即失败**的两个插件 pending，并第一次给安装包与主程序附上 Authenticode 签名（发布者 `水哥`）。

> **关于版本号**：`0.1.5-rc.28` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。家族版本、Tauri 与 Cargo 的版本文件、锁文件在本版一起前进，安装包因此带着自己所属的发行号。
>
> **rc.27 的全部改动都在本版里**：登录时授权页自动打开、离线包分卷发到 Gitee。逐条说明见 [RELEASE-NOTES-v0.1.5-rc.27.md](RELEASE-NOTES-v0.1.5-rc.27.md)；再往前的 rc.26（自定义数据目录、安装期预热、内置插件集、账号与赠金）见 [RELEASE-NOTES-v0.1.5-rc.26.md](RELEASE-NOTES-v0.1.5-rc.26.md)。
>
> **rc.27 开屏失败**：rc.27 装好后界面停在 `Failed to load plugins`，列出 `@lp181818/dsh-vision-plugin: pending (waiting for service: configForms)` 与 `@deepseek-ai/dsh-client-ui-settings-account-harness: pending (waiting for service: remote.account)`。请用 rc.28。
>
> **rc.25 的全新环境可能起不来**：rc.25 内置的 `desktop.cordis.patch.yml` 缺少 `directory-picker-mobile-host` / `directory-picker-mobile-surface` 两条禁用项，随包内置的第三方插件会插入自己的 `browse` 后端并与补丁插入的 `directory-picker-native` 争抢同一个单例服务，报 `service "directoryPicker" has been registered at <BrowseDirectoryPicker>`。请用 rc.26 或更新版本。
>
> **rc.21 的微信桥不可用**：rc.21 里 `dsh-wechat` 钉在 0.8.0，该版本的会话创建回调会读 `ctx.agent`，被 Cordis 拒绝后每条微信消息都只能回复「⚠️ 无法创建/恢复 DSH 会话」。请用 rc.23 或更新版本。
>
> **rc.22 装得上、但升不上去**：rc.22 重建已有 profile 时会被一份改写坏掉的 pnpm 记录与「把旧钉版当成用户插件」两步卡住。请用 rc.23 或更新版本。
>
> **rc.20 及更早不要再用**：它们带启动失败的 `ENOTEMPTY` 缺陷。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.28_x64-setup.exe` | 见发布页 | 安装程序（已签名） |
| `Harness-CN-seed-0.1.5-rc.28.tar.zst` | 见发布页 | 离线包（GitHub：整包） |
| `Harness-CN-seed-0.1.5-rc.28.tar.zst.part1of2` / `.part2of2` / `.parts.txt` | 见发布页 | 离线包（Gitee：分卷，见下文拼接方法） |

安装包与主程序**已用自签证书签名**，发布者名为 `水哥`。SmartScreen 看的是发布者信誉而不是签名有无：自签证书没有信誉，未导入该证书的机器**仍会**看到「无法识别的应用」提示（更多信息 → 仍要运行）；在导入了该证书的机器上，Windows 会把它显示成已验证的发布者。安装按用户进行，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、两个启动 pending 都修掉了（本版新增）

**现象**：rc.27 装好后不是聊天界面，而是启动失败页：

```text
Failed to load plugins
web boot: 2 entries did not activate
@lp181818/dsh-vision-plugin: pending (waiting for service: configForms)
@deepseek-ai/dsh-client-ui-settings-account-harness: pending (waiting for service: remote.account)
```

**机制**：Cordis 的 `inject` 未满足时，那条插件永远停在 pending，没有超时；本行线的 Client 会把**任何**未激活的行都算作失败（`packages/client/web/src/boot.ts`），于是一个第三方插件就能把整个 Web 界面拦在门外。

**`remote.account` 侧**：本行线的客户端装配（`packages/api/remotes/src/client/index.ts`）挂载 15 个固定的 Remote 贡献，其中没有 `account`；而账号行所在的客户端包又声明了 `inject = [… 'remote.account']`，等着别人提供这个命名空间。修法是从**自己**这一侧提供：`packages/client/ui-settings-account-harness/src/client/index.ts` 现在直接导入官方生成的贡献 `@deepseek-ai/dsh-api-account-controller/remote`，在 `apply` 的第一行 `await ctx.remote.$mount(accountRemote)`，并把这个卸载函数注册成**第一个** effect——Cordis 逆序回收，命名空间因此比状态流和账号行活得更久。`inject` 里不再列 `remote.account`（列了就是自指循环）。类型也不再手抄：本地那份 wire 事实改为 `TypertRemoteNamespaceMap['account']`，由外部包自己的 `declare module` 提供，同名增强的冲突（TS2717）因此消失。

**`configForms` 侧**：`@lp181818/dsh-vision-plugin` 的浏览器半边在 `apply` 开头读 `ctx.configForms.get('vision-plugin')`，而 `configForms` 是 0.1.7 线的插件配置表单服务，本行线没有任何提供者。本行线其实有同一件事的另一个名字（`SettingsScopeBinder` 提供的 `settingsScope`），但**不能**拿它冒充 `configForms`：同为内置且激活的 `dsh-chat-import@0.17.1` 会探测这个名字，一旦它存在就拒绝注册自己的设置页——修好一个插件会弄坏另一个。选择是让这个包**继续安装、继续钉在 1.2.3，但不再列进挂载集合**（`bundled-plugins.ts` 里 `active: false`，条目注释写明原因与证据）。种子清单的 `dependencies` 仍带它，`dsh.profile.bundles` 不再带它；全新 profile 与从 rc.28 种子重建的 profile 都拿到更短的列表。代价是它的设置页在应用里暂时不出现，直到上游那一线的服务名不再被注入。

**测试与记录**：`apps/desktop/tests/bundled-plugins.spec.ts` 钉住两半事实（已安装但不在 `bundledPluginNames()`；种子清单 `dependencies` 保留而 `dsh.profile.bundles` 不含）；账号包 8 个 spec、94 个用例全通过，其中新增对 `$mount` 调用与销毁时 `unmount` 的断言；决定与备选方案记在 [vision 插件那条 Agent Note](.agents/notes/implemented/bug-fix/2026-10-16-desktop-vision-plugin-config-forms.md) 里。

### 二、安装包与主程序已签名（本版新增）

**做法**：新增 `apps/desktop-shell/scripts/tauri-build.mjs` 作为 `tauri build` 的包装器。它按 `HARNESS_CN_SIGN_THUMBPRINT` → `HARNESS_CN_SIGN_SUBJECT`（默认 `CN=水哥`）→「证书库里唯一一张代码签名证书」的顺序找证书，找到就把 `certificateThumbprint` / `digestAlgorithm: sha256` / `timestampUrl` 传给 Tauri；找不到只打印一行警告并继续构建未签名产物，绝不因为签名缺席让构建失败。`HARNESS_CN_SIGN_TIMESTAMP_URL` 可改用别的时间戳服务。

**结果**：安装包、`harness-cn.exe` 都带 `CN=水哥` 的 Authenticode 签名与 DigiCert SHA256 时间戳；证书指纹 `5294D54832973EF06882BA10DCC4C7DA06FCA28C`，自签（Subject = Issuer），有效期到 2036-10-16。

### 三、桌面壳的更新提示走本地化（本版新增）

`apps/desktop/src/update-coordinator.ts` 以前在「没有可安装的更新」时直接塞一句中文进 `message` 字段，绕过两本字典。现在它只报原因（`reason: 'nothing-to-install'`），文案由 `apps/desktop/src/locale.ts` 的 `updateNothingToInstall` 按语言给出，`main.ts` 用一个助手在对话框里解引用。`verify-client-ui-i18n` 恢复绿色。

### 四、文档与门禁同步（本版新增）

`docs/subsystems/typert.{md,zh.md}` 的 `TypertCodec` 粘贴块补上惰性 `create` 工厂、`docs/subsystems/filesystem.{md,zh.md}` 的 `FsErrorCode` 补上 `FS_ALREADY_EXISTS` / `FS_NOT_EMPTY`，两处都与源码逐字段一致；`ui-primitives` 与账号包的 README 中英对偶补齐并重新登记；`THIRD_PARTY_NOTICES.md` 随新增的开发依赖重新生成。

## 本次发布的验证方式

- **客户端包**：`packages/client/ui-settings-account-harness` 8 个 spec、94 个用例全通过；`tsc -b` 该包 0 错误；`run-oxlint.ts` 0 警告 0 错误；进包的客户端半边 `lib/client.js` 191 850 字节（gzip 36 030 字节）——比 rc.27 大，因为生成的 account 贡献及其 `zod` 依赖内联了进来，这是打包器为 `/remote` 贡献明确放行的路径（`packages/client/tsdown.client.ts` 的 `GENERATED_REMOTE` 白名单）。
- **骨架门禁**：`verify-client-packages`（52 个客户端包）、`verify-package-dependencies`（61 包）、`verify-client-catalog`、`gen-tsconfig-paths.ts --check` 全部通过。
- **文档门禁**：`verify-type-equiv`（419 组粘贴块 1:1）、`verify-doc-budgets`、`verify-agent-note-format`、`verify-md-links`、`verify-package-readme-summaries`、`verify-third-party-notices`、`verify-translation-pairing` 通过。
- **运行时判定**：桌面 profile 的补丁层（`apps/desktop-host/config/desktop.cordis.patch.yml`）本就挂载 `deepseek-account` / `account-controller` 两行，Host 侧在服务这个命名空间；本版让浏览器侧也真的把它挂起来。
- **构建**：`build-harness-cn-tauri.ps1`（完整流程：`build:official` → `release:pack` → `prepare:runtime` → `prepare:packages` → `prepare:seed` → `tauri build`）产出安装包与离线包；签名与摘要见下节。
- **Web 前端是正常构建的**：本版没有改动 `apps/web/**` 的任何源码，`vite build` 照常产出 `dist`；重建得到的 chunk 名与 rc.27 已发布产物完全一致（`assets/index-C7yDRFbX.js` 523.62 kB、`assets/vendor-B8elsyXK.js` 741.11 kB），这正是渲染器源码未变时应有的结果。构建主机上有一条要先处理的主机状态：工作区根目录 `D:\projects-py\Harness-CN` 带一条显式低完整性标签（其下每条路径都继承它），于工作区之内启动的可执行文件都以低完整性运行，无法在用户临时目录里写或删——esbuild 的 `remove …: Access is denied.` 与种子里 pnpm 的 `EPERM … store\v11` 都是它。本版构建对 `apps/desktop/.desktop-build` 与 `node_modules/.pnpm/@esbuild+win32-x64@*` 执行 `icacls <dir> /setintegritylevel (OI)(CI)Medium` 摘掉标签，两步随即在未加任何改动的情况下通过；机制、证据与备选方案记在 [Agent Note：本构建主机上位于工作区内的构建二进制以低完整性级别运行](.agents/notes/implemented/bug-fix/2026-10-16-esbuild-oversized-temp-input.md)。
- **分卷工具在本次发布里修掉了一个真缺陷**：`scripts/release/split-offline-package.mjs` 原先把同一个 4 MiB 读缓冲直接交给 `fs.WriteStream`，而该流在写入完成前一直引用调用方的缓冲，下一次读会就地覆盖它——清单里算出的摘要正确，落盘的字节却可能已经被换掉。本次 rc.28 的第一版分卷正好中了这个竞态：两卷拼接出来的东西对不上整包 sha256。现在写入前先复制该块并尊重 `drain` 背压，逐卷摘要与清单一致、拼接结果逐字节还原整包。

### 本次实际发布

- **GitHub**：[`v0.1.5-rc.28`](https://github.com/WPH666-py/Harness-CN/releases/tag/v0.1.5-rc.28)（prerelease）——安装包与整包离线包。
- **Gitee**：[`v0.1.5-rc.28`](https://gitee.com/ph-wang/Harness-CN/releases/tag/v0.1.5-rc.28)——安装包、两卷离线包与分卷清单。
- **安装包**：`Harness-CN_0.1.5-rc.28_x64-setup.exe`，28 932 368 字节，sha256 `335BB3401EBFEC21CE655A304F6F4D5B722571FFAB0F862A6260D4AE2F96CDB4`；签名 `Valid`，发布者 `CN=水哥`，DigiCert SHA256 时间戳。
- **离线包（GitHub 整包）**：`Harness-CN-seed-0.1.5-rc.28.tar.zst`，128 009 651 字节，sha256 `96D648F1D629CA28CE6F5E064B5C6A83A8148B0144395F424380DB5E3AD026F8`。
- **离线包（Gitee 分卷）**：`.part1of2` 67 108 864 字节、`.part2of2` 60 900 787 字节，各自的 sha256 与拼接命令见同目录的 `.parts.txt`；两卷按清单顺序拼接后的摘要必须等于上面的整包 sha256。

## 已知限制

- **签名是自签的**：证书由本机生成，没有第三方 CA 背书。签名让文件可以被核对、让导入了该证书的机器显示「已验证的发布者」，但**不会**让别的机器少看一次 SmartScreen 提示。
- **离线包仍不在安装包里**：安装程序不带 seed，安装期 `--prebuild` 会先下载约 122 MiB 的离线包再重建。
- **Gitee 上的离线包是分卷**：两卷必须都下载后按 `….parts.txt` 的命令拼接，再按整包的 sha256 校验；只想拿整包的话请从 GitHub 下载。
- **首次启动仍要扫码**：`backend ready` 之前仍会等 `dsh-wechat` 的微信扫码往返（约 9–16 秒，超时上限 5 分钟）。它是随包安装的第三方插件，本版没有改动它。
- **冷启动成本只是被提前，没有消失**：安装期预热让用户首次启动不再独付这笔钱，但三万多个散文件的按名开销仍在。把桌面运行时打包成单文件属于架构级改动，本版未做。
- **运行时被占用时的提示是英文**：`desktop project: the Harness-CN runtime at … is in use and could not be moved; …` 与其它 `desktop project:` 错误一样直接显示在失败对话框里，尚未本地化。
- **Electron 开发外壳里点不开外部链接**：出货的 Tauri 外壳会把新窗口请求交给系统浏览器，因此授权页、充值页与用量页在正式应用里正常打开；仓库自带的 Electron 开发外壳拒绝一切新窗口，自动打开与链接在那里都没有反应。
- **vision 插件的设置页暂时缺席**：它仍随包安装，只是不再进挂载集合（原因见上文）。
- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
