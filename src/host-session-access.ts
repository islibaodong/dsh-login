/**
 * Host-side access to the session surface (DSH ≥ 0.1.5-alpha.1, option A).
 *
 * The per-user ApiProxy of the old takeover is gone, so dsh-login's
 * provisioner and list-probe reach the session controller through the two
 * remaining host paths, in order of preference:
 *
 * 1. `sessionController` — the host service backing the generated
 *    `ctx.remote.session` namespace. A direct host-side call is plain method
 *    invocation: it does NOT ride `typertGateway`, so it stays transparent to
 *    a composed remote guard (the guard wraps the gateway's dispatch, not the
 *    controller services) and keeps working in compositions where the native
 *    `typertGateway` row has been wrapped by the deployment glue.
 * 2. `typertGateway.invoke({ namespace, method, args })` — the same dispatch
 *    the wire bridge uses. Under a composed guard this path is subject to the
 *    guard's fail-closed resolution and may be refused; it exists for
 *    compositions that do not expose the controller service.
 *
 * All lookups are lazy and structural: a missing service or an unrecognized
 * return shape degrades to a thrown error (provisioning retries) or an empty
 * probe (list filtering degrades to the sidecar alone) — never a crash.
 */
import type { Context } from '@deepseek-ai/cordis'
import { envelopeValue } from './bridge-list-filter.ts'
import type { ProvisionSessionCreateApi } from './provision.ts'
import type { SessionListSource } from './bridge-list-filter.ts'

/**
 * Resolve a service by key without failing the caller when the service is
 * absent (or its provider throws on an untyped lookup). Returns undefined in
 * both cases.
 */
export function tryGetService<T>(ctx: Context, key: string): T | undefined {
  try {
    const get = ctx.get as unknown as (this: Context, key: string) => unknown
    return get.call(ctx, key) as T | undefined
  } catch {
    return undefined
  }
}

/** Structural surface of the host `sessionController` service the adapters use. */
interface SessionControllerLike {
  create?(request: unknown): Promise<unknown>
  list?(request: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Structural surface of the native/composed `typertGateway` dispatch. */
interface RemoteGatewayLike {
  invoke?(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown>
}

/**
 * Pull the created `sessionId` out of every observed return convention:
 * the bare controller value (`{ sessionId }`), the gateway result envelope
 * (`{ ok, value: { sessionId } }`), or the full wire envelope
 * (`{ result: { ok, value: { sessionId } } }`).
 */
export function extractSessionId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const direct = (value as { sessionId?: unknown }).sessionId
  if (typeof direct === 'string' && direct !== '') return direct
  for (const level of [(value as { value?: unknown }).value, envelopeValue(value)]) {
    if (typeof level !== 'object' || level === null) continue
    const sessionId = (level as { sessionId?: unknown }).sessionId
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  }
  return undefined
}

/** Create the session through whichever host path is available. */
async function createSessionValue(ctx: Context, payload: { workspaceId?: string }): Promise<unknown> {
  const controller = tryGetService<SessionControllerLike>(ctx, 'sessionController')
  if (typeof controller?.create === 'function') {
    return controller.create(payload)
  }
  const gateway = tryGetService<RemoteGatewayLike>(ctx, 'typertGateway')
  if (typeof gateway?.invoke === 'function') {
    return gateway.invoke({ namespace: 'session', method: 'create', args: payload })
  }
  throw new Error('dsh-login: neither sessionController nor typertGateway is available for session.create')
}

/**
 * Build the provisioner's `getApi` accessor: a lazy adapter that turns a
 * host-side session.create into the `ProvisionSessionCreateApi` shape
 * (`{ result: { ok, value: { sessionId } } }`). Errors propagate so the
 * provisioner's retry semantics apply (failures never fail the triggering
 * request, and the workspace id is remembered across retries).
 */
export function createHostSessionApi(ctx: Context): () => ProvisionSessionCreateApi {
  return () => ({
    sessions: {
      create: async (request) => {
        const value = await createSessionValue(ctx, request.payload)
        const sessionId = extractSessionId(value)
        if (sessionId === undefined) {
          throw new Error('dsh-login: session.create returned no sessionId')
        }
        return { result: { ok: true, value: { sessionId } } }
      },
    },
  })
}

/**
 * Build the list-probe's gateway source: a lazy `SessionListSource` backed by
 * the host session controller (direct call, guard-transparent) with the
 * typertGateway dispatch as fallback. Throwing here is fine —
 * `probeOwnedSessionIds` treats a failed probe as "sidecar entries only".
 */
export function createHostSessionSource(ctx: Context): SessionListSource {
  return {
    async invoke() {
      const controller = tryGetService<SessionControllerLike>(ctx, 'sessionController')
      if (typeof controller?.list === 'function') {
        return controller.list({}, new AbortController().signal)
      }
      const gateway = tryGetService<RemoteGatewayLike>(ctx, 'typertGateway')
      if (typeof gateway?.invoke === 'function') {
        return gateway.invoke({ namespace: 'session', method: 'list', args: {} })
      }
      throw new Error('dsh-login: neither sessionController nor typertGateway is available for session.list')
    },
  }
}
