# Harness-CN 0.1.5-rc.33

这一版把手机访问从插件搬进了外壳进程：删掉 `dsh-mobile` 和它的三个打包期补丁，改由窗口「移动访问」提供 —— 同一台机器、同一个 origin、明文 HTTP、一条配对链接换一年有效的 cookie，二维码就画在窗口里。`dsh-web-mobile` 保持 3.0.6 不变，继续负责手机上的排版。

`dsh-web`（`@linxin666/dsh-web-*@0.4.7`）**没有**随包发货：它是按 0.1.7/0.2 线的客户端接口构建的，在本线上不是「少几个面板」，而是会让整个 Web 界面停摆（证据见第 3 节）。本版用壳层自己发的那道门替代了它要提供的功能。

## 变更

### 1. 手机访问由壳层自己发

现象（rc.32 及更早）：手机能不能连上，取决于 `dsh-mobile` 起的那个 HTTPS 网关 —— 它要自己生成 CA、给网卡签叶子证书、把页面的启动脚本改写一遍、再拿一个上游 cookie 去换会话。每一环都能单独把连接弄死。

改法：壳层的 `ShellServer` 直接监听 `0.0.0.0`，页面从同一个 origin 发给手机，前面只有一道门：

- 门没开时，局域网访问者看到一张「移动访问未开启」的页面（`<meta name="dsh-lan-door" content="off">`），不带任何应用数据；
- 在桌面端的「移动访问」窗口点「开启」，壳层生成 32 字节密钥，显示成二维码和一条 `http://<局域网地址>:<端口>/__lan?key=<密钥>` 链接；
- 手机打开链接，壳层校验密钥后 `302` 到 `/` 并下发 `hcn_lan` cookie（一年有效、`HttpOnly`、`SameSite=Lax`），之后手机上的每个请求都靠这个 cookie 通过；
- 点「重新生成链接」立刻作废旧 cookie，旧链接再打开只会看到「链接已失效」；
- `dsh web` 的 token cookie 仍然只发给本机回环地址；控制面 `/shell-api/*` 对局域网来源一律 403。

没有 TLS，也没有第二条监听端口 —— 和 Claudecode-CN 的做法一致：手机不会为了一张自签证书去装信任链，那就不要在链路上放证书。

### 2. 删掉 dsh-mobile 与三个补丁

- `apps/desktop/src/bundled-plugins.ts` 去掉 `dsh-mobile@0.6.4`；
- 删除 `apps/desktop/scripts/patch-mobile-listen.mjs`、`patch-mobile-session.mjs`、`patch-mobile-panel.mjs`，以及 `prepare-seed.ts` 里对应的六个 `patchInstalledMobile*` / `verifyMobile*Patch` 函数和调用点；
- `apps/desktop-shell/src/shell-main.ts` 不再设置 `DSH_SHELL_ORIGIN`（只有那个网关需要它）。

随之消失的还有它们修过的问题：端口回退、会话 TTL 溢出、面板二维码、扫码后填设备名、上游 cookie 交换、每次启动重签证书。

### 3. 为什么不是 dsh-web

`@linxin666/dsh-remote-web-ui@0.4.7` 在 0.1.5 线上**装了就白屏**。实测：`pnpm install` 成功、宿主启动成功、`GET /?token=…` 返回 200，但首页在浏览器里停在 boot 审计上——

- 它的客户端 `apply` 在运行时 `inject` 了 `configForms` 服务，那是 0.1.7 线才有的插件配置表单服务，本线没有任何提供者；
- 该 row 因此永久 `pending`，boot 判 `1 entry did not activate`，整个 Web 界面中止渲染（截图与 `__DSH_BOOT__` 快照留在 `_work/rwu-probe/`）。

它的聚合包 `@linxin666/dsh-web-all@0.4.7` 看起来「没事」，只是因为 14 个面板用 `name: '@linxin666/dsh-web-all/<子路径>'` 这种 0.2 线的 `plugin:` 约定挂载，而本线的客户端扫描只认能解析到包根的 specifier（`packages/client/modules/src/index.ts` 的 `locatePkgJson`），子路径一律被判定「不是客户端 row」—— 也就是说它既不能提供远程访问，也不会报错，属于静默失效。

两条路都不适合发货，所以本版不带它；移动访问用壳层实现（第 1 节）。

### 4. 安装与首次启动的三个修复

这一版还修掉了三处会让安装看起来失败的地方：

- **安装器不再预构建运行时**。`hooks.nsh` 的 POSTINSTALL 原本跑 `shell.mjs --prebuild`，超时上限二十分钟；没有网络时它就在安装器里等下载，用户看到的是「装完没反应」。现在安装只铺文件，构建放到首次启动的进度窗口里。
- **构建产物不再携带上一版的离线包**。`tauri build` 只刷新 `resources` 里清单列出的项，不删旧文件，于是 rc.4 的 `seed` 一路留进便携版目录，启动时版本比对失败（`seed 0.1.5-rc.4 does not match Electron 0.1.5-rc.33`）。现在打包前先清空 `target/release/resources`。
- **插件恢复默认走国内镜像**。恢复一个普通插件时，经代理访问 `registry.npmjs.org` 的元数据大量超时，界面停在「正在启动」半小时以上；换 `registry.npmmirror.com` 后同样的恢复一分钟内完成。机器自己声明的 registry 仍然优先。

### 5. 与 rc.32 的关系

rc.32 的端口回退、一年期会话、二维码面板、扫码免填设备名，都是补在 `dsh-mobile` 内部的；插件删除后这些能力由第 1 节的壳层逻辑承担，行为对用户等价：打开窗口、看到二维码、扫码、进应用。

### 6. 新增 MSI 安装包（长路径安全）

现象：NSIS 安装包在部分机器上双击即中止（`exit 2`、0.2 秒、磁盘上什么都没写），或者弹出 `Error writing temporary file`。两者都发生在装文件之前：NSIS 把自己的插件解到 `%TEMP%\nsx????.tmp`，这一步失败就不进入安装段，而它的错误提示只有那一句笼统的话。

改法：在原有 NSIS 之外再产出一个 Windows Installer 包（WiX）：

- `Harness-CN_0.1.5-rc.33_x64_zh-CN.msi`（42 110 976 字节）—— MSI 的文件表按安装路径寻址，不受 NSIS 自解压那一层限制；解包由 Windows Installer 服务完成，不依赖当前用户的 `%TEMP%` 可写；
- `install-per-user.cmd` —— MSI 默认是「本机安装」，需要管理员提示；这个脚本用 `ALLUSERS=2 MSIINSTALLPERUSER=1` 把它装到当前用户目录，不需要提权。等价的手工命令写在脚本注释里；
- NSIS 包继续保留并上传，两条路都可用。

注意：这台构建机上 WiX 的 ICE 校验连不上本机 Windows Installer 服务（`LGHT0216 0x643`），因此本地用 `light.exe -sval` 跳过校验产出 MSI；普通开发机构建不需要这个绕行，`tauri build` 直接出包。

### 7. 手机端右上角菜单

现象：手机上打开的是网页版界面，窗口菜单里的「重启 / 运行日志 / 插件管理 / 作者信息 / 休闲食品商城 / 评价与反馈」在手机上没有任何入口 —— 那些入口长在 Tauri 的窗口菜单上，网页看不到。

改法：壳层的 HTTP 监听在把 Host 的页面转发给**配对过的手机**时，在 `</head>` 前注入一张样式和一段脚本（`rsc/mobile-menu.css`、`rsc/mobile-menu.js`，随安装包发布为 `/shell/mobile-menu.*`）：

- 右上角一个半透明圆钮，点开是右侧抽屉，六项按窗口菜单的名字排列；
- 「重启」走 `POST /shell-api/restart`，壳层把请求交回 Rust 主进程 —— 单实例锁和要被替换的可执行文件都在那边，sidecar 自己重启不了自己；主进程释放锁、启动新进程、退出（与窗口菜单的「重启」同一段逻辑）；
- 其余五项直接打开壳层自己的页面（`/shell/log-viewer.html` 等），这些页面本来就能在手机浏览器里用；
- 注入只发生在远端请求上：本机窗口看到的是 Host 原样的页面，没有多出任何东西。

配套的权限收口：控制面 `/shell-api/*` 对局域网**不是整体开放**，而是按白名单放行 `status`、`locale`、`logs`、`logs/clear`、`plugins`、`plugins/*`、`feedback`、`restart`。检查更新、安装更新、API 密钥、查看日志目录、退出这些仍然只回答本机 —— 手机侧的实测是 `updates` / `api-key` / `logs/reveal` 全部 403。

### 8. 悬浮球菜单、设置页关闭按钮、插件路由修复

手机菜单第一版钉在右上角，跟界面自己的顶栏按钮叠在一起；这次改成可拖动的悬浮球（记住位置、随屏幕尺寸收缩、避开安全区），并给 Host 的全屏设置对话框补了一个「关闭」按钮 —— 这个按钮只在存在 `role="dialog"` 的模态框时出现，点它等于按 Esc，对话框本来就监听这个键。

插件面板里的「请求失败 HTTP 404」不是网络问题，是桌面承载层吃掉了整个 `/plugins` 前缀：它把该前缀下的每个请求都当成客户端 bundle 去查，而插件宿主半身注册的 `/plugins/<包名>/status` 这类路由同样落在这个前缀里，于是被 bundle 表的 404 顶掉。改成先交给宿主自己的路由表、404 再回落到 bundle 表之后，WorkBuddy 账号面板直接返回 `{"status":"signed-in",…}`，桌面端和手机端同时恢复。

### 9. WorkBuddy 海外版卡片自动发现本机应用

现象：WorkBuddy 的两张卡片都停在「正在读取账号…」，随后都变成「请求失败 HTTP 404」；海外版即使订阅了 Pro，卡片也显示未登录，模型列表里选不到它自己的模型。

原因有两处，第一处是壳层的：

1. `/plugins/` 前缀被整个当成前端资源包处理（见第 8 节），插件自己注册的 `/plugins/<包名>/status` 因此 404；
2. 海外卡的账号文件其实就在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info`，但插件要先知道「WorkBuddy AI 装在哪」才肯读它。它查注册表卸载项的 `InstallLocation`，而这台机器的两个 WorkBuddy 卸载项都没有这个值（只有 `DisplayIcon`），于是判定 `electron-binary-not-found`，卡片退化成未登录。

改法：启动 Host 子进程时替它解析好应用路径，写进插件约定的 `WORKBUDDY_AI_ELECTRON_BIN`（`apps/desktop/src/workbuddy-ai.ts` + `host-process.ts`）：

- 优先用用户自己设置的环境变量；
- 其次找默认的按用户安装位置 `%LOCALAPPDATA%\Programs\WorkBuddy AI\WorkBuddyAI.exe`；
- 最后读卸载项的 `DisplayIcon`（值形如 `"D:\...\WorkBuddyAI.exe,0"`，去掉引号和图标序号）。`reg.exe` 按系统 ANSI 代码页输出，中文安装目录必须按 GBK 解码，否则路径会变成乱码而查不到文件。

结果：两张卡同时可用 —— 国内卡 18 个模型（www.workbuddy.cn），海外卡 27 个模型（www.workbuddy.ai，含 gpt-6-astra、deepseek-v4.1-flash 等）。用户不需要设置任何环境变量。

### 10. 手机端去掉插件的「发现新版本」卡片，重启改成就地重启

**更新卡片**：WorkBuddy 插件会在设置页里插一张「发现新版本 0.7.8」的卡片，把十一个版本的更新说明一次性铺满屏幕。手机上没有办法装插件更新，这张卡片只是占位。注入的脚本现在按它自己的文案定位（同时含「发现新版本」和「不再提醒」的最小元素），在窄屏上直接隐藏；插件改版换了别的措辞时，规则失效也只会让卡片重新出现，不会误伤别的界面。

**重启**：菜单里的「重启」原来是把整个进程重来一遍 —— 关掉 Host、退出、再启动一个新的可执行文件、重新创建 WebView2 窗口（这台机器实测建窗要 10 秒，期间用户会看到第二个「正在启动」的窗口）。现在改成**就地重启**：只替换窗口背后的 Host，监听端口、LAN 配对 cookie、窗口本身都留着；页面重新请求时自然连到新的 Host。只有就地重启失败时才退回整进程重启。

### 11. 内置十个社区插件；生成中/生成后可以换模型与强度

内置（`apps/desktop/src/bundled-plugins.ts`，装进种子、新配置默认挂载）：

| 插件 | 版本 | 说明 |
|---|---|---|
| `dsh-mermaid-smooth` | 0.2.1 | Mermaid 平滑渲染 |
| `dsh-connect-trae` | 4.0.1 | 连接 Trae |
| `dsh-remote-ssh-ops` | GitHub `main` | 未发布到 npm，按仓库安装 |
| `@dmh2002/dsh-connect-qoder` | 1.5.2 | 连接 Qoder |
| `@copylee/dsh-office` | 1.1.3 | Office 文档 |
| `@zaofan/dsh-qqbot` | 1.10.10 | QQ 机器人 |
| `@yunmiao/studymate` | 2.0.2 | Study-Mate |
| `@xmanrui/dsh-im` | 5.1.0 | IM 集成 |
| `dsh-email` | 0.17.2 | 邮件 |
| `dsh-claude-move` | 0.4.18 | 装但**不激活**：其 `engines.dsh` 声明 `>=0.1.6-0 <0.2.0`，本线是 0.1.5-rc.33 |

换模型的 bug：`selectModel` 原本排在 `agents.serializeImageAdmission` 后面，而那是 agent 的「当前调用」闸门 —— 生成中调用于是整轮排队（看上去点了没反应），而一轮结束时闸门若没释放，之后就再也换不了。选择只影响**下一次**请求，不需要图像准入，现已改成直接写 `selectForNextRequest` 并保存默认值。

## 验证
- 门逻辑用独立 harness（`_work/lan-door-test.mts`，起真实 `startShellServer` + stub API）跑通两条路径：
  - 回环：`GET /` 200 且自动带 `hcn` cookie；`GET /shell-api/lan` 200 返回 `{"enabled":false,"address":"192.168.1.16",...}`；
  - 局域网（连自己的网卡地址）：门没开时 `/` 返回 200 + `dsh-lan-door=off`；`POST /shell-api/lan/enable` 200 并给出 `http://192.168.1.16:<port>/__lan?key=…`；开门后无 cookie 的 `/` 是 `dsh-lan-door=locked`；带 key 的 `/__lan` 返回 `302` + `Set-Cookie: hcn_lan=…`；带 cookie 的 `/` 200；局域网来源访问 `/shell-api/lan` 403；`/shell-api/lan/qr` 返回 `<svg`；`rotate` 后旧 cookie 立即变成 `locked`；`disable` 后回到 `off`。
- `tsc -p apps/desktop-shell/tsconfig.check.json` 通过；`node apps/desktop-shell/scripts/build-sidecar.mjs` 产出 `src-tauri/resources/sidecar/shell.mjs`。
- 单元测试：`apps/desktop/tests/bundled-plugins.spec.ts`、`apps/desktop/tests/project-manager.spec.ts` 共 25 例通过。
- 文档门禁：`verify-agent-note-format` 350 篇全过、`verify-agent-note-classification` 全过；新笔记 `2026-10-17-lan-door-serves-the-gui-itself.md/.zh.md` 已成对。
- rc.33 产物：安装包 `Harness-CN_0.1.5-rc.33_x64-setup.exe` 27.61 MB（28 957 824 字节），sha256 `9224f1d49b7b0b330c1a1baedbf391467415eb4c0353b14815907f7bd5cb2e8e`，签名 `Valid`（CN=水哥）；`Harness-CN_0.1.5-rc.33_x64_zh-CN.msi` 40.17 MB（42 119 168 字节），sha256 `539c1a10c677fca9a31da073c519414072f80aef691b7a3cb561b755a14af12c`，签名 `Valid`（CN=水哥）；离线包 `Harness-CN-seed-0.1.5-rc.33.tar.zst` 222.3 MB（233 115 610 字节），sha256 `1d09bbbf2bd49f8b8f7e312543eacb5c1332265c369ebaccdc5ff32e483fb767`。
- 这一版的离线包带上十个插件后是 222.3 MB，超过 Gitee 单附件 100 MB 的上限，因此按既有发布流程切成 4 个 64 MiB 分片发到 Gitee（`…part1of4` 到 `…part4of4` 加 `…parts.txt` 清单），GitHub 上仍放整包。首次启动按整包名查找离线包，两个宿主都能用：Gitee 找不到整包时自动回落到 GitHub。
- 顺带清掉一个会让首启装到旧运行时的隐患：Gitee 上还挂着上一轮发布的整包（`Harness-CN-seed-0.1.5-rc.33.tar.zst`，95 811 678 字节），而查找离线包是「新发布优先、跨两个宿主」。同名旧包留在 Gitee，首启就可能从 Gitee 拿到旧种子。该附件已删除（id 3421974）；现在整包只在 GitHub，Gitee 只放四个分片和清单。
- 只有装完第一次启动才会暴露的第二个问题：`dsh-remote-ssh-ops` 没有发布到 npm，按 `github:weisiren000/dsh-remote-ssh-ops#main` 安装，pnpm 会把这类依赖先展开到 `<store>/v11/tmp/_tmp_<pid>_<hash>/` 下，并和 store 的内容互为硬链接。`prepare-seed` 把整个 store 打成分片时，tar 遇到硬链接就记成 `Link` 条目，而首次启动解包 store 只接受普通文件，于是失败在 `desktop seed: unsupported pnpm store archive entry type Link`，应用停在启动页。修法：归档前删掉 pnpm 的临时暂存目录（`apps/desktop/src/seed-store.ts` 新增 `removePnpmStagingDirectories`，`prepare-seed.ts` 紧接 `removePnpmProjectRegistrations` 调用）——种子的 37 470 条 profile 链接全部指向 `v11/files/**`，没有一条指向 `tmp`，删掉不损失内容。16 个 store 分片重新扫描后全部只剩普通文件。
- 装完实测：`resources/seed` 换成新种子的当天，日志依次是「bundled seed verified」→「package store ready; rebuilding the desktop runtime」→「staged runtime verified: 37785 files, native modules [node-pty, koffi, sharp]」→「desktop runtime installed from the bundled seed」→「backend ready」，不再停在启动页；`/shell-api/plugins` 返回的清单里十个插件都在（`dsh-claude-move` 按设计不激活）。
- 这一版补齐了两处只改源码不会进产物的缺口：`selectModel` 的修复在 `packages/api/session-controller/src/commands.ts`，而种子里发的是 `desktop-packages/*.tgz`；十个插件写在 `bundled-plugins.ts`，而种子的 `package.json` 由 `prepare:seed` 生成。只跑 `prepare:seed` 会沿用上一轮的打包产物，因此按 `prepare:package`（`build:official` → `release:pack` → `prepare:packages` → `prepare:seed`）整链重跑，再检查种子内 `deepseek-ai-dsh-api-session-controller-0.1.5-rc.33.tgz` 的 `selectModel` 已不再被 `serializeImageAdmission` 包住、种子依赖表 275 项含十个插件。
- 打包期修掉一个只有装完才会暴露的问题：`qrcode` 的 Node 入口用动态 `require('fs')`，esbuild 打成单文件 ESM 后变成运行时 `Dynamic require of "fs" is not supported`，壳层直接起不来（安装后弹「内置运行时未能启动」）。`build-sidecar.mjs` 现在把 `qrcode` 别名到它的 browser 入口（同一套编码核心、不碰内置模块），sidecar 由 540 478 字节降到 457 112 字节，产物里不再有该 shim。

## 安装包校验和

- `Harness-CN_0.1.5-rc.33_x64-setup.exe`：`9224f1d49b7b0b330c1a1baedbf391467415eb4c0353b14815907f7bd5cb2e8e`
- `Harness-CN_0.1.5-rc.33_x64_zh-CN.msi`：`539c1a10c677fca9a31da073c519414072f80aef691b7a3cb561b755a14af12c`
- `Harness-CN-seed-0.1.5-rc.33.tar.zst`：`1d09bbbf2bd49f8b8f7e312543eacb5c1332265c369ebaccdc5ff32e483fb767`

离线包整包 233 115 610 字节；下面的分片按序号拼接可逐字节还原它（清单 `Harness-CN-seed-0.1.5-rc.33.tar.zst.parts.txt`）：

- `Harness-CN-seed-0.1.5-rc.33.tar.zst.part1of4`：67 108 864 字节，sha256 `d458bf09e1007b73fd391d3d7414ffe195bf46098a2131f50bb0db478c6232d9`
- `Harness-CN-seed-0.1.5-rc.33.tar.zst.part2of4`：67 108 864 字节，sha256 `654e01645e61e8f3f5e6492eef7e9a995dad367e928389e1f0c725423ac11b7b`
- `Harness-CN-seed-0.1.5-rc.33.tar.zst.part3of4`：67 108 864 字节，sha256 `8f2ecf64c36dd0ccfe983d6048af6a773fa332f805d1433678b80e7a467b639c`
- `Harness-CN-seed-0.1.5-rc.33.tar.zst.part4of4`：31 789 018 字节，sha256 `62427d63e574245a4d848583624cd1656762f2359abcf5b9b92c12bea50061d4`