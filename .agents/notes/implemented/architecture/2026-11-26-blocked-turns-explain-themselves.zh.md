# Agent Note: Blocked turns explain themselves in Chat

Status: implemented

[English](2026-11-26-blocked-turns-explain-themselves.md) | 中文

## Problem

`agent/pre-step` 监听器可以拒绝已认领的批次。循环随后以 blocked 关闭本轮，不开启任何步骤，于是 Session 日志里只有一对配平的 `turn/start` → `turn/end { reason: { kind: 'blocked' } }`，没有任何模型请求（[pre-step 生命周期](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)）。以内置的 `dsh-defend` 为例，消息里含 critical 级密钥时正是如此：插件判定后返回 `{ kind: 'reject' }`，用户的问题从未到达模型。

Chat 把这一轮当作普通的已完成轮次渲染。0.2.1 线上过程行显示 `已完成，用时 1秒`；本线只显示一句 `已思考`。由于没有 Assistant 消息，也没有别的内容可显示，被拦截的问题看起来就像「已接受、但没有回答」。用户无法知道消息根本没离开本机，更不知道原因。

## Cause

blocked 结果本来就已经跨过持久化边界：`turn/end` 携带 `reason.kind: 'blocked'`。缺的是 Chat 的渲染。`turn-error` 与 `turn-max-tokens` 各自拥有独立的轮末提示，而 blocked 落到了过程控件上，控件文案描述的是工作内容而不是拒绝。

`PreStepDecision` 不携带拒绝原因，所以客户端无法指出是哪个监听器拒绝的。提示只说明通用原因，把监听器细节留给插件日志，从而不改动循环契约。

## Evidence

- 本机安装的 Session `session-fa35c331-7265-4868-abcd-32cbf09af3f9` 有六轮，每轮都是 `turn/start` → `turn/end blocked`，间隔毫秒级，且没有 `request/header`。
- 用 `dsh-defend@0.3.21` 自带的 scanner 扫描用户原文，命中 `ghp-token`、`severity: critical`；其默认 `secretBlockCritical: true` 会把该命中变成拒绝。
- Chat 的过程独立列表只包含 `turn-error` 与 `turn-max-tokens`，没有 blocked 类型；`TurnProcessNodeView` 把所有非 error 的结束都映射成工作文案。

## Decision

Chat 新增 `turn-blocked`，一个仅用于视图、与 `turn-max-tokens` 同构的 Conversation Node。它匹配 `reason.kind: 'blocked'` 的 `turn/end`，锚定在 turn-tail 之前（`seq - 0.05`），渲染一条持久的 `role="status"` 提示：`本轮输入被拦截`，并说明消息未到达模型、可能含有密钥。该类型独立于过程折叠，Compact 模式下仍然可见，过程控件位于提示之外。渲染器不读取插件元数据；每个 blocked 轮次得到同样的解释。

不新增 Session 事件、不改 Session 格式版本、不改 pre-step 载荷、不改变模型可见输入。提示完全由既有的持久 `turn/end` 推导。

## Alternatives considered

**给 `PreStepDecision` 增加拒绝原因并记录。** 这样能在提示里指出拒绝的插件，但要改所有拦截插件都消费的 pre-stable waterfall 契约，而且第三方拒绝仍不会带原因，除非各自采纳该字段。通用提示已经回答了用户的问题（「为什么没有回答」），无需这次迁移。

**让 `dsh-defend` 返回审批请求而不是拒绝。** 内置 profile 的审批策略是 `never`，ask 会解析为拒绝，本轮仍然 blocked，只是换了一条静默路径。改安全默认值是另一个产品决策。

**只改过程控件的文案。** Compact 模式下没有过程行可折叠时控件本身就不显示，而这恰好是全拒绝的场景。

## Consequences

每个 blocked 轮次现在都会说明输入在模型之前被拒绝，并指出可能原因，代价是每个 blocked 轮次多一行。提示无法区分密钥拒绝与 hook 或 preset 拒绝；这些细节仍留在插件诊断里。本次改动之前记录的 Session 在回放时也会出现提示，因为持久 `turn/end` 的 reason 没有变化。
