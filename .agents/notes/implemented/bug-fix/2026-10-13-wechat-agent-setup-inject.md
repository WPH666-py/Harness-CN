# Agent Note: dsh-wechat sessions read the agent through the setup context

Status: implemented

English | [中文](2026-10-13-wechat-agent-setup-inject.zh.md)

## Problem

`dsh-wechat@0.8.0`, the version the desktop profile shipped up to 0.1.5-rc.21, creates every
WeChat-bound session with a `setup` callback that reads the agent as a property of the setup context:

```js
async function agentSetup(agentCtx) {
    const ctx = agentCtx;
    const presets = ctx.get?.("agentPresets");
    if (presets) {
        try {
            await presets.mount(agentCtx, ctx.agent?.session?.header?.agentPreset);
```

Cordis answers an undeclared property read on that scope with `Error: cannot get property "agent"
without inject`. The mount is inside a `try` that logs the failure, and the next line,
`const logged = ctx.agent?.session?.requestHeader?.()?.config;`, is not, so the callback rejects, the
agent factory disposes the half-built agent, and `agents.create` rejects. Every WeChat message then
answers with `⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。` and the log carries
`[dsh-wechat] preset mount failed: Error: cannot get property "agent" without inject` followed by
`[dsh-wechat] create session failed: …`.

The published package has since fixed this itself. `dsh-wechat@0.10.0` runs the same callback as
`export async function agentSetup(agentCtx, agent)` and reads `live?.session?.header?.agentPreset`
and `live?.session?.requestHeader?.()?.config`, with the doc comment "DSH 0.1.5 removed `ctx.agent`;
`setup` now receives `(agentCtx, agent)`". Its declared `engines.dsh: >=0.2.0-rc.2` is metadata no
loader on the plugin path enforces — setting it up on this baseline mounts the row, attaches the
native command layer and the approval/question waterfall answerers, and completes the QR login — so
the profile pin moved to it. `0.11.0` is not usable: it declares `dsh >=0.2.0-rc.2 <0.3.0-0`.

## Decision

The profile pins `dsh-wechat@0.10.0`, which is the correction. `apps/desktop/src/bundled-plugins.ts`
carries the pin and the reasoning; nothing in this fork configures the plugin.

`apps/desktop/scripts/patch-wechat-sessions.mjs` remains as the guard for a tree that still resolves
`0.8.0` — a profile reused from an older seed, or a pin that slides back. It corrects the installed
module while `apps/desktop/scripts/prepare-seed.ts` builds the seed. The callback takes the agent from
where the agent factory already passes it — `AgentSetup = (agentCtx: Context, agent: Agent)`, invoked
as `setup?.(prepared.agent.ctx, prepared.agent)` — so the patch changes the signature to
`async function agentSetup(agentCtx, agent)` and rewrites the two reads to
`agent?.session?.header?.agentPreset` and `agent?.session?.requestHeader?.()?.config`. Nothing else
in the module changes.

The patch writes the corrected bytes to a temporary file and renames it over the module. pnpm
hardlinks store entries into the profile, so editing the file in place would rewrite the store copy
through the link while the recorded store index still describes the previous bytes.

`prepare-seed.ts` runs the patch right after the production install and before
`archiveLinkedProfile`, so the archived store, the link manifest, and the tree
`verifyOfflineInstallation` materializes from them all carry the corrected module; the same run
re-reads the anchors out of the materialized tree and fails the build when they are missing or
unchanged. The script takes a profile directory or a `node_modules` root, so the same command repairs
a profile that already exists on a machine.

Anchoring is exact and fails loudly. The patch first asks whether the module reads the agent as a
property of the setup context at all; a module that does not — 0.10.0 takes it as the callback's
argument — needs nothing. A module that does read it through lines the patch cannot anchor on aborts
the build with the line it could not find, because an unpatched plugin fails at the user's first
WeChat message instead of in the release run.

## Alternatives considered

**Stay on `0.8.0` and carry the byte patch alone.** That was the first shape of this fix, and it
leaves the correction tied to one distribution's exact text. `0.10.0` states the corrected contract
in its own source, so the pin moved and the patch stayed as the guard.

**Pin `dsh-wechat@0.11.0`.** It requires dsh 0.2.x, so the profile cannot install it.

**Declare `agent` on the plugin's own context.** The setup context belongs to the agent factory; a
plugin cannot add injections to it without shipping a new plugin build, which is the upgrade path
this note rejects.

**Have the shell repair the profile at startup.** Every launch would rewrite a profile file, and the
repair would live outside the artifact the release verifies. Building the corrected bytes into the
seed fixes the installer, the archived store, and every profile materialized from it in one place.

## Consequences

The seed still carries a byte patch of a third-party distribution file, so it can repair a tree that
pins `0.8.0`; on the shipped `0.10.0` it reads the module, finds no agent read on the setup context,
and changes nothing. Correcting a `0.8.0` module costs one file rename per seed build and adds no
runtime behavior of its own.

The plugin's remaining failures keep their own reporting: a login that times out, an unreachable
WeChat service, or a rejected preset mount still log through the plugin's existing messages.

`apps/desktop/tests/patch-wechat-sessions.spec.ts` covers the rewrite, the refusal on a module it
cannot anchor on, the untouched `0.10.0` module, the command line against an installed profile, and
the post-patch verification of both tree forms.
