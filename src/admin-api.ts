/**
 * Admin JSON API routes.
 *
 * All routes live under /api/auth (session-cookie authenticated, admin
 * gated, 8 KB body cap). The standalone /admin HTML page was removed: user
 * management ships inside the GUI settings panel (设置-用户管理) via the
 * browser bundle's settings section — these JSON routes are its backend.
 * The webserver registers (kind, path) pairs — not methods — so the users
 * collection path dispatches GET (list) and POST (create) inside one handler.
 */
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionStore } from './session.ts'
import type { UserStore } from './users.ts'
import { MAX_HOST_LENGTH, isBareAuthority } from './hosts.ts'
import type { TrustedHosts } from './hosts.ts'
import { readBody, sendJson } from './http-json.ts'
import { extractSessionToken } from './auth.ts'
import type { DefaultWorkspaceSetting } from './workspace-setting.ts'
import type { BooleanSetting } from './boolean-setting.ts'
import type { CompatApplyResult } from './remote-web-ui-compat.ts'
import { deriveCapabilities } from './capabilities.ts'

/** Shared dependencies for the admin routes. */
export interface AdminDeps {
  users: UserStore
  store: SessionStore
  /** TrustedHosts registry surfaced to admins for listing/manual management. Optional for back-compat. */
  hosts?: TrustedHosts
  /** Live + persisted "默认用户工作空间" toggle. Optional for back-compat. */
  defaultWorkspaceSetting?: DefaultWorkspaceSetting
  /** Live + persisted "remote-web-ui 兼容" toggle. Optional for back-compat. */
  remoteWebUiSetting?: BooleanSetting
  /** Runtime applier of the compat flag to remote-web-ui (returns the outcome). */
  onRemoteWebUiApply?: (enabled: boolean) => Promise<CompatApplyResult>
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

  // Per-identity capability surface: tells a client what this identity may
  // actually use, so it does not probe (and get denied on) everything else.
  // Session-authenticated, not admin-gated — ordinary users need it most.
  const capabilitiesRoute: WebRoute = { kind: 'exact', path: '/api/auth/capabilities', handler: async (req, res) => {
    const session = requireSession(deps, req)
    if (session === undefined) return sendJson(res, 401, { error: 'authentication required' })
    return sendJson(res, 200, {
      username: session.user,
      isAdmin: session.isAdmin,
      capabilities: deriveCapabilities({ username: session.user, isAdmin: session.isAdmin }),
    })
  } }

  const usersRoute: WebRoute = { kind: 'exact', path: '/api/auth/admin/users', handler: async (req, res) => {
    if (req.method === 'GET') {
      if (requireAdmin(deps, req, res) === undefined) return
      const records = await deps.users.list()
      const online = deps.store.onlineCounts()
      return sendJson(res, 200, {
        users: records.map(record => ({
          username: record.username,
          isAdmin: record.isAdmin,
          lastLoginAt: record.lastLoginAt ?? null,
          disabled: record.disabled === true,
          onlineSessions: online.get(record.username) ?? 0,
        })),
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

  const hosts = deps.hosts
  const hostsRoute: WebRoute | undefined = hosts === undefined ? undefined : { kind: 'exact', path: '/api/auth/admin/hosts', handler: async (req, res) => {
    if (req.method === 'GET') {
      if (requireAdmin(deps, req, res) === undefined) return
      return sendJson(res, 200, { hosts: hosts.list() })
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      if (requireAdmin(deps, req, res) === undefined) return
      return sendJson(res, 405, { error: 'method not allowed' })
    }
    if (requireAdmin(deps, req, res) === undefined) return
    const body = await readJsonObject(req)
    if (body === null || typeof body.host !== 'string' || body.host.length === 0) {
      return sendJson(res, 400, { error: 'bad request' })
    }
    // Reject non-bare inputs (path/userinfo/query would be silently rewritten
    // by canonicalAuthority) and oversized strings up front — mirroring
    // config's assertTrustedAuthority strictness (review #2/#5).
    const raw = body.host
    if (raw.length > MAX_HOST_LENGTH || !isBareAuthority(raw)) {
      return sendJson(res, 400, { error: 'invalid host' })
    }
    const canonical = hosts.canonicalize(raw)!
    if (req.method === 'POST') {
      // add() re-validates: rejects loopback/redundant entries; true = newly
      // added (201), false = already present / already-trusted (200).
      const added = hosts.add(raw)
      return sendJson(res, added ? 201 : 200, { ok: true, host: canonical })
    }
    hosts.remove(canonical)
    return sendJson(res, 200, { ok: true, host: canonical })
  } }

  const userDisable: WebRoute = { kind: 'exact', path: '/api/auth/admin/users/disable', handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === undefined) return
    const body = await readJsonObject(req)
    if (body === null || typeof body.username !== 'string' || typeof body.disabled !== 'boolean') {
      return sendJson(res, 400, { error: 'bad request' })
    }
    const target = body.username
    const records = await deps.users.list()
    const record = records.find(u => u.username === target)
    if (record === undefined) return sendJson(res, 404, { error: 'unknown user' })
    if (body.disabled && record.isAdmin && records.filter(u => u.isAdmin && u.disabled !== true).length === 1) {
      return sendJson(res, 409, { error: 'cannot disable the last enabled admin' })
    }
    await deps.users.setDisabled(target, body.disabled)
    // Disabling must bite immediately: revoke the user's live cookie
    // sessions so a stale cookie cannot ride out the TTL.
    if (body.disabled) deps.store.revokeAllFor(target)
    return sendJson(res, 200, { ok: true })
  } }

  // Live + persisted "默认用户工作空间" toggle. The /api provisioner reads it
  // per request, so a toggle takes effect immediately (no restart needed).
  const setting = deps.defaultWorkspaceSetting
  const settingRoute: WebRoute | undefined = setting === undefined ? undefined : { kind: 'exact', path: '/api/auth/admin/settings/default-workspace', handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === undefined) return
    if (req.method === 'GET') return sendJson(res, 200, { enabled: setting.get() })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    const body = await readJsonObject(req)
    if (body === null || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'bad request' })
    setting.set(body.enabled)
    return sendJson(res, 200, { ok: true, enabled: setting.get() })
  } }

  // Live + persisted "remote-web-ui 兼容" toggle. When enabled, dsh-login writes
  // @linxin666/dsh-remote-web-ui's requirePairingForLan to false so non-loopback
  // (public FRP) desktop traffic rides dsh-login's /api channel instead of
  // remote-web-ui's device-pairing gate. onRemoteWebUiApply reports the runtime
  // outcome (ok/skipped/unregistered) so the panel can tell the admin whether
  // the flag actually reached remote-web-ui.
  const remoteSetting = deps.remoteWebUiSetting
  const remoteSettingRoute: WebRoute | undefined = remoteSetting === undefined ? undefined : { kind: 'exact', path: '/api/auth/admin/settings/remote-web-ui-compat', handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === undefined) return
    if (req.method === 'GET') return sendJson(res, 200, { enabled: remoteSetting.get() })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    const body = await readJsonObject(req)
    if (body === null || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'bad request' })
    remoteSetting.set(body.enabled)
    let applied: CompatApplyResult = 'skipped'
    if (deps.onRemoteWebUiApply !== undefined) applied = await deps.onRemoteWebUiApply(body.enabled)
    return sendJson(res, 200, { ok: true, enabled: remoteSetting.get(), applied })
  } }

  const routes: WebRoute[] = [me, capabilitiesRoute, usersRoute, userPassword, userRemove, userDisable]
  if (hostsRoute !== undefined) routes.push(hostsRoute)
  if (settingRoute !== undefined) routes.push(settingRoute)
  if (remoteSettingRoute !== undefined) routes.push(remoteSettingRoute)
  return routes
}
