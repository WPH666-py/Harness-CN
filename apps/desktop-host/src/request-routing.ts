/** Which in-process owner answers one request the desktop carrier did not claim itself. */

/** Owner of a response for a request the API gateway and client-module table did not claim. */
export type UnclaimedRequestOwner = 'webserver' | 'assets'

/** How one unclaimed request is offered to the two owners. */
export interface UnclaimedRequestInput {
  /** HTTP method of the request. */
  readonly method: string
  /** Loopback port the composed webserver listens on, absent without that row. */
  readonly port: number | undefined
  /** Status the webserver already answered with, absent before it is offered the request. */
  readonly status?: number
}

/**
 * Decide who answers one request the desktop carrier did not claim.
 *
 * The composed webserver is the only owner of the routes plugin host halves register through
 * `ctx.inject(['webServer'])`, and those include the POST routes a settings panel writes
 * through, so a request reaches it whatever its method. The webserver answers 404 when no
 * registered route claimed the path, which is how it says the shell still owns the request:
 * only a read may then fall through to the read-only asset handler, because offering it a
 * write would replace the webserver's own status with a method error the shell never made.
 * @param input - request method, webserver port, and the status it answered with when known.
 * @returns `webserver` to route the request there, `assets` to answer it from the shell.
 */
export function unclaimedRequestOwner(input: UnclaimedRequestInput): UnclaimedRequestOwner {
  if (input.port === undefined) return 'assets'
  if (input.status !== 404) return 'webserver'
  return input.method === 'GET' || input.method === 'HEAD' ? 'assets' : 'webserver'
}
