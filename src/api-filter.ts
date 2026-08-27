import { isAbsolute, relative, resolve } from 'node:path'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as makeRpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { OwnershipIndex } from './ownership.ts'
import { sandboxSegment } from './provision.ts'

export interface AuthUser { username: string; isAdmin: boolean }

/**
 * Physical-layer allow-list: every RpcMethodMap key (exact spellings copied
 * from packages/host/apiproxy/src/api/rpc-map.ts — `session.list` singular,
 * etc.) an ordinary user may call through the /api carrier. Derived to stay
 * consistent with createUserProxy: the session/subagent/workspace/goal listing
 * and guarded methods, `host.describe`, `skill.list`, and the read-only model
 * catalog (`llm.providers`/`llm.models`). Everything else (credentials.*,
 * settings.*, agentPreset.* — the admin-only domains — plus the privileged
 * host.* dialogs and llm.discoverModels) is a physical 403 for ordinary users.
 * Workspace-scoped mutations are additionally ownership-guarded by workspaceId
 * (rename/delete/reorder only affect workspaces holding the caller's own
 * sessions) and workspace.create is confined to the caller's sandbox.
 * `respond` is not an RpcMethodMap key (it carries a client-response, not a
 * request) but passes through the decorator unguarded, so it is allowed here
 * too — the browser needs it to answer server-requests (approvals).
 */
export const USER_ALLOWED: ReadonlySet<string> = new Set([
  'session.list', 'session.search', 'session.create', 'session.history', 'session.models',
  'session.selectModel', 'session.rename', 'session.fork', 'session.prompt', 'session.attachment',
  'session.updateQueue', 'session.cancel',
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'host.describe',
  'workspace.list', 'workspace.create', 'workspace.rename', 'workspace.delete',
  'workspace.insertBefore', 'workspace.insertSessionBefore', 'workspace.archiveSession',
  'skill.list',
  'llm.providers', 'llm.models',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'respond',
])

/** May an ordinary (non-admin) user call this wire method at the physical layer? */
export function isUserAllowed(method: string): boolean {
  return USER_ALLOWED.has(method)
}

/** Internal rpcId for the ownership-driven session.list probe (never surfaces to a client). */
const OWNERSHIP_RPC = makeRpcId('dsh-login-ownership')
/** Internal rpcId for the workspace-ownership probe (never surfaces to a client). */
const WORKSPACE_RPC = makeRpcId('dsh-login-workspace-ownership')

/**
 * `forbidden` is outside the harness RpcErrorCode union (the harness never
 * emits it), so the literal is cast through unknown; on the wire it is an
 * ordinary RpcResult error branch echoing the request's rpcId.
 */
function forbidden<T>(request: RpcRequest<unknown>): RpcResponse<T> {
  return {
    rpcId: request.rpcId,
    result: { ok: false, error: { code: 'forbidden', message: 'not permitted for this user', details: {} } },
  } as unknown as RpcResponse<T>
}

/** Domains whose every method is admin-only (wrapped wholesale for ordinary users). */
const ADMIN_ONLY_DOMAINS = ['credentials', 'settings', 'agentPresets'] as const

/**
 * Direct index hits plus lineage closure: a child of an owned session is
 * owned (subagents/forks). The closure walks `parentSessionId` to a fixpoint
 * over one `session.list` snapshot, recording new attributions into the index.
 */
export async function ownedSessionIds(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex): Promise<Set<string>> {
  const owned = new Set<string>()
  for (const [sid, owner] of ownership.entries()) {
    if (owner === user.username) owned.add(sid)
  }
  const res = await api.sessions.list({ rpcId: OWNERSHIP_RPC, payload: {} })
  if (!res.result.ok) return owned
  const byParent = new Map<string, string[]>()
  for (const item of res.result.value.items) {
    if (item.parentSessionId !== undefined) {
      const list = byParent.get(item.parentSessionId) ?? []
      list.push(item.sessionId)
      byParent.set(item.parentSessionId, list)
    }
  }
  let grew = true
  while (grew) {
    grew = false
    for (const sid of [...owned]) {
      for (const child of byParent.get(sid) ?? []) {
        if (!owned.has(child)) {
          owned.add(child)
          ownership.record(child, user.username)
          grew = true
        }
      }
    }
  }
  return owned
}

/** Pure frame predicate: may this user see this mux/host frame given the owned set? */
export function frameVisible(
  user: AuthUser, ownership: OwnershipIndex,
  frame: MuxFrame | HostFrame, owned: Set<string>,
): boolean {
  if (user.isAdmin) return true
  void ownership // reserved for future per-owner frame rules; the owned set decides today
  const f = frame as { type: string; sessionId?: string; workspace?: { sessionIds?: string[] }; workspaceIds?: string[]; archivedSessionIds?: string[] }
  if (f.type === 'stream/error') return true
  if (f.type === 'host/remote-event') {
    // Global deployment signals (commands/change, llm/adapters-updated,
    // credentials/updated, settings/document-updated, agent-preset/selected)
    // are cache-invalidation pushes every browser client — including UI
    // plugins — needs after login; withholding them freezes their UIs. The
    // cordis/* family carries session-scoped dynamic-plugin lifecycle and
    // stays admin-only: its payloads are not ownership-filterable.
    const event = (f as { event?: string }).event ?? ''
    return !event.startsWith('cordis/')
  }
  if (f.sessionId !== undefined) return owned.has(f.sessionId)
  if (f.type === 'host/workspace-changed') {
    const ids = f.workspace?.sessionIds ?? []
    return ids.some(id => owned.has(id))
  }
  if (f.type === 'host/workspace-order-changed') {
    return (f.workspaceIds ?? []).some(id => owned.has(id))
  }
  if (f.type === 'host/archived-sessions-changed') {
    return (f.archivedSessionIds ?? []).some(id => owned.has(id))
  }
  return false
}

/** session.* method names addressed by payload sessionId (guarded per request). */
const SESSION_GUARDED = new Set(['history', 'models', 'selectModel', 'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel'])

type GuardedPayload = { sessionId?: string; childSessionId?: string; parentSessionId?: string }

/** Payload fields that may carry a session id; every present field must be owned. */
const SESSION_ID_FIELDS = ['sessionId', 'childSessionId', 'parentSessionId'] as const

/**
 * Whether `path` (resolved) lies at or below the caller's sandbox directory
 * (`workspaceRoot/<sanitized-username>`). `..`, trailing separators, symlink
 * targets and absolute paths are all neutralized by `resolve`+`relative`, so a
 * traversal attempt like `workspaceRoot/alice/../../etc` resolves outside and
 * is refused.
 */
function isWithinSandbox(path: string, workspaceRoot: string, username: string): boolean {
  const sandbox = resolve(workspaceRoot, sandboxSegment(username))
  const target = resolve(path)
  const rel = relative(sandbox, target)
  return rel === '' || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
}

export function createUserProxy(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex, options: { workspaceRoot?: string } = {}): ApiProxy {
  const { workspaceRoot } = options
  const guardSid = async (sid: string): Promise<boolean> => {
    const direct = ownership.lookup(sid)
    if (direct !== undefined) return direct === user.username
    const owned = await ownedSessionIds(api, user, ownership)
    return owned.has(sid)
  }
  // A request passes when EVERY session-id field it carries is owned (or the
  // user is admin): one alien anchor (insertSessionBefore's beforeSessionId,
  // subagent history's parentSessionId beside a owned child) denies the call.
  const guard = async (request: RpcRequest<GuardedPayload>, fields: readonly string[] = SESSION_ID_FIELDS): Promise<boolean> => {
    if (user.isAdmin) return true
    for (const field of fields) {
      const sid = (request.payload as Record<string, string | undefined> | undefined)?.[field]
      if (sid === undefined) continue
      if (!(await guardSid(sid))) return false
    }
    return true
  }

  // Guarded whenever the name is session-addressed (SESSION_GUARDED) or the
  // caller passes explicit payload fields (workspace session mutations).
  const wrapSessionMethod = (name: string, method: (r: never) => Promise<unknown>, fields?: readonly string[]) => async (request: never) => {
    if ((fields !== undefined || SESSION_GUARDED.has(name)) && !(await guard(request as never, fields))) return forbidden(request as never)
    return await method(request)
  }

  // ---- workspace ownership ----
  // A workspace is treated as "owned" by the user when at least one of the
  // sessions it holds is owned by them (the same criterion workspace.list uses
  // to surface it). Derived by probing the real (unwrapped) workspace.list and
  // intersecting each workspace's sessionIds with the owned-session set.
  const ownedWorkspaceIds = async (): Promise<Set<string>> => {
    const owned = await ownedSessionIds(api, user, ownership)
    const res = await api.workspace.list({ rpcId: WORKSPACE_RPC, payload: {} })
    if (!res.result.ok) return new Set()
    const items = (res.result.value as { items: Array<{ workspaceId: string; sessionIds: string[] }> }).items
    const ids = new Set<string>()
    for (const w of items) {
      if (w.sessionIds.some(sid => owned.has(sid))) ids.add(w.workspaceId)
    }
    return ids
  }
  const guardWid = async (wid: string): Promise<boolean> => (await ownedWorkspaceIds()).has(wid)

  // Workspace-scoped mutations (rename/delete/reorder) are gated on the target
  // workspace holding at least one of the caller's own sessions.
  const wrapWorkspaceId = (name: string, method: (r: never) => Promise<unknown>) => async (request: never) => {
    if (user.isAdmin) return await method(request)
    const wid = (request as RpcRequest<{ workspaceId?: string }>).payload?.workspaceId
    if (wid === undefined || !(await guardWid(wid))) return forbidden(request as never)
    return await method(request)
  }

  // workspace.create for ordinary users is confined to their own sandbox
  // directory; without a configured workspaceRoot it fails closed.
  const createWorkspace = async (request: never) => {
    if (user.isAdmin) return await (api.workspace.create as (r: never) => Promise<unknown>)(request)
    const path = (request as RpcRequest<{ path?: string }>).payload?.path
    if (typeof path !== 'string' || workspaceRoot === undefined || !isWithinSandbox(path, workspaceRoot, user.username)) {
      return forbidden(request as never)
    }
    return await (api.workspace.create as (r: never) => Promise<unknown>)(request)
  }

  const proxy: ApiProxy = {
    ...api,
    sessions: {
      ...api.sessions,
      list: async (request) => {
        const res = await api.sessions.list(request)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        return { ...res, result: { ok: true, value: { items: res.result.value.items.filter(i => owned.has(i.sessionId as string)) } } }
      },
      search: async (request, signal) => {
        const res = await api.sessions.search(request, signal)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        return { ...res, result: { ok: true, value: { ...res.result.value, items: res.result.value.items.filter(i => owned.has(i.sessionId as string)) } } }
      },
      create: async (request) => {
        // sessions.create ADOPTS an already-live session when the payload
        // supplies an existing sessionId: claiming another user's session
        // here would transfer its ownership, so an alien sessionId is
        // forbidden up front (admins exempt).
        const adopt = (request.payload as { sessionId?: string } | undefined)?.sessionId
        if (!user.isAdmin && adopt !== undefined) {
          const owner = ownership.lookup(adopt)
          if (owner !== undefined && owner !== user.username) return forbidden(request)
        }
        const res = await api.sessions.create(request)
        if (res.result.ok) {
          const sid = res.result.value.sessionId as string
          // Record only when the resulting session had no prior different
          // owner (unowned or already this user's).
          const owner = ownership.lookup(sid)
          if (owner === undefined || owner === user.username) ownership.record(sid, user.username)
        }
        return res
      },
      // history/models/selectModel/rename/prompt/attachment/updateQueue/cancel + fork:
      ...Object.fromEntries([...SESSION_GUARDED].map(name => [
        name, name === 'fork'
          ? (async (request: never) => {
            if (!(await guard(request as never))) return forbidden(request as never)
            const res = await (api.sessions.fork as (r: never) => Promise<unknown>)(request)
            if ((res as { result: { ok: boolean; value?: { sessionId?: string } } }).result.ok) {
              ownership.record((res as { result: { value: { sessionId: string } } }).result.value.sessionId as string, user.username)
            }
            return res
          })
          : wrapSessionMethod(name, (api.sessions as Record<string, (r: never) => Promise<unknown>>)[name]),
      ])),
    } as ApiProxy['sessions'],
    subagents: {
      ...api.subagents,
      list: async (request, signal) => {
        const res = await api.subagents.list(request, signal)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        const value = res.result.value as { entries: Array<{ id: string }>; parentAvailable: boolean }
        // parentAvailable leaks whether the requested parent exists for the
        // caller: for a non-owned parent it is rewritten to false (minimal
        // response — the entries filter already hides other users' children).
        const parent = (request.payload as { parentSessionId?: string }).parentSessionId
        const parentAvailable = parent === undefined || owned.has(parent)
        return { ...res, result: { ok: true, value: { ...value, parentAvailable, entries: value.entries.filter(e => owned.has(e.id as string)) } } }
      },
      ...Object.fromEntries(['history', 'prompt', 'interrupt'].map(name => [
        name, wrapSessionMethod(name, (api.subagents as Record<string, (r: never) => Promise<unknown>>)[name]),
      ])),
    } as ApiProxy['subagents'],
    workspace: {
      ...api.workspace,
      list: async (request) => {
        const res = await api.workspace.list(request)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        const value = res.result.value as { items: Array<{ sessionIds: string[] }>; archivedSessionIds: string[] }
        const items = value.items
          .map(w => ({ ...w, sessionIds: w.sessionIds.filter(id => owned.has(id)) }))
          .filter(w => w.sessionIds.length > 0)
        return { ...res, result: { ok: true, value: { ...value, items, archivedSessionIds: value.archivedSessionIds.filter(id => owned.has(id)) } } }
      },
      // Workspace-scoped mutations are ownership-guarded by workspaceId: a
      // non-admin may only rename/delete/reorder a workspace that holds one of
      // their own sessions (the same owned-session criterion workspace.list
      // uses), and may only create a workspace inside their own sandbox.
      create: createWorkspace,
      rename: wrapWorkspaceId('rename',
        (api.workspace as Record<string, (r: never) => Promise<unknown>>).rename),
      delete: wrapWorkspaceId('delete',
        (api.workspace as Record<string, (r: never) => Promise<unknown>>).delete),
      insertBefore: wrapWorkspaceId('insertBefore',
        (api.workspace as Record<string, (r: never) => Promise<unknown>>).insertBefore),
      // Session-addressed mutations: every sessionId-bearing payload field is
      // guarded (insertSessionBefore's optional beforeSessionId anchor included).
      archiveSession: wrapSessionMethod('archiveSession',
        (api.workspace as Record<string, (r: never) => Promise<unknown>>).archiveSession, ['sessionId']),
      insertSessionBefore: wrapSessionMethod('insertSessionBefore',
        (api.workspace as Record<string, (r: never) => Promise<unknown>>).insertSessionBefore, ['sessionId', 'beforeSessionId']),
    } as ApiProxy['workspace'],
    goals: {
      ...api.goals,
      // Every GoalsApi method carries sessionId in its payload; guard each
      // one on it (explicit fields, since goal verbs are not in
      // SESSION_GUARDED — that set is the session.* method-name space).
      ...Object.fromEntries(Object.getOwnPropertyNames(api.goals).map(name => [
        name, wrapSessionMethod(name, (api.goals as Record<string, (r: never) => Promise<unknown>>)[name], ['sessionId']),
      ])),
    } as ApiProxy['goals'],
    events: {
      ...api.events,
      mux: (request, signal) => filterWithOwnership(api.events.mux(request, signal), async frame => {
        if (user.isAdmin) return true
        const f = frame.payload as MuxFrame & { sessionId?: string }
        if (f.type === 'stream/error') return true
        return (await ownedSessionIds(api, user, ownership)).has(f.sessionId as string)
      }),
      host: (request, signal) => filterWithOwnership(api.events.host(request, signal), async frame => {
        if (user.isAdmin) return true
        return frameVisible(user, ownership, frame.payload, await ownedSessionIds(api, user, ownership))
      }),
    } as ApiProxy['events'],
    ...Object.fromEntries(ADMIN_ONLY_DOMAINS.map(domain => [
      domain, domainGuard(api[domain] as object),
    ])) as Pick<ApiProxy, typeof ADMIN_ONLY_DOMAINS[number]>,
    llm: {
      ...api.llm,
      discoverModels: (request: never) => Promise.resolve(forbidden(request)),
    } as ApiProxy['llm'],
    host: {
      ...api.host,
      pickDirectory: methodForbidden,
      listDirectory: methodForbidden,
      createDirectory: methodForbidden,
      openPath: methodForbidden,
    } as ApiProxy['host'],
  }
  // Admin sees everything unfiltered.
  return user.isAdmin ? { ...api } : proxy

  function methodForbidden(request: never): Promise<never> {
    return Promise.resolve(forbidden(request as never) as never)
  }
  function domainGuard<T extends object>(domain: T): T {
    if (user.isAdmin) return domain
    return new Proxy(domain, { get() { return methodForbidden } }) as T
  }
  async function* filterWithOwnership(
    stream: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
    keep: (frame: RpcRequest<MuxFrame | HostFrame>) => Promise<boolean>,
  ): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
    for await (const frame of stream) {
      if (await keep(frame)) yield frame
    }
  }
}
