# Agent Note: The 移动访问 window opens on the WeChat connection page

Status: implemented

English | [中文](2026-11-26-mobile-access-window-opens-wechat-connection.zh.md)

## Problem

The 移动访问 window rendered `apps/desktop-shell/rsc/lan.html`: a LAN door switch, a QR code, the pairing link, and a regenerate button. The phone entry this product ships is the WeChat bridge (`dsh-wechat`), which pairs a phone through WeChat and already owns a full settings page — login state, bot id, `cwd`, `cardTimeoutMs`, the cross-session switches, the channel hint prompt, 保存配置, 重新扫码, 退出登录, and the platform limits. Two separate pairing surfaces meant two places to change, and the menu entry did not lead to the page a user actually configures.

## Decision

The `lan` menu entry now opens the workspace page at `/?settings=wechat` in a 1120×820 window. The settings shell (`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`) reads `?settings=<id>` once at mount and starts with its dialog open on that section; an absent or empty value keeps the ordinary closed state. The id is the one the plugin registers (`wechat`, in `dsh-wechat/dist/client.js`), so the window renders the plugin's own page and follows it across plugin releases.

Until that section registers, the panel keeps its existing fallback to the first available row and switches to `wechat` when the ledger entry arrives, because `SettingsRoot` projects the active id against the live `settings.section` rows on every render.

The LAN door itself is unchanged: `apps/desktop-shell/src/lan-access.ts` still persists the switch and secret, and `/shell-api/lan*` still serves the link and QR. The shell window no longer exposes them, so the persisted state is what governs a phone reaching the GUI.

## Alternatives considered

**Reimplement the WeChat controls inside `lan.html`.** The page owns fifteen fields and three session actions that the plugin is free to change; a copy would drift from the plugin on its next release.

**Drive the settings dialog from an injected script** (click the trigger, then the WeChat nav row), as the QQ console window does. The section id is already addressable, and clicking by localized text breaks when the label changes.

**Keep both pages behind a tab in the window.** The request was to replace the window's content; a tab preserves the duplicate surface the change removes.

## Consequences

The window is titled 移动访问 and shows the settings dialog over the workspace page; closing the dialog leaves that page open in the window. A profile without `dsh-wechat` opens on the first registered section, which is the shell's normal fallback rather than an error.

The LAN door has no on-screen control in this build. Enabling or rotating it is limited to machines where it was already on, and the pairing link can only be read through `/shell-api/lan` directly.

`packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` covers the named section opening on mount and the empty parameter leaving the dialog closed.
