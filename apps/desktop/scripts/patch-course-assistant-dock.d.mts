/**
 * Replace the composer dock of the installed `dsh-course-assistant` client bundle with one button.
 * @param source - Contents of `dsh-course-assistant/client.js`.
 * @returns true when the dock is one labelled button and no stale dock CSS remains.
 */
export function hasCourseAssistantDockPatch(source: string): boolean

/**
 * Patch the `dsh-course-assistant` client bundle under one tree.
 * @param root - A `node_modules` directory of an installed profile or seed.
 * @returns A line describing what happened.
 * @throws When the tree holds the plugin but neither the dock component nor its CSS is recognizable.
 */
export function patchCourseAssistantDock(root: string): string

/**
 * Require the one-button dock in a tree the seed produced.
 * @param root - A profile directory holding `node_modules`.
 * @throws When the installed bundle still renders the dock as a caption beside a link.
 */
export function verifyCourseAssistantDock(root: string): void
