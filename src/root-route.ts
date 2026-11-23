import type { IncomingMessage, ServerResponse } from 'node:http'

/** The gateway's response-owning handler shape the root hook reuses. */
export type RootGateway = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** Dispatch to the next `webserver/request` listener, or the matched route. */
export type RootNext = () => Promise<void>

/**
 * Whether a request is the bare SPA root this hook must answer.
 *
 * Only `GET`/`HEAD` on exactly `/` qualify. Requests carrying `?token=` are
 * excluded so the native launch-token handshake still runs: the webserver
 * emits a launch-token URL as the process entry, and that listener mints the
 * owner cookie before the browser reaches the gateway.
 *
 * @param request - any request-shaped object carrying a method and URL.
 * @returns true when the gateway should own the response.
 */
export function isRootRequest(request: { method?: string; url?: string }): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const url = new URL(request.url ?? '/', 'http://dsh.invalid')
  if (url.pathname !== '/') return false
  return url.searchParams.get('token') === null
}

/**
 * Handle the bare root path before named-route dispatch.
 *
 * DSH 0.2.3-alpha.1 added a core exact `/` route (remote-connection's browser
 * pairing page). A named route wins over the fallback seat, so without this
 * hook the login wall never sees `/`:
 *
 * - an anonymous browser gets remote-connection's own "Connect to this Host"
 *   card (401) instead of a redirect to `/login`;
 * - a browser holding a live `dsh_session` is delegated to
 *   `readResource('index.html')`, which answers 404 because dsh-login's
 *   fallback seat holds a *handler* (only a resource route can be read).
 *
 * `webserver/request` runs before named-route and fallback dispatch, and the
 * core route cannot be replaced (a duplicate `(kind, path)` registration
 * throws), so the gateway answers `/` itself here: the same handler that owns
 * the fallback — wall for anonymous, rendered index for a live session.
 *
 * @param gateway - the gateway handler (the fallback seat's handler).
 * @returns a `webserver/request` waterfall listener.
 */
export function createRootRouteListener(gateway: RootGateway): (
  request: IncomingMessage,
  response: ServerResponse,
  next: RootNext,
) => Promise<void> {
  return async (request, response, next) => {
    if (!isRootRequest(request)) {
      await next()
      return
    }
    await gateway(request, response)
  }
}
