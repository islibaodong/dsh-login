/**
 * Wire-response observation for the /api bridge wall (option A).
 *
 * Under DSH ≥ 0.1.5-alpha.1 the native `connection` row owns the /api carrier
 * and the old per-user `createUserProxy` decorator (f2383ca, against the removed
 * `@deepseek-ai/dsh-host-apiproxy` `ApiProxy`) is gone with that package. This
 * module restores its two data-plane behaviors at the bridge wall, where the
 * waterfall listener sees the whole unary JSON exchange:
 *
 * - ownership attribution: a `session.create` / `session.fork` /
 *   `workspace.create` response carries the created id — record it into the
 *   ownership sidecar so the composed Remote guard recognizes the resource as
 *   the caller's own;
 * - list filtering: `session.list` / `session.search` / `workspace.list`
 *   responses are narrowed to the caller's owned sessions, exactly like the
 *   old proxy did (direct index entries + lineage closure; workspaces keep
 *   only owned `sessionIds` and drop out when none remain).
 *
 * All shapes are structural and verified before use: an unrecognized payload
 * passes through untouched (filtering must never corrupt a response), and the
 * hard boundary remains the wall's method allow-list — filtering is
 * defense-in-depth on top of it.
 */
import type { OwnershipIndex } from './ownership.ts'

/** The slice of the live `typertGateway` the probe needs. */
export interface SessionListSource {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown>
}

/** The session-header subset the wire session.list/search values carry. */
export interface WireSessionHeader {
  sessionId: string
  parentSessionId?: string
}

/**
 * Extract the session headers from a full session.list value. Accepts the
 * bare controller value (`{ items: [...] }`) or a full `{ result: { ok, value } }`
 * envelope (some gateway rows return the RPC envelope). Returns undefined when
 * the shape does not match — callers treat that as "cannot enumerate".
 */
export function extractSessionItems(value: unknown): WireSessionHeader[] | undefined {
  const items = envelopeValue(value)
  if (items === undefined) return undefined
  const record = items as { items?: unknown }
  if (!Array.isArray(record.items)) return undefined
  const headers: WireSessionHeader[] = []
  for (const item of record.items) {
    if (typeof item !== 'object' || item === null) return undefined
    const sessionId = (item as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const parentSessionId = (item as { parentSessionId?: unknown }).parentSessionId
    headers.push(
      typeof parentSessionId === 'string' && parentSessionId !== ''
        ? { sessionId, parentSessionId }
        : { sessionId },
    )
  }
  return headers
}

/**
 * Unwrap `{ result: { ok: true, value } }` (wire envelope) and return `value`;
 * anything else (including a bare value without a result wrapper) passes back.
 * A failed envelope result (`ok: false`) yields undefined.
 */
export function envelopeValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const result = (value as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return value // bare controller value
  const record = result as { ok?: unknown; value?: unknown }
  return record.ok === true ? record.value : undefined
}

/**
 * Owned-session closure: the sidecar's direct entries for `username` plus the
 * lineage closure over a full session list snapshot (a child of an owned
 * session is owned — subagents/forks). Newly attributed children are recorded
 * back into the sidecar, keeping it warm for the composed Remote guard (the
 * old `ownedSessionIds` behavior).
 */
export function ownedSessionClosure(
  username: string,
  items: readonly WireSessionHeader[],
  ownership: OwnershipIndex,
): Set<string> {
  const owned = new Set<string>()
  for (const [sid, owner] of ownership.entries()) {
    if (owner === username) owned.add(sid)
  }
  const byParent = new Map<string, string[]>()
  for (const item of items) {
    if (item.parentSessionId === undefined) continue
    const list = byParent.get(item.parentSessionId)
    if (list === undefined) byParent.set(item.parentSessionId, [item.sessionId])
    else list.push(item.sessionId)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const sid of [...owned]) {
      for (const child of byParent.get(sid) ?? []) {
        if (!owned.has(child)) {
          owned.add(child)
          ownership.record(child, username)
          grew = true
        }
      }
    }
  }
  return owned
}

/**
 * Probe the caller's owned-session set through the live gateway's full
 * `session.list`. Best-effort: without a gateway, or when the probe fails or
 * returns an unrecognized shape, the sidecar's direct entries answer alone
 * (never `undefined` — filtering degrades, it does not open up).
 */
export async function probeOwnedSessionIds(
  username: string,
  ownership: OwnershipIndex,
  gateway: SessionListSource | undefined,
): Promise<Set<string>> {
  let items: WireSessionHeader[] = []
  if (gateway !== undefined) {
    try {
      const value = await gateway.invoke({ namespace: 'session', method: 'list', args: {} })
      const extracted = extractSessionItems(value)
      if (extracted !== undefined) items = extracted
    } catch { /* probe is best-effort; the sidecar still answers */ }
  }
  return ownedSessionClosure(username, items, ownership)
}

/**
 * Filter a session.list / session.search wire response value down to the
 * owned sessions. Returns the rewritten value, or undefined when the shape is
 * unrecognized (the caller then passes the original body through untouched).
 */
export function filterSessionItemsValue(value: unknown, owned: ReadonlySet<string>): unknown | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = envelopeValue(value)
  if (payload === undefined) return undefined
  const record = payload as { items?: unknown }
  if (!Array.isArray(record.items)) return undefined
  const items: unknown[] = []
  for (const item of record.items) {
    if (typeof item !== 'object' || item === null) return undefined
    const sessionId = (item as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (owned.has(sessionId)) items.push(item)
  }
  const filtered = { ...payload, items }
  if ((value as { result?: unknown }).result !== undefined) {
    return { ...value, result: { ok: true, value: filtered } }
  }
  return filtered
}

/**
 * Filter a workspace.list wire response value like the old per-user proxy:
 * each workspace keeps only its owned `sessionIds`, a workspace holding none
 * of the caller's sessions drops out entirely, and `archivedSessionIds` is
 * narrowed the same way. Returns undefined on an unrecognized shape.
 */
export function filterWorkspaceListValue(value: unknown, owned: ReadonlySet<string>): unknown | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = envelopeValue(value)
  if (payload === undefined) return undefined
  const record = payload as { items?: unknown; archivedSessionIds?: unknown }
  if (!Array.isArray(record.items) || !Array.isArray(record.archivedSessionIds)) return undefined
  const items: unknown[] = []
  for (const workspace of record.items) {
    if (typeof workspace !== 'object' || workspace === null) return undefined
    const sessionIds = (workspace as { sessionIds?: unknown }).sessionIds
    if (!Array.isArray(sessionIds)) return undefined
    const kept = sessionIds.filter((id): id is string => typeof id === 'string' && owned.has(id))
    if (kept.length > 0) items.push({ ...(workspace as Record<string, unknown>), sessionIds: kept })
  }
  const archivedSessionIds = record.archivedSessionIds.filter(
    (id): id is string => typeof id === 'string' && owned.has(id),
  )
  const filtered = { ...payload, items, archivedSessionIds }
  if ((value as { result?: unknown }).result !== undefined) {
    return { ...value, result: { ok: true, value: filtered } }
  }
  return filtered
}

/** Wire methods whose successful responses create a resource worth attributing. */
export const RECORD_METHODS: ReadonlySet<string> = new Set(['session.create', 'session.fork', 'workspace.create'])

/** Wire methods whose responses are narrowed to the caller's owned sessions. */
export const FILTER_METHODS: ReadonlySet<string> = new Set(['session.list', 'session.search', 'workspace.list'])

/**
 * Attribute a created resource: pull the `sessionId` (session.create/fork) or
 * `id` (workspace.create) out of a wire response envelope and record it. No-op
 * (never throws) on anything else.
 */
export function recordOwnershipFromResponse(
  envelope: unknown,
  username: string,
  ownership: OwnershipIndex,
): void {
  const payload = envelopeValue(envelope)
  if (typeof payload !== 'object' || payload === null) return
  const sessionId = (payload as { sessionId?: unknown }).sessionId
  const id = (payload as { id?: unknown }).id
  if (typeof sessionId === 'string' && sessionId !== '') {
    ownership.record(sessionId, username)
    return
  }
  if (typeof id === 'string' && id !== '') ownership.record(id, username)
}
