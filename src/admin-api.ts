/**
 * Admin JSON API + admin HTML page routes.
 *
 * All JSON routes live under /api/auth (session-cookie authenticated, admin
 * gates where noted, 8 KB body cap). `GET /admin` serves the self-contained
 * management page to admin sessions and redirects everyone else to /login.
 * The webserver registers (kind, path) pairs — not methods — so the users
 * collection path dispatches GET (list) and POST (create) inside one handler.
 */
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionStore } from './session.ts'
import type { UserStore } from './users.ts'
import { readBody, sendJson } from './http-json.ts'
import { extractSessionToken } from './auth.ts'
import { renderAdminPage } from './login-page.ts'

/** Shared dependencies for the admin routes. */
export interface AdminDeps {
  users: UserStore
  store: SessionStore
}

/** Resolve the live session from the request cookie, if any. */
function requireSession(deps: AdminDeps, req: IncomingMessage): Session | undefined {
  const token = extractSessionToken(req.headers.cookie)
  return token === undefined ? undefined : deps.store.verify(token)
}

/** Read and parse a JSON object body; null on oversized/malformed input. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body: string
  try {
    body = await readBody(req)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Admin gate: 401 without a session, 403 for non-admin sessions, else the session. */
function requireAdmin(deps: AdminDeps, req: IncomingMessage, res: ServerResponse): Session | undefined {
  const session = requireSession(deps, req)
  if (session === undefined) {
    sendJson(res, 401, { error: 'authentication required' })
    return undefined
  }
  if (!session.isAdmin) {
    sendJson(res, 403, { error: 'admin required' })
    return undefined
  }
  return session
}

export function createAdminRoutes(deps: AdminDeps): WebRoute[] {
  const me: WebRoute = { kind: 'exact', path: '/api/auth/me', handler: async (req, res) => {
    const session = requireSession(deps, req)
    if (session === undefined) return sendJson(res, 401, { error: 'authentication required' })
    return sendJson(res, 200, { username: session.user, isAdmin: session.isAdmin })
  } }

  const usersRoute: WebRoute = { kind: 'exact', path: '/api/auth/admin/users', handler: async (req, res) => {
    if (req.method === 'GET') {
      if (requireAdmin(deps, req, res) === undefined) return
      const records = await deps.users.list()
      return sendJson(res, 200, {
        users: records.map(record => ({ username: record.username, isAdmin: record.isAdmin, createdAt: record.createdAt })),
      })
    }
    if (requireAdmin(deps, req, res) === undefined) return
    const body = await readJsonObject(req)
    if (body === null) return sendJson(res, 400, { error: 'bad request' })
    const { username, password, isAdmin } = body
    if (typeof username !== 'string' || typeof password !== 'string' || password.length === 0) {
      return sendJson(res, 400, { error: 'bad request' })
    }
    if (isAdmin !== undefined && typeof isAdmin !== 'boolean') return sendJson(res, 400, { error: 'bad request' })
    if ((await deps.users.list()).some(u => u.username === username)) {
      return sendJson(res, 409, { error: 'user exists' })
    }
    try {
      await deps.users.create(username, password, isAdmin === true)
    } catch {
      return sendJson(res, 400, { error: 'bad request' })
    }
    return sendJson(res, 201, { ok: true })
  } }

  const userPassword: WebRoute = { kind: 'exact', path: '/api/auth/admin/users/password', handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === undefined) return
    const body = await readJsonObject(req)
    if (body === null) return sendJson(res, 400, { error: 'bad request' })
    const { username, password } = body
    if (typeof username !== 'string' || typeof password !== 'string' || password.length === 0) {
      return sendJson(res, 400, { error: 'bad request' })
    }
    try {
      await deps.users.setPassword(username, password)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('unknown user')) return sendJson(res, 404, { error: 'unknown user' })
      return sendJson(res, 400, { error: 'bad request' })
    }
    // A password change must force re-login with the new password: revoke
    // the user's live cookie sessions so old cookies stop working.
    deps.store.revokeAllFor(username)
    return sendJson(res, 200, { ok: true })
  } }

  const userRemove: WebRoute = { kind: 'exact', path: '/api/auth/admin/users/remove', handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === undefined) return
    const body = await readJsonObject(req)
    if (body === null || typeof body.username !== 'string') return sendJson(res, 400, { error: 'bad request' })
    const target = body.username
    const records = await deps.users.list()
    const record = records.find(u => u.username === target)
    if (record === undefined) return sendJson(res, 404, { error: 'unknown user' })
    if (record.isAdmin && records.filter(u => u.isAdmin).length === 1) {
      return sendJson(res, 409, { error: 'cannot remove the last admin' })
    }
    await deps.users.remove(target)
    // The removed user must lose access immediately: revoke their live
    // cookie sessions so a stale cookie cannot ride out the TTL.
    deps.store.revokeAllFor(target)
    return sendJson(res, 200, { ok: true })
  } }

  const adminPage: WebRoute = { kind: 'exact', path: '/admin', handler: async (req, res) => {
    const session = requireSession(deps, req)
    if (session === undefined || !session.isAdmin) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderAdminPage())
  } }

  return [me, usersRoute, userPassword, userRemove, adminPage]
}
