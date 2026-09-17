/** Cooperative scheduling for long filesystem walks that run inside the Electron shell. */

/**
 * Entries processed before a walk hands the event loop back.
 *
 * The bound is deliberately small: the shell serves its own windows over a custom protocol
 * handled in this process, so a walk that never yields also stops the startup window from
 * loading, which reads to a user as a frozen application rather than as slow work.
 */
export const COOPERATIVE_BATCH_ENTRIES = 2048

/** Hand the event loop back so pending protocol, IPC, and window work can run. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}
