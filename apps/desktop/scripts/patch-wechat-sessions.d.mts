/**
 * Rewrite the installed `dsh-wechat` session module so its agent-scoped setup reads the agent it is
 * handed instead of reaching for it through the setup context, which Cordis refuses without an
 * `agent` injection.
 * @param source - Contents of `dsh-wechat/dist/dsh/sessions.js`.
 * @returns The corrected source, or undefined when the module never reads the agent off its context.
 * @throws When the module reads the agent off its context in a form this patch does not recognize.
 */
export function patchWeChatSessions(source: string): string | undefined

/**
 * Check that the `dsh-wechat` module under one tree can create a session: it must exist, and it must
 * not read the agent off its setup context.
 * @param root - A `node_modules` root, or a profile directory holding one.
 * @returns The path of the module that was checked.
 * @throws When the tree carries no `dsh-wechat` module, or the module still reads the agent off its
 * setup context.
 */
export function verifyWeChatSessions(root: string): string
