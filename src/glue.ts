/**
 * Deployment-side composition glue (option B): per-user remote isolation for
 * the native `typertGateway`.
 *
 * dsh-login cannot replace the live `typertGateway` service itself — the host
 * core row provides it, and a second provide of the same key is a
 * duplicate-service error. The composition is therefore a BOOT-TIME,
 * deployment-side step: the deployment forks its `typertGateway` row (the
 * same way `cordis.patch.yml` swaps rows) and wraps the native gateway with
 * dsh-login's guard before the connection row binds it.
 *
 * This module supplies the deployable half of that composition:
 *
 * - `createDshLoginIsolation` — builds the guard's `resolveUser` / `owns`
 *   pair from dsh-login's LIVE ownership sidecar, which dsh-login publishes
 *   as the `dshLoginOwnership` service (declare it in `inject` to order the
 *   composition after dsh-login).
 * - `composeGuardedGateway` / `composeDshLoginGuard` — wrap a native gateway
 *   into a guarded one (`wrapRemoteGateway` + the isolation pair), forwarding
 *   every non-dispatch gateway member unchanged.
 *
 * See docs/compose-guard.md for a complete example row module and the
 * acceptance checklist. Fail-closed by construction: a session the sidecar
 * cannot attribute is refused — the bridge wall records every user's created
 * sessions (admins included, via record-only observation), so sessions
 * created while dsh-login runs resolve; sessions that predate the
 * composition are not attributable and must be re-created or backfilled.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRemoteIsolation, wrapRemoteGateway, type GuardUser, type OwnedPredicate, type RemoteGateway, type UserResolver, type WrappedRemoteGateway } from './remote-guard.ts'
import type { OwnershipIndex } from './ownership.ts'

/** Cordis service key under which dsh-login publishes its ownership sidecar. */
export const DSH_LOGIN_OWNERSHIP_SERVICE = 'dshLoginOwnership'

export interface DshLoginIsolationDeps {
  /** The dsh-login ownership sidecar (inject `dshLoginOwnership` for the live instance). */
  ownership: OwnershipIndex
  /**
   * Resolves the DSH agent session id that initiated the current dispatch
   * (e.g. `() => ctx.agents?.currentInitiator?.()?.id`). When omitted the
   * guard resolves exclusively through the ownership sidecar, which yields
   * undefined (deny) — a resolver is required for any non-trivial use.
   */
  currentSessionId?: () => string | undefined
  /**
   * Optional admin check by username (e.g. from a UserStore the deployment
   * holds). Sessions of admin users are also recorded in the sidecar by the
   * bridge wall, so the guard already passes them via `isAdmin` once resolved;
   * this only matters for deployments that resolve users outside the sidecar.
   */
  isAdmin?: (username: string) => boolean
}

/**
 * Build the isolation pair (resolveUser + owns) for the deployment's gateway
 * composition: current-initiator session id → ownership sidecar → username,
 * fail-closed on everything the sidecar cannot attribute.
 */
export function createDshLoginIsolation(deps: DshLoginIsolationDeps): { resolveUser: UserResolver; owns: OwnedPredicate } {
  return createRemoteIsolation({
    ownership: deps.ownership,
    currentSessionId: deps.currentSessionId ?? (() => undefined),
    isAdmin: deps.isAdmin,
  })
}

/** Wrap a native gateway with the isolation pair into a guarded gateway. */
export function composeGuardedGateway<G extends RemoteGateway>(
  gateway: G,
  isolation: { resolveUser: UserResolver; owns: OwnedPredicate },
): WrappedRemoteGateway<G> {
  return wrapRemoteGateway(gateway, isolation.resolveUser, isolation.owns)
}

/** Read dsh-login's published ownership sidecar from a context (lazy, optional). */
export function getDshLoginOwnership(ctx: Context): OwnershipIndex | undefined {
  try {
    const get = ctx.get as unknown as (this: Context, key: string) => unknown
    return get.call(ctx, DSH_LOGIN_OWNERSHIP_SERVICE) as OwnershipIndex | undefined
  } catch {
    return undefined
  }
}

/**
 * Convenience for a deployment row module: resolve the live sidecar, build
 * the isolation pair against the current agent initiator, and wrap the given
 * native gateway. Returns the gateway unchanged when dsh-login has not
 * published its sidecar (dsh-login absent or disabled) — a composition
 * without dsh-login is a single-admin deployment and needs no guard.
 */
export function composeDshLoginGuard<G extends RemoteGateway>(ctx: Context, gateway: G): WrappedRemoteGateway<G> {
  const ownership = getDshLoginOwnership(ctx)
  if (ownership === undefined) return gateway as WrappedRemoteGateway<G>
  const agents = (ctx as unknown as { agents?: { currentInitiator?: () => { id?: string } | undefined } }).agents
  const isolation = createDshLoginIsolation({
    ownership,
    currentSessionId: () => agents?.currentInitiator?.()?.id,
  })
  return composeGuardedGateway(gateway, isolation)
}

export type { GuardUser, OwnedPredicate, RemoteGateway, UserResolver, WrappedRemoteGateway }
