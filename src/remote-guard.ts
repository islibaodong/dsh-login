/**
 * Per-user isolation guard for the Remote layer (option A, DSH ≥ 0.1.5-alpha.1).
 *
 * Under option A dsh-login no longer takes over the `/api` carrier, so per-user
 * conversation/workspace isolation is enforced where Remote methods are
 * dispatched — the live `ctx.typertGateway` (`invoke({namespace,method,args})`
 * / `stream`). This module wraps that gateway for non-admin users: it rejects
 * admin-only namespaces wholesale, refuses Remote calls a user may not make, and
 * rejects a call whose args address a session/workspace not in the caller's
 * owned set (the `ownership` sidecar). Admin users pass through unfiltered.
 *
 * The caller user and its owned-set are supplied by callbacks; in a real web
 * deployment the deployment maps the invoking agent/session to the dsh-login
 * user (each dsh-login user acts inside their own agent subtree → ownership
 * sidecar). A test supplies deterministic callbacks.
 */
import { USER_ALLOWED } from './api-filter.ts'

/** The live Remote-invocation request shape (structurally, from typertGateway). */
export interface RemoteInvokeRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** The slice of the gateway this guard wraps. */
export interface RemoteGateway {
  invoke(request: RemoteInvokeRequest): Promise<unknown>
  stream(request: RemoteInvokeRequest): Promise<AsyncIterable<unknown>>
}

/** Per-method identity (set by the caller on first dispatch). */
export interface GuardUser {
  username: string
  isAdmin: boolean
}

/** Resolve the user of the invoking agent/session. Return undefined to deny. */
export type UserResolver = () => GuardUser | undefined

/**
 * Whether an id (session/workspace) is owned by the resolved user. Defaulting to
 * false keeps the guard fail-closed when the deployment has not wired the
 * ownership sidecar lookup.
 */
export type OwnedPredicate = (id: string) => boolean

/** Domains whose every method is admin-only (mirrors the old ADMIN_ONLY_DOMAINS). */
const ADMIN_ONLY_NAMESPACES = new Set([
  'credentials', 'settings', 'agentPresets',
  // DSH 0.1.6-alpha.2: the native plugin manager installs, enables, disables,
  // and removes profile bundles — never reachable by an ordinary user.
  'pluginManager',
  // DSH 0.1.7-alpha.2: the account controller (`namespace: 'account'`) drives
  // the process-wide upstream DeepSeek Platform grant — startSignIn/signOut/
  // cancelSignIn rebind or revoke THE instance's account — and even the read
  // projections (getState/getProfile/getBalance) expose the operator's
  // profile and recharge-wallet balance. Entire namespace is admin-only;
  // ordinary users are denied by default (absent from USER_ALLOWED), this is
  // defense-in-depth, and capabilities.ts mirrors it in the two-segment deny
  // list and the quiet-deny set.
  'account',
])

/**
 * Args fields that may carry a session or workspace id, plus the plural/agent
 * shapes some REMOTE methods use (`sessionIds: [...]`, `agentId`). Every id
 * collected from a present field must be owned before the call is forwarded.
 * The non-exhaustive coverage here is defense-in-depth on top of the primary
 * agent-keyed isolation — a deployment composing the guard MAY extend the set
 * to match its live REMOTE method signatures.
 */
const GUARDED_ID_FIELDS = [
  'sessionId', 'sessionIds',
  'parentSessionId', 'parentSessionIds',
  'childSessionId', 'childSessionIds',
  'agentId', 'workspaceId', 'beforeSessionId',
  // DSH 0.1.6-alpha.2: the scoped session identity the Gateway's
  // workspaceFileScope lookup resolves for the document-preview surface
  // (`workspaceFiles.*`, `officeToPdf.render`) — carries a SessionId on the
  // wire exactly like `sessionId`.
  'workspaceFileScopeId',
] as const

/**
 * Collect every session/workspace id mentioned by an args value: a scalar
 * string, an array (or nested array) of strings / {id} / {sessionId} / {agentId}
 * records, or a nested {id}/{sessionId}/{agentId} object. Non-id-shaped values
 * contribute nothing (a missing id is not an authorization grant — the owned-set
 * check still fails closed on any id actually present).
 */
function collectIds(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value)) return value.flatMap(collectIds)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of ['id', 'sessionId', 'sessionIds', 'agentId', 'workspaceId'] as const) {
      const nested = record[key]
      if (nested !== undefined) return collectIds(nested)
    }
    // An array of nested records (e.g. [{id},{id}]) is already caught by the
    // Array branch above; here we also reconcile object values carrying an
    // id under a non-keyed shape by scanning a short id-ish whitelist once.
    for (const [k, v] of Object.entries(record)) {
      if (GUARDED_ID_FIELDS.includes(k as (typeof GUARDED_ID_FIELDS)[number])) {
        return collectIds(v)
      }
    }
  }
  return []
}

/** A forbidden Remote method, echoing the rejected endpoint. */
function forbidden(namespace: string, method: string): Error {
  return Object.assign(new Error(`dsh-login: forbidden: ${namespace}.${method}`), { code: 'forbidden' })
}

/**
 * Wrap a Remote gateway with per-user isolation.
 * @param gateway - the live `typertGateway` (or a fake in tests).
 * @param resolveUser - returns the invoking user, or undefined to deny.
 * @param owns - ownership test for a session/workspace id; default fail-closed deny.
 * @returns a gateway of the same shape that enforces the guard per call.
 */
export function wrapRemoteGateway(
  gateway: RemoteGateway,
  resolveUser: UserResolver,
  owns: OwnedPredicate = () => false,
): RemoteGateway {
  const allowed = (user: GuardUser, namespace: string, method: string): boolean => {
    if (user.isAdmin) return true
    if (ADMIN_ONLY_NAMESPACES.has(namespace)) return false
    // Ordinary-user surface expressed per Remote endpoint (mirrors the old
    // RpcMethodMap allow-list, now `namespace.method`).
    return USER_ALLOWED.has(`${namespace}.${method}`)
  }

  const ownershipGuarded = (user: GuardUser, request: RemoteInvokeRequest): boolean => {
    if (user.isAdmin) return true
    for (const field of GUARDED_ID_FIELDS) {
      for (const id of collectIds(request.args[field])) {
        if (id !== '' && !owns(id)) return false
      }
    }
    return true
  }

  const refuse = (user: GuardUser | undefined, request: RemoteInvokeRequest): boolean =>
    user === undefined || !allowed(user, request.namespace, request.method) || !ownershipGuarded(user, request)

  return {
    async invoke(request: RemoteInvokeRequest): Promise<unknown> {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method)
      return gateway.invoke(request)
    },
    async stream(request: RemoteInvokeRequest): Promise<AsyncIterable<unknown>> {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method)
      return gateway.stream(request)
    },
  }
}

export default wrapRemoteGateway

/**
 * Build the Remote-isolation wiring for a real deployment, given the live
 * service accessors. The invoking user is resolved from the current Cordis
 * agent's session id → `OwnershipIndex` → username; an unowned/absent initiator
 * denies (fail-closed). Admin flag comes from the caller, since an admin has no
 * single ownership record.
 *
 * This is the seam-1 glue: `requiresAgents` supplies the current-initiator
 * session id (the deployment wires `ctx.get('agents')` when available), and
 * `ownership.lookup` maps it to a user.
 */
export function createRemoteIsolation(options: {
  /** Current agent's session id (from `ctx.agents.currentInitiator()`), or undefined. */
  currentSessionId: () => string | undefined
  /** The ownership sidecar mapping sessionId → username. */
  ownership: { lookup(sessionId: string): string | undefined }
  /** Admin check for a username (e.g. from the UserStore); defaults to false. */
  isAdmin?: (username: string) => boolean
  /**
   * Identify an admin session without requiring an ownership record: return the
   * admin's username for a session that belongs to an admin, or undefined
   * otherwise. Resolved before the sidecar, so an admin whose session has no
   * ownership record is still let through (admins pass the guard unfiltered).
   * Defaults to undefined (no such sessions) — keep fail-closed.
   */
  isAdminSession?: (sessionId: string) => string | undefined
}): { resolveUser: UserResolver; owns: OwnedPredicate } {
  const resolveUser = (): GuardUser | undefined => {
    const sid = options.currentSessionId()
    if (sid === undefined) return undefined
    // Admin sessions short-circuit the sidecar: an admin has no single
    // ownership record (review #4), so resolve them without requiring one.
    const adminUser = options.isAdminSession?.(sid)
    if (adminUser !== undefined && adminUser !== '') {
      return { username: adminUser, isAdmin: true }
    }
    const username = options.ownership.lookup(sid)
    if (username === undefined || username === '') return undefined
    return { username, isAdmin: options.isAdmin?.(username) ?? false }
  }
  // Ownership is scoped to the resolved user: an id is owned only when the
  // sidecar attributes it to the same username driving this call. Reading
  // `currentSessionId` again per id keeps the caller and the owned set in
  // sync across a chain; an unowned id stays fail-closed. An admin passes
  // (the guard already short-circuits on isAdmin, but keeps the contract here
  // consistent: an admin owns whatever they address).
  const owns: OwnedPredicate = (id) => {
    const user = resolveUser()
    if (user === undefined) return false
    if (user.isAdmin) return true
    return options.ownership.lookup(id) === user.username
  }
  return { resolveUser, owns }
}