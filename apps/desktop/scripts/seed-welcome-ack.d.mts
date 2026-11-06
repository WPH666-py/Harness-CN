/**
 * Acknowledge the preview notice in a seed's profile patch layer, so a fresh profile starts with the
 * notice already accepted and a first launch opens straight into the workspace. The acknowledgement
 * version is read from the client that compares it, so the two cannot drift.
 * @param root - Directory the seed is assembled in.
 * @returns A line describing what happened.
 * @throws When the profile patch already exists without the acknowledgement row.
 */
export function seedWelcomeAcknowledgement(root: string): string

/**
 * Require the acknowledgement in a tree the seed produced.
 * @param root - A seed or profile directory holding `cordis.patch.yml`.
 * @throws When the patch layer is missing or does not acknowledge the current notice version.
 */
export function verifyWelcomeAcknowledgement(root: string): void
