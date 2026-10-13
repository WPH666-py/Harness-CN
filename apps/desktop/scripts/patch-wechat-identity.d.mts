/** The name the WeChat bridge answers to inside the WeChat conversation. */
export const WECHAT_BOT_NAME: string

/**
 * Append the product name to the installed `dsh-wechat` built-in surface prompt, which is what the
 * bridge injects for a WeChat-bound session. WeChat's own contact name for the bot is assigned by
 * Tencent's iLink platform and is not settable from the bridge.
 * @param source - Contents of `dsh-wechat/dist/config.js`.
 * @returns The corrected source, or undefined when the prompt already carries the product name.
 * @throws When the module exports no surface prompt this patch anchors on.
 */
export function patchWeChatIdentity(source: string): string | undefined

/**
 * Check that the `dsh-wechat` module under one tree names the bridge: it must exist, and its built-in
 * surface prompt must carry the product name.
 * @param root - A `node_modules` root, or a profile directory holding one.
 * @returns The path of the module that was checked.
 * @throws When the tree carries no `dsh-wechat` module, or its built-in prompt never names the bridge.
 */
export function verifyWeChatIdentity(root: string): string
