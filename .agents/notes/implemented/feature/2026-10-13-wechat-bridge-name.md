# Agent Note: the WeChat bridge answers to DSH-MoBot

Status: implemented

English | [中文](2026-10-13-wechat-bridge-name.zh.md)

## Problem

The WeChat bridge injects one prompt section (`dsh-wechat-surface`) for every WeChat-bound session,
and its built-in text — `DEFAULT_SURFACE_PROMPT` in `dsh-wechat/dist/config.js` — only says
`你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式…`. The assistant chatting
through the bridge therefore has no name to answer with, which the user reported as "在微信里显示的，
要起名叫 DSH-MoBot".

The name WeChat shows in the contact list is not the bridge's to set. Tencent's iLink platform assigns
it per `bot_type`, and the request that creates the bot carries that parameter alone
(`ilink/bot/get_bot_qrcode?bot_type=3`). That is true of `dsh-wechat` 0.10.0 and 0.11.0 and of
Tencent's own `@tencent-weixin/openclaw-weixin@1.0.2`, whose `login-qr.ts` builds the same single
parameter, so there is no field to send a product name in.

## Decision

The name this product controls is the one the bridge chats under. `apps/desktop/scripts/patch-wechat-identity.mjs`
appends one sentence to the installed built-in prompt:

```
你在微信里的名字是 DSH-MoBot；用户问起你是谁时，请用这个名字介绍自己。
```

The script is wired into `apps/desktop/scripts/prepare-seed.ts` beside the session patch: it runs on
the installed tree right after the production install and before `archiveLinkedProfile`, so the
archived store, the link manifest, and every profile later materialized from this seed carry the
sentence. The same run reads the name back out of the materialized tree and fails the build when the
built-in prompt does not carry it.

The corrected bytes are written to a temporary file, imported to prove the module still loads and
exports a prompt naming the bridge, and only then renamed over the module. The temporary name ends in
`.mjs` because the loader refuses to parse a file whose extension it does not know — without it the
proof step would fail before it could check anything. The rename is also what keeps pnpm's hardlink
into the store honest, exactly as in the session patch.

This is the built-in default only. `~/.dsh-wechat/config.json` may carry a `surfacePrompt` the user
edited, the plugin persists that value verbatim, and only a stored value equal to a superseded
built-in is dropped — so an edited prompt keeps applying and this patch never overrides it.

## Alternatives considered

**Rename the bot on the platform side.** The platform's own SDK takes no name parameter, so there is
nothing to send.

**Ship a default `~/.dsh-wechat/config.json` in the seed.** That file lives in the harness home, not in
the profile the seed materializes, so the seed has no place to put it.

**Fork the plugin package.** The gap is one prompt string; a fork would have to track every upstream
release to keep a one-line difference.

**Have the shell write the config at startup.** Every launch would rewrite user state from outside the
artifact the release verifies, and a stored prompt the user edited would be the thing it overwrote.

## Consequences

Every profile materialized from this seed chats through a bridge that introduces itself as DSH-MoBot,
and a user who edited the prompt keeps their own text. The WeChat contact list still shows the
platform's name for the bot; the release notes state that and point at WeChat's own rename.

The patch is anchored on one export and fails the build when it cannot find it, so a future release of
the plugin that renames or restructures `DEFAULT_SURFACE_PROMPT` stops the release run instead of
shipping an unnamed bridge silently.

`apps/desktop/tests/patch-wechat-identity.spec.ts` covers the rewrite, the idempotent second run, the
refusal on a module it cannot anchor on, the command line against an installed profile, the
verification of both tree forms, and a tree with no `dsh-wechat` at all.
