/**
 * Move the installed `dsh-workbuddy-connect` release check off the launch path and onto a button in
 * the plugin's own settings card.
 * @param source - Contents of `dsh-workbuddy-connect/lib/client.js`.
 * @returns The rewritten client.
 * @throws When an anchor this patch needs appears more or less than once.
 */
export function patchClientSource(source: string): string

/**
 * Whether an installed client already carries the suppression.
 * @param source - Contents of `dsh-workbuddy-connect/lib/client.js`.
 * @returns true when the card owns the check instead of the mount effect.
 */
export function hasUpdateNoticePatch(source: string): boolean

/**
 * Patch the `dsh-workbuddy-connect` client under one tree.
 * @param root - A `node_modules` directory of an installed profile or seed.
 * @returns A line describing what happened.
 * @throws When the tree holds the plugin but one of the anchors is missing.
 */
export function patchWorkBuddyUpdateNotice(root: string): string

/**
 * Require the moved check in a tree the seed produced.
 * @param root - A profile directory holding `node_modules`.
 * @throws When the installed client still checks for its own release at launch.
 */
export function verifyWorkBuddyUpdateNotice(root: string): void
