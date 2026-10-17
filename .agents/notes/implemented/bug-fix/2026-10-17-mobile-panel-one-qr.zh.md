# Agent Note: 移动访问面板先把二维码藏起来，用户看见的是一堆按钮

Status: implemented

[English](2026-10-17-mobile-panel-one-qr.md) | 中文

## Problem

桌面端面板是用户配对手机的地方：打开它、把摄像头对准屏幕。实际看到的却是一片控件 —— 诊断、下载 Android App、局域网/远程 切换、插件更新卡、扩展计数、额外可信网段·高级、生成并复制密钥、复制配对链接、管理配对设备、清除所有设备 —— 没有二维码。配对二维码只有在点了那两个「复制」按钮之后才作为副作用出现：

- 生成并复制密钥 把配对密钥复制到剪贴板，顺手把码画出来；
- 复制配对链接 复制一个 URL，同样顺手画码；
- 清除所有设备 就挨着 管理配对设备，一次点击清空全部已配对设备，没有二次确认。

用户的原话是：「二维码呢？还有，多余的按钮和功能都去掉，只保留刷新二维码、开关局域网、管理配对设备三项。对已配对的设备、提供删除按钮。」—— 屏幕上没有码，周围的东西又太多。

## Cause

`lib/client.js` 从上到下一次性构建面板，二维码容器初始是隐藏的：

```js
const qrBox = element("div", "dsh-mobile-control__qr");
qrBox.hidden = true;
```

只有 `openPairing(target)` 会往里填内容，而它的两个调用点都是复制快捷键：

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

`openPairing` 先画码，再把密钥写进剪贴板并显示状态行。于是：用户不点别的东西就永远看不到码；剪贴板被拒绝时，状态行会变成裸露的密钥。这些区块也没有任何配置项，它们在 `root.append(panel)` 的树里被无条件追加。

## Evidence

- 已安装的包体 `C:/Users/admin/.harness-cn/profiles/desktop/node_modules/dsh-mobile/lib/client.js`（dsh-mobile 0.6.4，656 773 字节）：`qrBox` 在 6790 行（`hidden = true`），`pair`/`linkPair` 在 6799/6802，`showQr` 在 8085，`openPairing` 在 8099，两个点击处理器在 9930–9937。
- 面板自己的文案是 `generateCopyKey: "生成并复制密钥"`（436 行）与 `copyPairLink: "复制配对链接"`（437 行）—— 都在承诺复制。
- 打补丁后，live profile 的包体为 659 439 字节，sha256 `9bd7b85b0a098a67696063ac7aedd4d3c9ae68f888f9b52abc3c3b0323c6cf3c`，`node --check` 通过。
- 重启已安装的应用后通过 WebView2 CDP 实测：`.dsh-mobile-control__qr` 为 `hidden: false` 且含 1 个 `<img>`；可见按钮恰好是 关闭局域网访问、刷新二维码、管理配对设备；截图里二维码占满面板。

## Decision

在打包期修改 vendored 包体，新增 `apps/desktop/scripts/patch-mobile-panel.mjs`（与 `patch-mobile-listen.mjs`、`patch-mobile-session.mjs` 同机制），用 `DSH_MOBILE_PANEL_SIMPLIFY` 标记文件：

1. 在 en/zh/it 三张文案表里加 `refreshQrCode`，并把中文的设备行按钮 `revoke` 改成「删除」。
2. 往面板里追加一个 `<style>`，隐藏 标签切换、Android 下载行、插件更新卡、版本提示、扩展计数、额外可信网段、远程视图、诊断视图、标题栏里的额外入口、第二个操作按钮和 清除所有设备；剩余网格收成一列，三个控件占满宽度。
3. 把保留下来的主按钮重绑到本地 `simplifiedShowQr()`：POST `/api/mobile-access/lan/pairing/open` 并画出 `qrSvg`，**不碰剪贴板**。面板打开时由 `panel.hidden` 上的 `MutationObserver` 加 800 ms 挂载计时器自动画码；九分钟的时效守卫会在十分钟配对窗口过期前重画。

包体里没有删除任何代码：远程、诊断、更新、可信网段的路径仍然接通，只是在这个面板里没有可见入口。

## Alternatives considered

- **直接删掉多余构建代码。** 包体 11 377 行，构建用的闭包后面还在引用这些元素（`pair.disabled = …`、`resetAll.disabled = …`）；隐藏它们能让所有路径保持有效，风险小得多。
- **加一个配置开关。** 这个面板没有配置面 —— 它只读 `/api/mobile-access/*`。
- **只把二维码显示出来，保留复制按钮。** 清除所有设备 仍然挨着 管理配对设备，用户明确要求去掉的东西也还在。

## Consequences

- 打开面板即可扫码；刷新二维码 会重画并开一个新的配对窗口；开关局域网 / 管理配对设备 是仅有的另外两个动作。
- 中文界面下每台已配对设备的按钮现在写着「删除」，底层仍然是 `devices/revoke`。
- 主路径不再碰剪贴板，剪贴板权限被拒绝也不会把状态行换成裸链接。
- 打包现在依赖七个字面锚点加一个挂载点。将来升级挪动它们时，seed 构建会以 `desktop seed: the profile the seed produced has no simplified dsh-mobile panel` 失败，而不是悄悄发回旧面板。
- 日志里能看到 `patch-mobile-panel: patched …`（复用缓存树时是 `already`），因此跳过补丁的构建是可辨认的。
