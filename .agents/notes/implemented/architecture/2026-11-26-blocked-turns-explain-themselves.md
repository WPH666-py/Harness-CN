# Agent Note: Blocked turns explain themselves in Chat

Status: implemented

English | [中文](2026-11-26-blocked-turns-explain-themselves.zh.md)

## Problem

A `agent/pre-step` listener can reject a claimed batch. The loop then closes the turn as blocked without opening a step, so the Session log holds one balanced `turn/start` → `turn/end { reason: { kind: 'blocked' } }` pair and no model request ([pre-step lifecycle](2026-07-31-claimed-pre-step-inbox-lifecycle.md)). Bracketed as `dsh-defend`, this is exactly what a message containing a critical secret produces: the plugin classifies the message, returns `{ kind: 'reject' }`, and the user's question never reaches the model.

Chat rendered that turn as an ordinary completed turn. In the 0.2.1 line the process row read `已完成，用时 1秒`; on this line it was a bare `已思考`. With no Assistant message there was nothing else to show, so a blocked question looked like an accepted question that silently produced no answer. Users had no way to learn that the message never left the host, let alone why.

## Cause

The blocked outcome already crosses the durable boundary: `turn/end` carries `reason.kind: 'blocked'`. Chat simply had no renderer for it. `turn-error` and `turn-max-tokens` each own a distinct turn-end notice, but blocked turns fell through to the process control, whose label describes work rather than refusal.

`PreStepDecision` carries no rejection reason, so the client cannot name the listener that rejected the batch. Naming the generic cause in the notice and leaving listener-specific detail to plugin logs keeps the loop contract unchanged.

## Evidence

- The installed Session `session-fa35c331-7265-4868-abcd-32cbf09af3f9` on this machine holds six turns, each `turn/start` → `turn/end blocked` within milliseconds and no `request/header`.
- Running `dsh-defend@0.3.21`'s own scanner over the submitted text reports `ghp-token` with `severity: critical`; its default `secretBlockCritical: true` turns that match into a rejection.
- Chat's view composition independent list held `turn-error` and `turn-max-tokens` but no blocked kind, and `TurnProcessNodeView` mapped every non-error closure to the working label.

## Decision

Chat contributes `turn-blocked`, a View-only Conversation Node analogous to `turn-max-tokens`. It matches `turn/end` with `reason.kind: 'blocked'`, anchors just before the turn-tail (`seq - 0.05`), and renders a persistent `role="status"` row: `本轮输入被拦截` plus guidance that the message never reached the model and may contain a secret. The kind is independent of Turn-process disclosure, so Compact mode keeps it visible and the process control stays outside the notice. The renderer reads no plugin metadata; every blocked turn gets the same explanation.

No Session event, Session format version, pre-step payload, or model-visible input changes. The notice is derived entirely from the existing durable turn/end.

## Alternatives considered

**Add a rejection reason to `PreStepDecision` and log it.** This would name the rejecting plugin in the notice, but it changes a pre-stable waterfall contract consumed by every interception plugin and still leaves third-party rejections without a reason unless each one adopts the field. The generic notice answers the user's question (`why is there no answer?`) without that migration.

**Let `dsh-defend` return an approval request instead of a reject.** The bundled profile runs approval policy `never`, so an ask resolves as a denial and the turn still closes blocked; the user only sees a different silent path. Changing the security default is a separate product decision.

**Fix the process control's label only.** A label of `已拦截` on the fold control still disappears in Compact mode when the turn has no process rows to fold, which is precisely the all-reject case.

## Consequences

Every blocked turn now states that its input was refused before the model and points at the likely cause, at the cost of one extra row per blocked turn. The notice cannot distinguish a secret rejection from a hook or preset rejection; that detail stays in plugin diagnostics. Sessions recorded before this change gain the notice on replay because the durable `turn/end` reason is unchanged.
