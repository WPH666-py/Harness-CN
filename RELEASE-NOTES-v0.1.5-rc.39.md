# Harness-CN v0.1.5-rc.39

本版把「移动访问」窗口改成微信连接入口：打开后直接落在设置里的「微信连接」页。

## 安装

- `Harness-CN_0.1.5-rc.39_x64-setup.exe`（NSIS，推荐）或 `…_x64_zh-CN.msi`
- 覆盖升级，无需先卸载

## 更新内容

### 「移动访问」默认展示微信连接

菜单栏的「移动访问」不再打开原来的局域网开关、二维码和配对链接页面，而是在工作区里打开 `/?settings=wechat`，窗口尺寸放大到 1120×820，设置面板直接停在「WeChat」分区。登录状态、Bot、`cwd`、`cardTimeoutMs`、跨会话推送与提醒、静默、渠道提示词、保存配置、重新扫码、退出登录以及已知限制都在这一页。

设置外壳（`packages/client/ui-settings-general`）在挂载时读取一次 `?settings=<分区 id>`：参数存在且非空时以该分区打开对话框，缺失或为空时保持原来的关闭状态。微信插件注册的分区 id 是 `wechat`；若该插件尚未注册，面板先显示第一个分区，等账本条目到达后自动切换。

关闭对话框后，该窗口停留在工作区页面上；窗口标题仍是「移动访问」。

局域网门本身没有改动：`lan-access.ts` 仍会持久化开关与密钥，`/shell-api/lan*` 仍提供链接和二维码，但新窗口不再展示它们，手机访问状态沿用已持久化的值。

## 校验

- `pnpm exec vitest run packages/client/ui-settings-general`：6 个测试文件、50 个用例通过（含新增的地址深链用例）
- `pnpm exec tsc -b packages/client/ui-settings-general/tsconfig.json` 通过
- `pnpm run release:verify --family dsh`：267 个成员版本一致

安装后「运行日志」应显示 `0.1.5-rc.39`。
