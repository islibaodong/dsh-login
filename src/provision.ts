/**
 * Default-workspace provisioning for non-admin users.
 *
 * Bridges the "ordinary users cannot add a workspace" gap: the frontend's
 * create-workspace flow must call the privileged `host.pickDirectory`, which
 * the multi-user proxy deliberately forbids for non-admin users (api-filter).
 * Instead of loosening that boundary, we give each non-admin user a per-user
 * default workspace on first /api access:
 *
 *   1. mkdir their sandbox directory (`workspaceRoot/<username>`)
 *   2. register it with the durable workspace registry (canonical-cwd owner)
 *   3. seed ONE attached session *through the workspaceId attachment
 *      (`sessions.create({ workspaceId })` — the same shape the GUI uses —
 *      NOT `cwd`, which produces an ungrouped cwd-only session), so the
 *      workspace carries an owned session and is immediately visible in the
 *      user's workspace.list; ownership of the returned session is recorded
 *      in the sidecar index.
 *
 * Admin users and, when the feature is disabled, no users are touched.
 * Provisioning is best-effort: failures never fail the request that
 * triggered it, and both halves are retried independently — a workspace
 * that was already created is remembered (`pending`) so a retry re-seeds the
 * session only and never registers a duplicate workspace.
 *
 * The attachment semantics mirror the harness's own workspace spec
 * (api-proxy-workspace.spec.ts): only `workspaceId` groups a session into a
 * workspace's sessionIds; `cwd` alone leaves it ungrouped.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { OwnershipIndex } from './ownership.ts'

/**
 * Minimal structural surface the provisioner needs to seed one session. The
 * old `@deepseek-ai/dsh-host-apiproxy` `ApiProxy` is gone in DSH ≥ 0.1.5-alpha.1,
 * so the caller supplies a minimal adapter (see host-session-access.ts) that
 * turns a host-side session.create into the wire result shape
 * (`{ result: { ok, value: { sessionId } } }`).
 */
export interface ProvisionSessionCreateApi {
  sessions?: {
    create(request: { rpcId: string; payload: { workspaceId?: string } }): Promise<{ result?: { ok?: boolean; value?: { sessionId?: string } } }>
  }
}

/** Result of one workspaceRegistry.create call (structural, kept minimal). */
interface WorkspaceRecord {
  id: string
  path: string
}

/** Minimal durable workspace registry surface used by provisioning. */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceRecord>
}

export interface ProvisionDeps {
  /** Root directory holding every user's sandbox (e.g. `<dshHome>/workspaces`). */
  workspaceRoot: string
  /** Accessor for the session.create adapter; re-resolved on every attempt. */
  getApi: () => ProvisionSessionCreateApi
  /** Ownership index the dsh-login fiber owns; the seeded session is attributed to it. */
  ownership: OwnershipIndex
  /** The durable workspace registry service, if it is already available. */
  workspaceRegistry?: WorkspaceRegistryLike
  /**
   * Lazy registry accessor for compositions where the durable registry is
   * not yet registered at plugin-apply time (host rows settle lazily).
   * Consulted only when `workspaceRegistry` is unset; returning undefined
   * defers provisioning to a later request without marking the user done.
   */
  getRegistry?: () => WorkspaceRegistryLike | undefined
  /**
   * Live enabled accessor (the "默认用户工作空间" toggle). When provided and
   * false, provisioning is skipped so an admin toggle takes effect without a
   * restart. When omitted, the feature is always active for the configured root.
   */
  enabled?: () => boolean
  /** Display title for the per-user workspace (falls back to the username). */
  title?: string
}

/**
 * Escape a username to a single safe path segment. Usernames must never be
 * able to climb out of the sandbox root (no separators, no `..`, no leading
 * dot), so anything unsafe is replaced rather than rejected.
 */
export function sandboxSegment(username: string): string {
  return username
    .split(/[/\\]/).join('_')   // separators never pass through
    .replace(/\.\.+/g, '_')     // path traversal neutralised
    .replace(/^\.+/, '_')       // no leading dot (hidden/dot-dot)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'user'
}

/**
 * DefaultWorkspaceProvisioner — lazily ensures each non-admin user's default
 * workspace exists exactly once per process.
 */
export class DefaultWorkspaceProvisioner {
  private readonly done = new Set<string>()
  /** Workspaces already registered but not yet seeded with a session, by username. */
  private readonly pending = new Map<string, string>()

  constructor(private readonly deps: ProvisionDeps) {}

  /**
   * Ensure `user` has a default workspace+sandbox. A no-op for admins and
   * for users already provisioned this run; skipped (without marking done)
   * while the toggle is off or no registry is resolvable yet.
   * Best-effort: any error is swallowed so the triggering request survives;
   * a partially completed provisioning (workspace created, session seed
   * failed) stays pending and retries only the missing half.
   */
  async ensure(user: { username: string; isAdmin: boolean }): Promise<void> {
    if (user.isAdmin) return
    // Live toggle: when the admin has turned provisioning off, skip. Note we
    // clear the done-set entry so re-enabling later lets the user be provisioned.
    if (this.deps.enabled !== undefined && !this.deps.enabled()) {
      this.done.delete(user.username)
      return
    }
    if (this.done.has(user.username)) return
    const registry = this.deps.workspaceRegistry ?? this.deps.getRegistry?.()
    if (registry === undefined) return
    this.done.add(user.username)
    try {
      await this.provision(user.username, registry)
    } catch {
      // Best-effort: leave the user un-provisioned for a possible retry.
      this.done.delete(user.username)
    }
  }

  private async provision(username: string, registry: WorkspaceRegistryLike): Promise<void> {
    // Half 1 — the sandbox + registered workspace. Reuse a remembered id
    // from an earlier partial attempt so a retry never double-registers.
    let workspaceId = this.pending.get(username)
    if (workspaceId === undefined) {
      const dir = join(this.deps.workspaceRoot, sandboxSegment(username))
      await mkdir(dir, { recursive: true })
      const workspace = await registry.create(dir, this.deps.title ?? username)
      workspaceId = workspace.id
      this.pending.set(username, workspaceId)
    }
    // Half 2 — seed one attached session through the workspaceId shape (the
    // GUI's own path) so it is grouped into the workspace's sessionIds and
    // ownership can be attributed to this user. The api accessor re-resolves
    // on every attempt (host rows settle lazily); a missing adapter or an
    // unusable response throws, keeping the workspace pending for a retry.
    const api = this.deps.getApi()
    const create = api?.sessions?.create
    if (create === undefined) {
      throw new Error('dsh-login: no session.create adapter available for default-workspace provisioning')
    }
    const res = await create({ rpcId: 'dsh-login-default-workspace', payload: { workspaceId } })
    if (res?.result?.ok !== true || typeof res.result.value?.sessionId !== 'string') {
      throw new Error('dsh-login: session.create returned no usable sessionId for default-workspace provisioning')
    }
    this.deps.ownership.record(res.result.value.sessionId, username)
    this.pending.delete(username)
  }
}
