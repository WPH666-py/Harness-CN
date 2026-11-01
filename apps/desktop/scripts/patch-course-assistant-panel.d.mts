/**
 * Add a close button to the header of the installed `dsh-course-assistant` client panel.
 * @param source - Contents of `dsh-course-assistant/client.js`.
 * @returns true when the panel takes the close callback and the header renders the close button.
 */
export function hasCourseAssistantPanelPatch(source: string): boolean

/**
 * Patch the `dsh-course-assistant` client bundle under one tree.
 * @param root - A `node_modules` directory of an installed profile or seed.
 * @returns A line describing what happened.
 * @throws When the tree holds the plugin but one of the panel anchors is missing.
 */
export function patchCourseAssistantPanel(root: string): string

/**
 * Require the panel close button in a tree the seed produced.
 * @param root - A profile directory holding `node_modules`.
 * @throws When the installed bundle still renders a panel header with no way out.
 */
export function verifyCourseAssistantPanel(root: string): void
