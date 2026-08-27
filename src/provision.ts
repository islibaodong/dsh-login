/**
 * Default-workspace provisioning for non-admin users.
 *
 * Bridges the "ordinary users cannot add a workspace" gap: the frontend's
 * create-workspace flow must call the privileged `host.pickDirectory`, which
 * the multi-user proxy deliberately forbids for non-admin users (api-filter).
 * Instead of loosening that security boundary, we give each non-admin user a
 * per-user default workspace on first /api access:
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
 * Provisioning is best-effort and idempotent (once per user per process):
 * failures never fail the request that triggered it.
 *
 * The attachment semantics mirror the harness's own workspace spec
 * (api-proxy-workspace.spec.ts): only `workspaceId` groups a session into a
 * workspace's sessionIds; `cwd` alone leaves it ungrouped.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { OwnershipIndex } from './ownership.ts'

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
  /** Accessor for the real (unwrapped) API; provisioning calls session.create on it. */
  getApi: () => ApiProxy
  /** Ownership index the dsh-login fiber owns; the seeded session is attributed to it. */
  ownership: OwnershipIndex
  /** The durable workspace registry service (optional; provisioning skips without it). */
  workspaceRegistry?: WorkspaceRegistryLike
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

  constructor(private readonly deps: ProvisionDeps) {}

  /**
   * Ensure `user` has a default workspace+sandbox. A no-op for admins, for
   * users already provisioned this run, or when the registry is absent.
   * Best-effort: any error is swallowed so the triggering request survives.
   */
  async ensure(user: { username: string; isAdmin: boolean }): Promise<void> {
    if (user.isAdmin) return
    if (this.done.has(user.username)) return
    const registry = this.deps.workspaceRegistry
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
    const dir = join(this.deps.workspaceRoot, sandboxSegment(username))
    await mkdir(dir, { recursive: true })
    const workspace = await registry.create(dir, this.deps.title ?? username)
    // Attach one session to the workspace via the workspaceId shape (the GUI's
    // own path) so it is grouped into the workspace's sessionIds and the
    // workspace shows up in this user's workspace.list. The real api sits on
    // ctx.apiProxy and dispatches session.create exactly as the wire handler
    // does (fetch/handler.ts: 'session.create' -> api.sessions.create).
    const api = this.deps.getApi()
    if (api === undefined) return
    const create = api.sessions?.create
    if (create === undefined) return
    const request = {
      rpcId: 'dsh-login-default-workspace',
      payload: { workspaceId: workspace.id },
    } as unknown as RpcRequest<never>
    const res = (await create(request)) as { result?: { ok?: boolean; value?: { sessionId?: string } } }
    if (res?.result?.ok === true && typeof res.result.value?.sessionId === 'string') {
      this.deps.ownership.record(res.result.value.sessionId, username)
    }
  }
}