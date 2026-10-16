# Harness-CN 0.1.5-rc.26（Windows x64 桌面发行版）

基于上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.5-rc.1` 的第三方发行版。
本版解决 **157 秒启动、最后以 `EPERM` 失败** 的缺陷，并顺着同一条启动路径做了两项提速：Harness-CN 从此拥有自己的数据目录，与 DSH NEXT 可以并存；安装期会先把运行时预热一次，首次启动不再独自承担冷启动开销。

> **关于版本号**：`0.1.5-rc.26` 是发行版自己的版本；代码基线仍是上游 `dsh-v0.1.5-rc.1`。
>
> **rc.25 的全新环境可能起不来**：rc.25 内置的 `desktop.cordis.patch.yml` 缺少 `directory-picker-mobile-host` / `directory-picker-mobile-surface` 两条禁用项，随包内置的第三方插件会插入自己的 `browse` 后端并与补丁插入的 `directory-picker-native` 争抢同一个单例服务，报 `service "directoryPicker" has been registered at <BrowseDirectoryPicker>`。请用 rc.26。
>
> **rc.21 的微信桥不可用**：rc.21 里 `dsh-wechat` 钉在 0.8.0，该版本的会话创建回调会读 `ctx.agent`，被 Cordis 拒绝后每条微信消息都只能回复「⚠️ 无法创建/恢复 DSH 会话」。请用 rc.23 或更新版本。
>
> **rc.22 装得上、但升不上去**：rc.22 重建已有 profile 时会被一份改写坏掉的 pnpm 记录与「把旧钉版当成用户插件」两步卡住。请用 rc.23 或更新版本。
>
> **rc.20 及更早不要再用**：它们带启动失败的 `ENOTEMPTY` 缺陷。

## 下载

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `Harness-CN_0.1.5-rc.26_x64-setup.exe` | 见发布页 | 安装程序 |
| `Harness-CN-seed-0.1.5-rc.26.tar.zst` | 见发布页 | 离线包：Node + pnpm + 插件树 + 预热的包存储 |

安装包**未签名**，首装与每次更新都会有 SmartScreen 提示（更多信息 → 仍要运行）；按用户安装，不需要管理员权限。

**装之前请先读 [SYSTEM-REQUIREMENTS.zh.md](SYSTEM-REQUIREMENTS.zh.md)**：该页写明这台机器需要什么、不需要什么，以及代理/镜像/自签证书/手动离线包各自怎么配。

## 本版改动

### 一、Harness-CN 使用自己的数据目录，与 DSH NEXT 并存（本版新增）

**现象**：启动画面停在 157 秒后弹出 `Harness-CN 启动失败 / EPERM, Permission denied: \\?\C:\Users\admin\.dsh\profiles\desktop`；日志显示这段时间里全量重建了一遍运行时（下载离线包 57 秒、展开包存储 32 秒、链接 30 110 个文件 38 秒、校验 5 秒、激活重试 17 秒）。

**根因**：Harness-CN 与 DSH NEXT 默认共用同一个 `~/.dsh`。DSH NEXT 已经接管了 `profiles/desktop`，于是 Harness-CN 每次都判定「运行时与发行版不匹配」并整棵重建；重建完成后激活需要把活动 `profiles/desktop` 改名让位，而那时 DSH NEXT 的 Host 正占着这棵目录——Windows 会拒绝改名并报 `EPERM`。ACL 已核验干净，这是占用问题，不是权限问题。

**修复**：

- 新增 `apps/desktop/src/product-home.ts`，导出 `adoptHarnessCnHome(env)`：在两个桌面入口（`apps/desktop-shell/src/shell-main.ts` 的 `prebuild` 与 `main`、`apps/desktop/src/main.ts`）解析任何 desktop 路径之前，把未设置或空白的 `DSH_HOME` 指向 `%USERPROFILE%\.harness-cn`；显式设置的 `DSH_HOME` 仍然优先，`packages/util/home-paths` 继续以 `~/.dsh` 作为引擎默认值。
- 首次在新 home 启动时会尝试把旧 `~/.dsh` 的**用户数据**复制过来（`sessions/`、`storages/`、`attachments/`、`.credentials.yaml`、`.env`、`AGENTS.md`、`.anonymous-user-id`）。只复制、绝不删除或移动旧数据；`desktop/`、`profiles/`、`recovery/`、`electron-user-data/` 等运行时与产品私有目录一律不复制。
- **两个产品都装在同一台机器上时**：一旦在旧 `~/.dsh` 里发现 DSH NEXT 的痕迹（`logs/desktop-next*`、`profiles/desktop/desktop-next*` 或带 `desktopNext` 的 profile 清单），本次就**不做任何复制**，新 home 从空开始，并且不写迁移标记——每次启动都会重新判断。日志里会写明留下了哪些文件：

  ```text
  home: D:\...\.harness-cn; C:\Users\admin\.dsh also carries the DSH desktop product
  home: leaving C:\Users\admin\.dsh untouched (…\logs\desktop-next.log, …\profiles\desktop\package.json)
  ```

- 迁移结果记录在 `<home>/home-migration.json`；单条复制失败只记入报告并留待下次重试，不影响启动。

### 二、激活失败不再删掉正在运行的运行时（本版新增）

**现象**：EPERM 之后应用并没有回到「旧运行时仍可用」的状态，反而把活动 `profiles/desktop` 删掉了，并留下 `pending.json` 停在 `active-moved`。

**根因**：`DesktopProjectManager.activate()` 的 `catch` 里第一件事是 `removeOwnedDirectory(this.paths.profile)`——当「把活动 profile 移开」这一步本身就失败时，profile 路径上的东西正是用户正在使用的那棵运行时；删掉它把真正的错误替换成了清理错误。

**修复**（`apps/desktop/src/project-manager.ts`）：

- **只在动作落地之后写 journal**：`prepared` 写在移开之前，`active-moved` 写在移开之后，`staging-activated` 只在替换成功之后写，因此最后一步就是「该提交、还是该修复」的提交记录。
- **`catch` 只做修复**：`settleActivation(activeMoved)` 只在本次事务确实移开过运行时的情况下把回滚副本放回原位；失败就保留 journal 留给下次启动重试。绝不删除活动 profile。
- **占用可诊断**：三处改名失败如果返回 `EPERM`/`EACCES`/`EBUSY`，会换成一句可执行的说明——`desktop project: the Harness-CN runtime at <路径> is in use and could not be moved; close every Harness-CN window and any other program using this home, then start again`；其它错误原样保留。
- **恢复可见**：`recover()` 返回恢复报告，两个外壳把它逐行写进日志（`activation recovery: …`），并会丢弃「已被替换」的旧副本。

### 三、重建运行时更快（本版新增）

包存储的合并此前是 22 399 次串行 `copyFileSync`。现在 `apps/desktop/src/seed-store.ts` 的 `copyStoreEntries` 按 2048 条一批并发复制，逐条目判定（`needsStoreCopy`）不变。在同一台机器、全新 home、缓存好的 0.1.5-rc.25 离线包下测量：仓库阶段 44.4 秒 → 34.7 秒，整个 `--prebuild` 78.7 秒 → 65.3 秒。

### 四、安装期预热运行时，首次启动不再冷启动（本版新增）

**现象**：健康启动本身也要 87 秒，其中外壳只占 3.2 秒；应用日志里 `desktop runtime already matches the bundled release` 之后是 70.1 秒静默，再往后是约 15.8 秒微信扫码往返。同一份 profile 在文件已被系统打开过时，同一台 host 只用 15 秒就报告就绪。

**修复**（`apps/desktop-shell/src/shell-main.ts`）：`prebuild` 在运行时安装/校验完成之后调用新的 `warmRuntime`，从活动 profile 启动一次 Host、等到就绪、再停掉，并写一行 `desktop runtime warmed: dsh <版本> in <秒> s`。预热失败只记一行 `desktop runtime warm-up failed: <原因>`，安装程序仍以 0 退出、首次启动行为不变。预热刻意不放进 `applyRelease` 的 `healthCheck`（那是激活前的暂存树校验），因此它不影响激活或回滚。

### 五、内置插件再添三个（本版新增）

**做法**：全新的桌面 profile 现在多装三个插件，三者都随桌面种子安装（版本精确钉在 `apps/desktop/src/bundled-plugins.ts`），也都在新 profile 里直接启用：

- **`@furongjun1999/dsh-memory` 0.8.1**：长期项目记忆，Hindsight 之外的另一套「灵枢」记忆体系。它是本发行版内置的最大插件——npm 记录 1594 个文件、未压缩 42.4 MiB，其中大部分是随包发布的 Python 知识库与技能文档；它不会在启动时做耗时预置，代价只体现在安装体积上。
- **`@lp181818/dsh-vision-plugin` 1.2.3**：为纯文本模型补上识图能力，配置入口在它自己的设置页。它与内置的 `@anionex/dsh-vision-toolkit` 是两个不同的插件——后者保持不激活，因为它首次运行要现装约 35 MB 的 Python 运行时。
- **`dsh-workbuddy-connect` 0.6.5**：把 WorkBuddy 桌面应用自带的模型服务接成一个 `llm-workbuddy` provider。选 0.6.5 而不是最新版，是因为 0.7.0 起它把所有 dsh peer 钉死在 0.2.0-rc.2 那条线上，而本发行版的代码基线是上游 `dsh-v0.1.5-rc.1`；0.6.5 声明的 peer 范围覆盖本线的所有 seam，它唯一的线外依赖 `@earendil-works/pi-ai` 已经由内置的 `dsh-llm-pi-ai` 提供，不需要额外随行包。

### 六、DeepSeek 账号登录与赠金领取（本版新增）

**做法**：桌面端现在可以登录 DeepSeek 账号。

- **账号一节**：设置里新增「账号」。这一行不带任何说明文案，点开就是账号界面本身；只有在登录尝试进行中时才多出一行状态。未登录时提供登录（在浏览器中完成授权）与取消；已登录时把余额分成「充值余额」与「赠金余额」两行显示，并提供「充值」「查询用量」入口与退出登录（退出前会先检查是否有正在使用该账号的任务）。
- **赠金到账**：登录后若平台有未通知的赠金，界面会在账号入口处显示一张非模态的「赠金已到账」卡片，文案由服务端提供、原样显示；展示后客户端会向平台确认该笔赠金（同一笔只确认一次，失败时按 1 秒起、逐次翻倍、上限 60 秒的延迟重试），确认成功后刷新余额。客户端不做轮询：只在账号进入登录态与打开设置时各读一次。已过期的赠金通知直接丢弃。
- **实现方式**：宿主侧直接采用官方 npm 包 `@deepseek-ai/dsh-deepseek-account-platform` / `@deepseek-ai/dsh-api-account-controller`（0.1.7-rc.2，赠金读取与确认只存在于这个版本），随桌面种子安装、由桌面专用的 Host 补丁层挂载——因为共享的 bundle 补丁会被所有 profile 加载，在那里插入一个只有桌面种子才会安装的包会让其它 profile 的插件树加载失败。浏览器侧不能直接用官方客户端包：它注册的三个 slot（`settings.launcher`、`settings.models.sign-in`、`shell.quota-notice`）在本发行版的客户端里都不存在，装上也不会渲染任何入口，所以这一节由本仓库自己的 `@deepseek-ai/dsh-client-ui-settings-account-harness` 承担。

### 七、typert codec 兼容：兼容惰性 schema 工厂（本版新增）

**现象**：把官方账号包挂上去后，桌面宿主在启动时报 `typert-loader: ... parameter codec is not backed by a zod v4 schema`，整棵插件树加载失败、应用起不来。

**根因**：同一个 typert 声明存在两种生成形式。本仓库的生成器产出急切的 `schema: <ZodType>`，而较新的官方包改成惰性工厂 `create: () => ZodType`（具名 schema 记录同样从 `{ name, schema }` 变成 `{ name, create }`）。

**做法**：让读取 codec schema 的每一处（typert loader、registry、API gateway 的宿主与客户端）同时接受两种形式；本仓库自己的生成器仍只产出急切形式，因此所有已提交的产物逐字节不变。校验依旧严格：两种形式都没有声明的 codec 仍然会让该行与整棵插件树在启动时失败。

## 本次发布的验证方式

- **两个产品并存实测**：在同一台机器上、DSH NEXT 正常运行的情况下，用 `DSH_HOME` 指向全新的 home 跑 `--prebuild`，日志确认选择了新的 home 并写明「leaving `C:\Users\admin\.dsh` untouched」；旧 home 的文件数与 mtime 未变。
- **端到端 `--prebuild` 实测**（全新 home、缓存离线包）：总 65.3 秒 = 离线包校验 1.50 + 仓库阶段 34.69 + profile 链接 23.55 + 暂存校验 5.13 + 激活 0.021 秒；随后新增的预热 boot 报告 `desktop runtime warmed: dsh 0.1.5-rc.25 in 15 s`，且没有留下游离的 host 进程。
- **单元测试**：`apps/desktop/tests` 26 个文件 208 通过；唯一失败是既有的 `macos-signature.spec.ts` 在 Windows 上超时（与本次改动无关）。新增 4 个用例覆盖：中断的激活会恢复旧运行时、已提交的替换会丢弃超集副本、无法移开活动运行时时的 profile 保持不变、以及一句可读的「运行时正在被占用」；Home 行为另有 `product-home.spec.ts` 9 个用例。
- **类型与 lint**：`tsc -p apps/desktop-shell/tsconfig.check.json` 与 `tsc -b tsconfig.host.json` 均以 0 退出；`tsx scripts/run-oxlint.ts .` 为 69 个错误、0 个警告，逐位置比对与改动前的基线完全一致（仅因新增行发生行号位移），**没有新增任何 lint 问题**。
- **sidecar 产物**：`node scripts/build-sidecar.mjs` 重建 `shell.mjs`（375 291 字节，sha256 `68E7792B4A45AF762C4595EF41CFF6916AA75959FDAF047BFE9D16EC66AE1EC1`）。
- **Agent Note 与文档门禁**：`verify-agent-note-format`（336 篇）、`verify-agent-note-classification`（336 篇）、`verify-translation-pairing`、`verify-md-links`（1595 个文件）全部通过；新增中英双语笔记 `2026-10-16-desktop-install-time-runtime-warmup`，并更新了 fix 1/2 与 fix 3 的两篇笔记。
- **发布物自检**：`scripts/release/verify-harness-cn-release.mjs <版本> <目录>` 把安装包与离线包在本机、GitHub、Gitee 三处逐一比对 sha256，全部一致才算发布完成。
- **本次实际发布**：GitHub 上的 `v0.1.5-rc.26`（prerelease）已发布，两个资产都从 release URL 回读校验过：安装包 28 841 549 字节、sha256 `1f753d4e2ccbff368bd22f522d5e198f3df0e02575daba2be9a3408539b60dea`；离线包 128 144 369 字节、sha256 `2ef3e44044c648188d38390ed4bc4a9af7ad39070d0f3dbd8fed3d64d89f980a`，两者与本地构建产物逐字节一致。Gitee 本次未发布（缺 token），三处比对只完成了 GitHub 与本地两处。离线包解压后有 591 365 632 字节，其中含 `dsh-client-ui-settings-account-harness`（69 处路径命中）、三个新内置插件与三个账号包，且不含官方客户端包 `dsh-client-ui-settings-account`。

### 本版新增内容（账号与赠金）的验证

- **客户端包测试**：`packages/client/ui-settings-account-harness` 的 8 个 spec、93 个用例全部通过；按 `--coverage.include='packages/client/ui-settings-account-harness/src/**'` 跑覆盖率，`All files` 为 100/100/100/100（逐文件门禁），未覆盖位置一栏为空。
- **类型与注册面**：`tsc -b tsconfig.client.json` 以 0 退出；`verify-client-packages` 报 52 个客户端包（47 个动态、5 个静态）满足包模式与模块请求规则；`gen-client-catalog.ts --check` 与 `gen-tsconfig-paths.ts --check` 都报已是最新。本包的三处注册面齐全：`tsconfig.client.json` 的 references、`packages/bundle/web-app/package.json` 的依赖，以及桌面 Host 补丁层里的那一行。
- **产物**：客户端半边 `lib/client.js` 33 929 字节（gzip 9 506 字节），宿主半边 `lib/index.js` 388 字节；产物中不含 `dshDesktop`（本版不用它做门禁）。
- **进包情况**：桌面包集共 243 个包，其中含本包打出的 `deepseek-ai-dsh-client-ui-settings-account-harness-0.1.5-rc.26.tgz`（22 350 字节，解包后 `lib/client.js` 与本仓库构建产物 sha256 逐字节一致，含 `package.json`、`lib/index.js`、`lib/types/**` 与中英双语 README）；种子清单 `seed/package.json` 把它写成 `file:./desktop-packages/…-0.1.5-rc.26.tgz`，`seed/integrity.json` 与 `seed/profile-links.json` 都记录了它；**官方客户端账号包 `@deepseek-ai/dsh-client-ui-settings-account` 已不在依赖里**（浏览器半边整条换成自研行）。
- **启动实测**：在预装好的桌面 profile（已含 0.1.7-rc.2 的三个官方账号包）里放入本包与本仓库的桌面补丁层后启动 Host，日志在 20 149 ms 报 `{"type":"ready","protocolVersion":3}`，插件树没有任何加载错误。
- **未演练的部分**：真实 DeepSeek 账号登录、真实赠金到账与确认都没有在本机演练过；Windows 载体上的界面观感需要人工确认。

## 已知限制

- **首次启动仍要扫码**：`backend ready` 之前仍会等 `dsh-wechat` 的微信扫码往返（约 9–16 秒，超时上限 5 分钟）。它是随包安装的第三方插件，本版没有改动它。
- **冷启动成本只是被提前，没有消失**：安装期预热让用户首次启动不再独付这笔钱，但 30 110 个散文件的按名开销仍在（对照 DSH NEXT 用单个 181 MB `app.asar` 启动同一引擎只要 4.96 秒）。把桌面运行时打包成单文件属于架构级改动，本版未做。
- **运行时被占用时的提示是英文**：`desktop project: the Harness-CN runtime at … is in use and could not be moved; …` 与其它 `desktop project:` 错误一样直接显示在失败对话框里，尚未本地化。
- **离线包仍不在安装包里**：安装程序不带 seed（Gitee 附件上限所限），安装期 `--prebuild` 会先下载约 100 MB 的离线包再重建；本版缩短的是重建，不是下载。
- **离线包只挂在 GitHub 上**：本版新内置的记忆插件让离线包涨到 122.2 MiB（rc.25 是 96.9 MiB），超过 Gitee 的 100 MiB 附件上限，所以本版的离线包只能从 GitHub 下载（Gitee 发布本身也仍缺 token）。构建时以 `HARNESS_CN_SEED_LIMIT_MB=0` 显式放开了 `prepare-shell` 的上限检查；该环境变量默认仍是 100，普通构建照旧会在超限时失败。要让 Gitee 重新托管离线包，需要缩小内置集或把离线包拆成两个归档。
- **没有 macOS / ARM64 发行版**；workflow 只构建 `win-x64`。
- 安装包仍然未签名，因此每次更新都要再走一遍 SmartScreen。
- registry 只在**安装插件**时使用；首启的依赖来自离线包内置的 pnpm store，不走网络。
