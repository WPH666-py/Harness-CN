# Harness-CN 0.1.5-rc.31

这一版只有一处修复：设置 → 局域网访问 在桌面版里每一项请求都失败，面板显示「请求失败：SyntaxError: Unexpected token 'o', "not found" is not valid JSON」，局域网和远程两个页签都一样。修好之后，面板能读到网卡清单，局域网连接可以正常配置。没有其他行为改动。

## 修复

### 1. 桌面版里 `/api/...` 下的插件路由全部不可达

现象：设置 → 局域网访问，局域网与远程两页都停在「请求失败：SyntaxError: Unexpected token 'o', "not found" is not valid JSON」；「生成并复制密钥」「启用远程访问」等按钮全部无效，诊断页同样读不到数据。

原因：桌面窗口里的每个 `/api/...` 请求都被载体整段接管，交给 Connection 的共享处理器；处理器只认自己精确注册过的路由，未命中就直接回 `404`，正文是 `not found`（`text/plain`），不会回落到 composed webserver。而 `dsh-mobile` 的管理接口（`/api/mobile-access/lan/control`、`/diagnostics`、`/lan/setup`、`/remote/control` 等）注册在 `ctx.webServer` 上，于是永远到不了；同一时刻用宿主自己的监听端口访问这些路径是 200。

改法：`createSharedFetchHandler(channel, fallback?)` 增加一个可选的兜底，只在没有精确路由认领时调用；桌面宿主把自己的插件路由分发器（`pluginRoutes`）传进去，未命中的 `/api/...` 回到 webserver，由 webserver 的「最长前缀胜出」规则把请求交给插件更长的前缀。没有传入 fallback 的载体（浏览器里的 dsh web、CLI）保持原来的 404，精确路由仍然优先，浏览器信任不会旁落到插件。用例钉住了两件事：未命中时把请求原样交给 fallback；没有 fallback 时仍然是 404。

### 2. 沿用 rc.30 / rc.29 的修复

- 登录等待态不再同时显示「登录」与「取消」，只有「取消」和授权链接（rc.30）；
- 运行日志窗口先读快照再挂实时流，不再开成空白（rc.30）；
- 账号面板从注册表读取 `remote.account` 命名空间、`AuthorizationSession.commit` 前向移植、vision 工具默认不激活等 rc.29 的修复。

## 验证

- 在已安装的 0.1.5-rc.30 应用上注入 rc.31 的构建产物复验：窗口 origin 下 `GET /api/mobile-access/lan/control` → `200` `application/json`；设置 → 局域网访问 面板正常渲染，出现「电脑当前网络」的以太网 · 192.168.56.1 与 WLAN · 192.168.1.16（推荐）两条，按钮就位，`hasRequestFailed = false`。修复前同一页面是 404 正文 `not found`，正是用户截图里的报错原文。
- `pnpm exec vitest run packages/client/connection` → 14 个文件 / 163 个用例通过（含新增「未认领的请求交给载体兜底」）。
- 门禁：Agent Note 格式 345 篇、分类 345 篇、双语配对 811 对，全过；改动文件 `oxlint` 0 warnings / 0 errors。
- **rc.31 产物原样验证**：从 `Harness-CN-seed-0.1.5-rc.31.tar.zst` 里解出两份关键包并与本地构建产物逐字节比对：
  - `desktop-packages/deepseek-ai-dsh-client-connection-0.1.5-rc.31.tgz` 的 `package/lib/index.js` — 33 044 字节，sha256 `FCF93FF3472368B8DC1DAD90E9B9A345F7AB216635B11153C66E9A1BA70B111E`，`createSharedFetchHandler(channel, fallback)` 与回落分支都在；
  - `desktop-packages/deepseek-ai-dsh-desktop-host-0.1.5-rc.31.tgz` 的 `package/lib/index.js` — 28 807 字节，sha256 `4F44972D4697694548D823E170C91825116B1829BAFE1FF3611382F3E6A056AA`，分发处已是 `connection.createSharedFetchHandler("/api", pluginRoutes)`。

## 安装包校验和

GitHub 发布页（安装包 + 完整离线包）：

- `Harness-CN_0.1.5-rc.31_x64-setup.exe` — 28 930 952 字节，sha256 `4C63B7E37D2BD9C3D27B3247781D2D50A4728BE0CBDD333B3E409B81E0831FFC`
- `Harness-CN-seed-0.1.5-rc.31.tar.zst` — 127 980 649 字节，sha256 `AAE7EF9DA5A77C2CB954BCE9102F96978A992E08DBB3E215A7DAF9D3A6F6303D`

Gitee 附件（安装包 + 离线包两卷，单附件上限 100 MB）：

- `Harness-CN-seed-0.1.5-rc.31.tar.zst.part1of2` — 67 108 864 字节，sha256 `4702AA71693AA018FDCF1789B07DE6E23C271F2867120E64E46F544636A5FA08`
- `Harness-CN-seed-0.1.5-rc.31.tar.zst.part2of2` — 60 871 785 字节，sha256 `DE7E49429547DC2075FF135098C77A8C21876AF930F2AEB144DA071F84DCD9E1`
- `Harness-CN-seed-0.1.5-rc.31.tar.zst.parts.txt` — 分卷清单；两卷按序拼接后应得到上面的完整 sha256
