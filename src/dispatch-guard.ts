/**
 * Dispatch-seam isolation for streaming Remote methods (issue #11).
 *
 * Why this exists
 * ---------------
 * The bridge wall (`api-bridge-auth.ts`) only gates HTTP POST requests on the
 * shared `/api` channel. Streaming methods (`workspace.follow`,
 * `session.follow`, `terminal.attach`, …) travel over the Remote stream mux
 * WebSocket (`/api/remote.mux`), which the upstream webserver upgrades
 * directly: there is no per-request hook there and frames are not filtered
 * per user. The root cause is upstream's identity model — every browser
 * connection shares a single `browserPeer` whose principal is
 * `{ kind: 'owner' }` (dsh-login mints the launch-token cookie server-side),
 * so every dsh-login user is an owner as far as the gateway is concerned and
 * no upstream access control applies.
 *
 * The seam: `HostConnectionService.admit(request)` is a normal instance
 * method invoked dynamically at every dispatch site (HTTP route handler,
 * `requestRejection`, and `admitConnection` for upgrades), and
 * `TypertGatewayService.dispatchRpc` / `openWireStream` are likewise dynamic
 * property reads inside the connection interceptors' arrow closures. Placing
 * own-properties on those instances therefore intercepts all browser traffic
 * without touching upstream code:
 *
 *  - `admit` is shadowed to require a live dsh-login session on the browser
 *    path (closing the known "WS upgrade skips the wall" gap) and to tag the
 *    admitted peer with the dsh-login user. Tagging uses a lightweight
 *    wrapper (`Object.create(peer)` plus a non-enumerable symbol) because the
 *    underlying browser peer is shared across browsers — mutating it in
 *    place would race between users. Wrappers are cached per (peer id,
 *    session token) so the same browser session always sees the same peer
 *    object, which keeps upstream's `client.peer !== peer` identity checks
 *    working.
 *  - `dispatchRpc` / `openWireStream` are shadowed to consult that tag:
 *    untagged peers (launch-token CLI/SDK sessions, host-internal callers)
 *    pass through untouched, admins pass, the `$events` endpoints pass (the
 *    UI needs the event stream and its result channel), everything else is
 *    checked against the shared wire-surface classification and per-id
 *    ownership, and `workspace.follow` streams are filtered frame-by-frame —
 *    mirroring the upstream workspace-controller's per-principal follow
 *    filter (baseline narrowing, `upsert`/`remove`/`order` delivery-set
 *    bookkeeping, `replace` resyncs).
 *
 * Everything is feature-detected and best-effort: if upstream renames a
 * surface, the guard installs nothing (with a startup warning) and the
 * plugin keeps its previous behavior. Untagged peers keep the exact upstream
 * semantics, so CLI/API-token usage and the owner's own launch-token session
 * are unaffected.
 */

import type { IncomingMessage } from 'node:http'
import { extractSessionToken } from './auth.ts'
import type { SessionStore } from './session.ts'
import type { OwnershipIndex } from './ownership.ts'
import { classifyWireMethod } from './api-filter.ts'
import { collectIds, GUARDED_ID_FIELDS } from './remote-guard.ts'
import { probeOwnedSessionIds } from './bridge-list-filter.ts'
import type { SessionListSource } from './bridge-list-filter.ts'

/** Remote event endpoints (packages/api/gateway/src/stream-protocol.ts). */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** The wire endpoint of the workspace tree snapshot stream. */
const WORKSPACE_FOLLOW_ENDPOINT = 'workspace/follow'

/** Wrapper cache bound so long-lived hosts do not accumulate wrappers. */
const WRAPPER_CACHE_LIMIT = 1024

const PEER_USER: unique symbol = Symbol('dsh-login.peer-user')

export interface PeerUser {
  username: string
  isAdmin: boolean
}

/** Minimal peer surface the guards rely on (a superset is fine). */
export interface PeerLike {
  id: string
  principal: unknown
  interactions?: unknown
  signal: AbortSignal
  ctx?: unknown
  dispose?: () => Promise<void> | void
}

interface AdmitResult {
  peer?: PeerLike | undefined
  rejection?: number | undefined
}

interface AdmitLike {
  admit?: (this: unknown, request: IncomingMessage) => AdmitResult
}

interface DispatchLike {
  dispatchRpc?: (this: unknown, endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerLike) => unknown
  openWireStream?: (
    this: unknown,
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerLike,
    signal: AbortSignal,
    control: unknown,
    window: unknown,
  ) => unknown
}

export interface DispatchGuardDeps {
  store: SessionStore
  ownership: OwnershipIndex
  /** Live owned-session resolver for follow filtering; may return undefined (sidecar-only). */
  sessionSource: () => SessionListSource | undefined
}

/** Frame shapes of `workspace.follow` (packages/api/workspace-controller/src/types.ts). */
export interface WorkspaceFollowFrameLike {
  type: string
  value?: unknown
  workspace?: unknown
  workspaceId?: unknown
  workspaceIds?: unknown
  archivedSessionIds?: unknown
  pinnedSessionIds?: unknown
}

export function deniedRpc(): { ok: false; error: { code: string; message: string; details: object } } {
  return { ok: false, error: { code: 'forbidden', message: 'not permitted for this user', details: {} } }
}

export function deniedStreamError(endpoint: string): Error {
  return Object.assign(new Error(`dsh-login: forbidden stream: ${endpoint}`), { code: 'forbidden' })
}

/** Read the dsh-login tag off a (possibly wrapped) peer; undefined = untagged. */
export function peerUser(peer: unknown): PeerUser | undefined {
  if (typeof peer !== 'object' || peer === null) return undefined
  const tagged = peer as { [PEER_USER]?: PeerUser }
  const user = tagged[PEER_USER]
  if (typeof user !== 'object' || user === null) return undefined
  const username = (user as { username?: unknown }).username
  if (typeof username !== 'string' || username === '') return undefined
  return { username, isAdmin: user.isAdmin === true }
}

/** Resolve the dsh-login user behind an incoming request (cookie → session). */
export function userFromRequest(request: Pick<IncomingMessage, 'headers'>, store: SessionStore): PeerUser | undefined {
  const token = extractSessionToken(request.headers.cookie)
  if (token === undefined) return undefined
  const session = store.verify(token)
  if (session === undefined) return undefined
  return { username: session.user, isAdmin: session.isAdmin }
}

/**
 * Install the admit shadow. Returns the uninstall disposer.
 *
 * Feature-detected: a connection service without an `admit(request)` surface
 * installs nothing. When the request resolves to the shared browser peer and
 * carries no live dsh-login session it is rejected with 401 — this also
 * closes the pre-existing gap where a WS upgrade on `/api/remote.mux` with
 * only the process-launch cookie skipped the dsh-login wall entirely.
 */
export function installAdmitShadow(
  connection: AdmitLike & { browserPeer?: unknown },
  deps: DispatchGuardDeps,
  warn: (message: string) => void,
): () => void {
  const target = connection as unknown as Record<string, unknown>
  if (typeof target.admit !== 'function') {
    warn('dsh-login: stream guard skipped — connection service has no admit(request) surface')
    return () => {}
  }
  const original = target.admit as (this: unknown, request: IncomingMessage) => AdmitResult
  const hadOwnAdmit = Object.prototype.hasOwnProperty.call(target, 'admit')
  const browserPeer = target.browserPeer
  const wrappers = new Map<string, PeerLike>()
  const shadow = function admit(this: unknown, request: IncomingMessage): AdmitResult {
    const admission = original.call(this, request)
    if (typeof admission !== 'object' || admission === null) return admission
    if (admission.peer === undefined || admission.peer === null) return admission
    // Browser path: dsh-login's session store is the identity authority —
    // no live session means no admission (this also closes the pre-existing
    // "WS upgrade skips the wall" gap). API-credential path (v2 /connect
    // cookie, CLI/SDK): leave upstream semantics intact unless a dsh-login
    // session rides along, so a CLI token without one stays an untagged
    // owner exactly as before.
    const isBrowser = browserPeer !== undefined && admission.peer === browserPeer
    const token = extractSessionToken(request.headers?.cookie)
    if (token !== undefined) {
      const session = deps.store.verify(token)
      if (session !== undefined) {
        return { ...admission, peer: wrapTagged(admission.peer, { username: session.user, isAdmin: session.isAdmin }, token, wrappers) }
      }
    }
    return isBrowser ? { rejection: 401 } : admission
  } as (this: unknown, request: IncomingMessage) => AdmitResult
  target.admit = shadow
  return () => {
    if (target.admit !== shadow) return
    if (hadOwnAdmit) target.admit = original
    else delete target.admit
  }
}

function wrapTagged(peer: PeerLike, user: PeerUser, token: string, cache: Map<string, PeerLike>): PeerLike {
  const key = `${peer.id}|${token}`
  const existing = cache.get(key)
  if (existing !== undefined) return existing
  const wrapper: PeerLike = Object.create(peer)
  Object.defineProperty(wrapper, PEER_USER, { value: user, enumerable: false, writable: false, configurable: false })
  cache.set(key, wrapper)
  if (cache.size > WRAPPER_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return wrapper
}

/**
 * Install the dispatch shadows on the gateway service. Returns the uninstall
 * disposer. Feature-detected per surface; a missing surface is a startup
 * warning and keeps that channel unguarded.
 */
export function installDispatchShadows(
  gateway: DispatchLike | undefined,
  deps: DispatchGuardDeps,
  warn: (message: string) => void,
): () => void {
  if (gateway === undefined) {
    warn('dsh-login: stream guard skipped — typertGateway service is unavailable')
    return () => {}
  }
  const target = gateway as unknown as Record<string, unknown>
  const uninstalls: Array<() => void> = []
  if (typeof target.dispatchRpc === 'function') {
    uninstalls.push(shadowRpc(target, deps, warn))
  } else {
    warn('dsh-login: stream guard skipped — gateway service has no dispatchRpc surface')
  }
  if (typeof target.openWireStream === 'function') {
    uninstalls.push(shadowStream(target, deps, warn))
  } else {
    warn('dsh-login: stream guard skipped — gateway service has no openWireStream surface (streaming methods stay unguarded)')
  }
  return () => {
    for (const uninstall of uninstalls) uninstall()
  }
}

function shadowRpc(target: Record<string, unknown>, deps: DispatchGuardDeps, warn: (message: string) => void): () => void {
  const original = target.dispatchRpc as (this: unknown, ...args: unknown[]) => unknown
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'dispatchRpc')
  const warnedUnknown = new Set<string>()
  const shadow = function dispatchRpc(this: unknown, ...args: unknown[]): unknown {
    if (dispatchVerdict(args[0], args[1], args[3], deps, warnedUnknown, warn) === 'deny') return deniedRpc()
    return original.apply(this, args)
  } as (this: unknown, ...args: unknown[]) => unknown
  target.dispatchRpc = shadow
  return () => {
    if (target.dispatchRpc !== shadow) return
    if (hadOwn) target.dispatchRpc = original
    else delete target.dispatchRpc
  }
}

function shadowStream(target: Record<string, unknown>, deps: DispatchGuardDeps, warn: (message: string) => void): () => void {
  const original = target.openWireStream as (this: unknown, ...args: unknown[]) => unknown
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'openWireStream')
  const warnedUnknown = new Set<string>()
  // Async like the upstream surface: a synchronous guard throw must surface
  // as a rejected promise, exactly like an upstream dispatch error would.
  const shadow = async function openWireStream(this: unknown, ...args: unknown[]): Promise<unknown> {
    const endpoint = args[0]
    if (dispatchVerdict(endpoint, args[1], args[3], deps, warnedUnknown, warn) === 'deny') {
      throw deniedStreamError(typeof endpoint === 'string' ? endpoint : 'stream')
    }
    const result = await original.apply(this, args)
    if (endpoint === WORKSPACE_FOLLOW_ENDPOINT) {
      return wrapFollowSource(result, args[3], deps, warn)
    }
    return result
  }
  target.openWireStream = shadow
  return () => {
    if (target.openWireStream !== shadow) return
    if (hadOwn) target.openWireStream = original
    else delete target.openWireStream
  }
}

/**
 * Shared dispatch verdict for a tagged (non-admin) peer. Returns 'deny' or
 * 'pass'; untagged peers, admins, the `$events` endpoints, and any
 * non-`ns/method` endpoint shape pass — the last one is upstream's own
 * malformed-endpoint error to give.
 */
function dispatchVerdict(
  endpoint: unknown,
  payload: unknown,
  peer: unknown,
  deps: DispatchGuardDeps,
  warnedUnknown: Set<string>,
  warn: (message: string) => void,
): 'deny' | 'pass' {
  const user = peerUser(peer)
  if (user === undefined) return 'pass'
  if (user.isAdmin) return 'pass'
  if (typeof endpoint !== 'string' || endpoint === '') return 'pass'
  if (endpoint === REMOTE_EVENT_STREAM_ENDPOINT || endpoint === REMOTE_EVENT_RESULT_ENDPOINT) return 'pass'
  const parts = endpoint.split('/')
  if (parts.length !== 2) return 'pass'
  const dotted = `${parts[0]}.${parts[1]}`
  const classification = classifyWireMethod(dotted)
  if (classification !== 'user') {
    if (classification === 'unknown' && !warnedUnknown.has(dotted)) {
      warnedUnknown.add(dotted)
      warn(`dsh-login: stream guard denied unknown wire method '${dotted}' — upstream may have renamed it; refresh src/api-filter.ts`)
    }
    return 'deny'
  }
  const args = readDispatchArgs(payload)
  for (const id of guardedIds(args)) {
    if (deps.ownership.lookup(id) !== user.username) return 'deny'
  }
  return 'pass'
}

function readDispatchArgs(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as { args?: unknown }).args
}

/**
 * Collect ids from a wire args record: every GUARDED_ID_FIELDS entry present
 * contributes its ids (collectIds' object branch stops at the first matching
 * key, so an args record carrying both a sessionId and a workspaceId must be
 * scanned per field to leave no id unchecked).
 */
function guardedIds(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const ids: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!(GUARDED_ID_FIELDS as readonly string[]).includes(key)) continue
    for (const id of collectIds(value)) ids.push(id)
  }
  return ids
}

function wrapFollowSource(
  source: unknown,
  peer: unknown,
  deps: DispatchGuardDeps,
  warn: (message: string) => void,
): unknown {
  const user = peerUser(peer)
  if (user === undefined || user.isAdmin) return source
  if (typeof source !== 'object' || source === null) return source
  if (typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    warn('dsh-login: workspace.follow guard skipped — upstream stream handle is not async-iterable')
    return source
  }
  return filterWorkspaceFollowFrames(source as AsyncIterable<unknown>, deps, user)
}

/**
 * Filter a `workspace.follow` frame stream down to one user's view, mirroring
 * the upstream workspace-controller's per-principal filter:
 *
 *  - `baseline`/`replace` rebuild the owner-view model and deliver only the
 *    workspaces this user owns (directly via the ownership index, or through
 *    any owned session inside the workspace's `sessionIds`).
 *  - `upsert` forwards newly visible workspaces (narrowed), and resyncs an
 *    already-delivered workspace that just lost visibility with a `replace`.
 *  - `remove` is only forwarded for workspaces the client actually received.
 *  - `order` is re-delivered narrowed, or as a `replace` resync when a
 *    previously delivered workspace is no longer visible.
 *  - `archived`/`pinned` are forwarded narrowed to owned sessions.
 *  - Unknown frame shapes are dropped (fail closed) instead of forwarded.
 *
 * The owned-session set is refreshed from the sidecar plus a live session
 * probe before every frame, so long-running streams pick up newly created
 * sessions without a reconnect.
 */
export async function* filterWorkspaceFollowFrames(
  source: AsyncIterable<unknown>,
  deps: DispatchGuardDeps,
  user: PeerUser,
): AsyncGenerator<unknown, void, undefined> {
  const model = new Map<string, Record<string, unknown>>()
  const delivered = new Set<string>()
  let order: string[] = []
  let archived: string[] = []
  let pinned: string[] = []

  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []

  const ownsWorkspace = (item: Record<string, unknown>, owned: ReadonlySet<string>): boolean => {
    const workspaceId = item.workspaceId
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    if (deps.ownership.lookup(workspaceId) === user.username) return true
    for (const sessionId of stringList(item.sessionIds)) {
      if (owned.has(sessionId)) return true
    }
    return false
  }

  const narrowItem = (item: Record<string, unknown>, owned: ReadonlySet<string>): Record<string, unknown> => ({
    ...item,
    sessionIds: stringList(item.sessionIds).filter(sessionId => owned.has(sessionId)),
  })

  const filteredBaseline = (owned: ReadonlySet<string>): WorkspaceFollowFrameLike => {
    const ids = order.length > 0 ? order : [...model.keys()]
    const items: Record<string, unknown>[] = []
    for (const id of ids) {
      const item = model.get(id)
      if (item !== undefined && ownsWorkspace(item, owned)) items.push(narrowItem(item, owned))
    }
    return {
      type: 'replace',
      value: {
        items,
        archivedSessionIds: archived.filter(sessionId => owned.has(sessionId)),
        pinnedSessionIds: pinned.filter(sessionId => owned.has(sessionId)),
      },
    }
  }

  const visibleId = (id: string, owned: ReadonlySet<string>): boolean => {
    const item = model.get(id)
    return item !== undefined && ownsWorkspace(item, owned)
  }

  for await (const raw of source) {
    if (typeof raw !== 'object' || raw === null) continue
    const frame = raw as WorkspaceFollowFrameLike
    const owned = await probeOwnedSessionIds(user.username, deps.ownership, deps.sessionSource())
    switch (frame.type) {
      case 'baseline':
      case 'replace': {
        const value = frame.value
        if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) continue
        const baseline = value as { items: unknown[]; archivedSessionIds?: unknown; pinnedSessionIds?: unknown }
        model.clear()
        delivered.clear()
        archived = stringList(baseline.archivedSessionIds)
        pinned = stringList(baseline.pinnedSessionIds)
        const items: Record<string, unknown>[] = []
        for (const entry of baseline.items) {
          if (typeof entry !== 'object' || entry === null) continue
          const item = entry as Record<string, unknown>
          const workspaceId = item.workspaceId
          if (typeof workspaceId !== 'string' || workspaceId === '') continue
          model.set(workspaceId, item)
          if (ownsWorkspace(item, owned)) {
            delivered.add(workspaceId)
            items.push(narrowItem(item, owned))
          }
        }
        yield {
          type: frame.type,
          value: {
            ...baseline,
            items,
            archivedSessionIds: archived.filter(sessionId => owned.has(sessionId)),
            pinnedSessionIds: pinned.filter(sessionId => owned.has(sessionId)),
          },
        }
        break
      }
      case 'upsert': {
        const workspace = frame.workspace
        if (typeof workspace !== 'object' || workspace === null) continue
        const item = workspace as Record<string, unknown>
        const workspaceId = item.workspaceId
        if (typeof workspaceId !== 'string' || workspaceId === '') continue
        model.set(workspaceId, item)
        if (ownsWorkspace(item, owned)) {
          delivered.add(workspaceId)
          yield { type: 'upsert', workspace: narrowItem(item, owned) }
        } else if (delivered.has(workspaceId)) {
          // The client has already seen this workspace; it just lost
          // visibility, so resync instead of letting it linger.
          delivered.delete(workspaceId)
          yield filteredBaseline(owned)
        }
        break
      }
      case 'remove': {
        const workspaceId = frame.workspaceId
        if (typeof workspaceId !== 'string' || workspaceId === '') continue
        model.delete(workspaceId)
        if (delivered.delete(workspaceId)) yield frame
        break
      }
      case 'order': {
        order = stringList(frame.workspaceIds)
        if (delivered.size === 0) break
        let lost = false
        for (const id of delivered) {
          if (!visibleId(id, owned)) {
            lost = true
            break
          }
        }
        if (lost) {
          yield filteredBaseline(owned)
          break
        }
        const ids = order.length > 0 ? order : [...model.keys()]
        yield { type: 'order', workspaceIds: ids.filter(id => visibleId(id, owned)) }
        break
      }
      case 'archived': {
        archived = stringList(frame.archivedSessionIds)
        yield { type: 'archived', archivedSessionIds: archived.filter(sessionId => owned.has(sessionId)) }
        break
      }
      case 'pinned': {
        pinned = stringList(frame.pinnedSessionIds)
        yield { type: 'pinned', pinnedSessionIds: pinned.filter(sessionId => owned.has(sessionId)) }
        break
      }
      default:
        // Unknown frame type: drop it rather than leak an unfiltered shape.
        continue
    }
  }
}
