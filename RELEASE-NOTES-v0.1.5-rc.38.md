# Harness-CN v0.1.5-rc.38

本版修复「输入问题后不显示任何输出，直接报告已完成」的问题。

## 安装

- `Harness-CN_0.1.5-rc.38_x64-setup.exe`（NSIS，推荐）或 `…_x64_zh-CN.msi`
- 覆盖升级，无需先卸载

## 修复内容

### 被拦截的轮次不再静默完成

根因：内置的 `dsh-defend` 在 `agent/pre-step` 扫描用户消息。消息里含 critical 级密钥（例如 GitHub PAT `ghp_…`、Gitee 令牌）时，插件返回拒绝，循环以 `turn/end reason=blocked` 关闭本轮，**模型根本没有收到这条消息**。旧版 Chat 把 blocked 当作普通完成轮次渲染，没有任何说明，于是界面只剩「已完成，用时 1秒」或「已思考」。

现在的行为：

1. Chat 新增独立的 `turn-blocked` 节点，匹配 `turn/end` 的 `blocked` 原因；
2. 在轮末显示一条醒目的提示：「本轮输入被拦截」，并说明消息未到达模型、常见原因是消息中含密钥或访问令牌；
3. 该提示独立于过程折叠，Compact 模式下仍然可见；
4. 不新增 Session 事件，也不改 Session 格式；本次升级前记录的 blocked 轮次在回放时同样会显示提示。

如果确认要发送密钥类内容，请先移除密钥或改用环境变量，再重新发送。

## 校验

- `pnpm exec vitest run packages/client/ui-chat`：28 个测试文件、343 个用例通过
- `pnpm run typecheck` 通过

安装后「运行日志」应显示 `0.1.5-rc.38`。
