/**
 * Login/logout/setup API handlers for the multi-user flow.
 *
 * Login parses `{username, password}` and verifies against the UserStore
 * (scrypt hashes in the DSH credentials system). Setup is gated on
 * `users.isEmpty()` and creates the forced-admin first account, logging it
 * in immediately. The old single-password credential flow (announce +
 * credentials-storage helpers) was removed with the multi-user switch —
 * the old `password` config key remains configured but unused by these
 * handlers (it now only namespaces the `_USERS` credential ref).
 */
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import type { UserStore } from './users.ts'
import { readBody, sendJson } from './http-json.ts'
import { buildCookieHeader, buildClearCookieHeader, extractSessionToken } from './auth.ts'

/** Shared dependencies for the login/setup handlers. */
export interface LoginDeps {
  users: UserStore
  store: SessionStore
  /** Session lifetime in seconds; stamped onto the Set-Cookie Max-Age. */
  sessionTtl: number
}

/** Parse and validate a `{username, password}` JSON body; null on bad input. */
async function parseCredentials(req: IncomingMessage): Promise<{ username: string; password: string } | null> {
  let body: string
  try {
    body = await readBody(req)
  } catch {
    return null
  }
  let parsed: { username?: unknown; password?: unknown }
  try {
    parsed = JSON.parse(body) as { username?: unknown; password?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return null
  return { username: parsed.username, password: parsed.password }
}

/**
 * Create the POST /api/auth/login handler. Verifies `{username, password}`
 * against the UserStore and, on match, creates a session and sets the
 * cookie. 401 on invalid credentials; 500 while no user exists (setup mode).
 */
export function createLoginHandler(deps: LoginDeps): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const creds = await parseCredentials(req)
    if (creds === null) {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    if (await deps.users.isEmpty()) {
      sendJson(res, 500, { error: 'no users configured' })
      return
    }
    const record = await deps.users.verify(creds.username, creds.password)
    if (record === undefined) {
      sendJson(res, 401, { error: 'invalid credentials' })
      return
    }
    const session = deps.store.create(record.username, record.isAdmin)
    res.setHeader('Set-Cookie', buildCookieHeader(session.token, deps.sessionTtl))
    sendJson(res, 200, { ok: true })
  }
}

/**
 * Create the POST /api/auth/logout handler. Revokes the session (if present)
 * and clears the cookie.
 */
export function createLogoutHandler(store: SessionStore): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const token = extractSessionToken(req.headers.cookie)
    if (token !== undefined) store.revoke(token)
    res.setHeader('Set-Cookie', buildClearCookieHeader())
    res.writeHead(200)
    res.end()
  }
}

/**
 * Create the GET /logout handler: revoke the session (if present), clear
 * the cookie, and redirect to /login. A convenience twin of the POST route
 * so a plain link can log the user out.
 */
export function createLogoutRedirectHandler(store: SessionStore): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const token = extractSessionToken(req.headers.cookie)
    if (token !== undefined) store.revoke(token)
    res.setHeader('Set-Cookie', buildClearCookieHeader())
    res.writeHead(302, { Location: '/login' })
    res.end()
  }
}

/**
 * Create the POST /api/auth/setup handler. Only callable while no user
 * exists (first-time setup): creates the forced-admin account and logs it
 * in. Returns 403 once any user exists.
 */
export function createSetupHandler(deps: LoginDeps): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Security gate: only allow setup while the user store is empty.
    if (!(await deps.users.isEmpty())) {
      sendJson(res, 403, { error: 'users already exist' })
      return
    }
    const creds = await parseCredentials(req)
    if (creds === null || creds.password.length === 0) {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    let record
    try {
      // First account is always the forced admin.
      record = await deps.users.create(creds.username, creds.password, true)
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const session = deps.store.create(record.username, record.isAdmin)
    res.setHeader('Set-Cookie', buildCookieHeader(session.token, deps.sessionTtl))
    sendJson(res, 200, { ok: true })
  }
}
