/**
 * Session wall for the shared `/api` bridge (DSH ≥ 0.1.6-alpha.2).
 *
 * Under option A (DSH ≥ 0.1.5-alpha.1) the native `connection` row owns the
 * `/api` carrier and dsh-login no longer wraps it. That row fences requests by
 * Host/Origin and its process-wide browser-auth cookie — which every logged-in
 * dsh-login user receives through `authorizeIndex` on the SPA index, and which
 * outlives a dsh-login logout. So the only per-user boundary on /api was the
 * (composition-only) remote guard; a browser that once obtained the
 * browser-auth cookie could keep calling the bridge after its dsh-login
 * session ended.
 *
 * DSH 0.1.6-alpha.2 added the `connection/request` waterfall on that bridge
 * ("admit or wrap an authenticated shared API request"): a listener runs
 * before the bridge and vetoes the request by not calling `next`. dsh-login
 * registers this wall: a valid `dsh_session` cookie admits the request;
 * anything else answers 401 and stops the chain — logout/expiry now actually
 * revokes /api access, and /api access requires a dsh-login identity even
 * though the browser-auth cookie itself stays process-wide.
 *
 * Deliberately NOT covered (unchanged boundaries):
 * - The connection row's own fence still runs first upstream (Host/Origin
 *   trust, then browser auth) — this wall only adds the dsh-login layer.
 * - Plugin-exact webServer routes (dsh-login's `/api/auth/*`, remote-web-ui's
 *   `/api/pair/*`) never reach the bridge, so pre-login pairing flows keep
 *   working.
 * - The Remote stream mux WebSocket upgrade (`registerUpgrade`) is fenced by
 *   upstream's `requestRejection` only; there is no per-request hook there.
 * - Plugin-exact `/api/...` routes a third-party plugin registers directly on
 *   the webServer bypass the bridge (the 2026-08-28 boundary note).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extractSessionToken } from './auth.ts'
import type { SessionStore } from './session.ts'

/** The `connection/request` waterfall listener shape (DSH ≥ 0.1.6-alpha.2). */
export type ApiBridgeAuthListener = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => Promise<void>,
) => Promise<void>

/**
 * Build the bridge wall. Fail-closed: a missing, malformed, expired, or
 * revoked session cookie answers 401 (plain text, like the upstream fence)
 * and never calls `next`.
 * @param store - the dsh-login session store (the same one the login wall
 *   and the /api/auth routes use, so revocations apply immediately).
 */
export function createApiBridgeAuth(store: SessionStore): ApiBridgeAuthListener {
  return async (request, response, next) => {
    const token = extractSessionToken(request.headers.cookie)
    const session = token === undefined ? undefined : store.verify(token)
    if (session !== undefined) {
      store.cleanup()
      return next()
    }
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('unauthorized')
  }
}
