# Agent Note: The mobile access panel asked for a secret before it would show the one thing a user needs — a QR code

Status: implemented

English | [中文](2026-10-17-mobile-panel-one-qr.zh.md)

## Problem

The desktop panel is where a user pairs a phone: open it, point the camera at the screen. What it actually showed was a wall of controls — 诊断, a download row for the Android app, 局域网/远程 tabs, a plugin update card, an extension counter, 额外可信网段 · 高级, 生成并复制密钥, 复制配对链接, 管理配对设备 and 清除所有设备 — and no QR code at all. The pairing QR only appeared after clicking one of two buttons whose labels promise a copy, not a code:

- 生成并复制密钥 copied a pairing key to the clipboard and drew the code as a side effect;
- 复制配对链接 copied a URL, again drawing the code as a side effect;
- 清除所有设备 sat one button away from 管理配对设备 and deleted every paired device without a confirmation step.

The user's report is exactly this: 「二维码呢？还有，多余的按钮和功能都去掉，只保留刷新二维码、开关局域网、管理配对设备三项。对已配对的设备、提供删除按钮。」 — no code on screen, and too much surface around it.

## Cause

`lib/client.js` builds the panel once, top to bottom, and the QR box starts hidden:

```js
const qrBox = element("div", "dsh-mobile-control__qr");
qrBox.hidden = true;
```

Only `openPairing(target)` ever fills it, and both callers are the copy shortcuts:

```js
pair.addEventListener("click", () => {
	pair.disabled = true;
	openPairing("key");
});
linkPair.addEventListener("click", () => {
	linkPair.disabled = true;
	openPairing("link");
});
```

`openPairing` draws the code and then writes the secret to the clipboard, showing a status message. So the code is never on screen until the user asks for something else, and a denied clipboard permission turns the status line into the raw secret. Nothing in the panel is configurable: the extra sections are appended unconditionally in `root.append(panel)`'s tree.

## Evidence

- Installed bundle `C:/Users/admin/.harness-cn/profiles/desktop/node_modules/dsh-mobile/lib/client.js` (dsh-mobile 0.6.4, 656 773 bytes): `qrBox` at line 6790 (`hidden = true`), `pair`/`linkPair` at 6799/6802, `showQr` at 8085, `openPairing` at 8099, the two click handlers at 9930–9937.
- The panel's own labels are `generateCopyKey: "生成并复制密钥"` (line 436) and `copyPairLink: "复制配对链接"` (line 437) — both promises of a copy.
- After the patch below, the live profile bundle is 659 439 bytes, sha256 `9bd7b85b0a098a67696063ac7aedd4d3c9ae68f888f9b52abc3c3b0323c6cf3c`, and passes `node --check`.
- Driven over WebView2 CDP after restarting the installed app: the panel reports `.dsh-mobile-control__qr` with `hidden: false` and one `<img>`, and the visible buttons are exactly 关闭局域网访问, 刷新二维码, 管理配对设备; the screenshot shows the code filling the panel.

## Decision

Patch the vendored bundle at packaging time in `apps/desktop/scripts/patch-mobile-panel.mjs`, alongside `patch-mobile-listen.mjs` and `patch-mobile-session.mjs`, marking the file with `DSH_MOBILE_PANEL_SIMPLIFY`:

1. Add a `refreshQrCode` label to the en/zh/it tables and relabel the device row's `revoke` to 删除 in Chinese.
2. Append one `<style>` element inside the panel that hides the tab strip, the Android download row, the plugin update card, the release notice, the extension counter, 额外可信网段, the remote view, the diagnostics view, the header's extra entries, the second action button and 清除所有设备. The remaining grid collapses to one column, so the three controls stack full width.
3. Rebind the surviving primary button to a local `simplifiedShowQr()` that POSTs `/api/mobile-access/lan/pairing/open` and draws `qrSvg` **without** touching the clipboard. A `MutationObserver` on `panel.hidden` plus an 800 ms mount timer draw the code as soon as the panel opens; a nine-minute staleness guard redraws it before the ten-minute pairing window lapses.

Nothing is deleted from the bundle: the remote, diagnostics, update and trusted-network code paths stay wired and reachable from the plugin's own surfaces, they just have no visible entry point in this panel.

## Alternatives considered

- **Delete the extra construction code.** The bundle is 11 377 lines built from closures that reference those elements afterwards (`pair.disabled = …`, `resetAll.disabled = …`); hiding them keeps every path valid for a fraction of the risk.
- **Ship a configuration flag.** The panel has no configuration surface at all — it reads `/api/mobile-access/*` and nothing else.
- **Unhide the QR and leave the copy buttons.** Still leaves 清除所有设备 one click from 管理配对设备 and keeps surface the user explicitly asked to remove.

## Consequences

- Opening the panel shows a scannable code immediately; 刷新二维码 redraws one with a fresh window, and 开关局域网 / 管理配对设备 are the only other actions.
- Every paired row now reads 删除 in Chinese; the underlying `devices/revoke` call is unchanged.
- The clipboard side effect is gone from the primary path, so a denied clipboard permission can no longer replace the status line with the raw link.
- Packaging now depends on seven literal anchors plus the mount point. An upgrade that moves them fails the seed build with `desktop seed: the profile the seed produced has no simplified dsh-mobile panel` instead of quietly shipping the old panel.
- The patch is visible in the seed log as `patch-mobile-panel: patched …` (or `already` for a reused cached tree), so a build that skipped it is identifiable.
