/**
 * Account settings section, host half. The section is desktop-renderer only,
 * so this half carries no behavior; it exists so the Loader sees the package
 * as an ordinary plugin whose only meaningful entry is `./client`.
 */

/** Host plugin body — no host-side behavior for this client-only surface. */
export function apply(): void {}
