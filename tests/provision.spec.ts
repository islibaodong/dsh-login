import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultWorkspaceProvisioner, sandboxSegment, type ProvisionSessionCreateApi, type WorkspaceRegistryLike } from '../src/provision.ts'
import { OwnershipIndex } from '../src/ownership.ts'

function testRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-login-provision-')), 'ws')
}

function fakeRegistry(): { registry: WorkspaceRegistryLike; created: Array<{ id: string; path: string }> } {
  const created: Array<{ id: string; path: string }> = []
  return {
    created,
    registry: {
      create: async (path: string) => {
        const w = { id: `ws-${created.length + 1}`, path }
        created.push(w)
        return w
      },
    },
  }
}

function fakeApi(): { api: ProvisionSessionCreateApi; attachRequests: Array<Record<string, unknown>> } {
  const attachRequests: Array<Record<string, unknown>> = []
  return {
    attachRequests,
    // The minimal session.create adapter the host-session-access shim builds.
    api: {
      sessions: {
        create: async (r: { payload?: Record<string, unknown> }) => {
          attachRequests.push(r?.payload ?? {})
          return { rpcId: r?.rpcId, result: { ok: true, value: { sessionId: 'prov-s1' } } }
        },
      },
    },
  }
}

const alice = { username: 'alice', isAdmin: false }
const admin = { username: 'root', isAdmin: true }

describe('sandboxSegment', () => {
  it('flattens separators, dot-dot and leading dots to safe segments', () => {
    expect(sandboxSegment('alice')).toBe('alice')
    expect(sandboxSegment('a/b')).toBe('a_b')
    expect(sandboxSegment('..')).toBe('user')
    expect(sandboxSegment('../../etc')).toBe('etc')
    expect(sandboxSegment('.hidden')).toBe('hidden')
    expect(sandboxSegment('a b@c!')).toBe('a_b_c')
  })
})

describe('DefaultWorkspaceProvisioner', () => {
  it('creates the sandbox dir + workspace and attaches+owns an on-workspace session', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(alice)

    expect(created).toHaveLength(1)
    const dir = join(root, 'alice')
    expect(created[0]!.path).toBe(dir)
    // The seeded session attaches via workspaceId (the grouping path), not cwd.
    expect(attachRequests).toEqual([{ workspaceId: 'ws-1' }])
    // Ownership attributed to the returned session.
    expect(ownership.lookup('prov-s1')).toBe('alice')
  })

  it('is idempotent: a second ensure does not double-provision', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(alice)
    await p.ensure(alice)

    expect(created).toHaveLength(1)
    expect(attachRequests).toHaveLength(1)
  })

  it('skips admin users entirely', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(admin)
    await p.ensure(alice)

    expect(created).toHaveLength(1)
    expect(attachRequests).toHaveLength(1)
  })

  it('is a no-op when neither workspaceRegistry nor getRegistry yields a registry', async () => {
    const root = testRoot()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership })

    await p.ensure(alice)
    expect(attachRequests).toHaveLength(0)
  })

  it('resolves the registry lazily via getRegistry and defers while it is unavailable', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    let lazy: WorkspaceRegistryLike | undefined
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, getRegistry: () => lazy })

    // Host rows settle lazily: the first request defers without arming done.
    await p.ensure(alice)
    expect(created).toHaveLength(0)
    expect(attachRequests).toHaveLength(0)

    // Registry appears; the same user is provisioned on the next request.
    lazy = registry
    await p.ensure(alice)
    expect(created).toHaveLength(1)
    expect(attachRequests).toHaveLength(1)
  })

  it('swallows provisioning errors so the triggering request survives, and retries', async () => {
    const root = testRoot()
    const { api } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const fail = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const registry = { create: fail as unknown as WorkspaceRegistryLike['create'] }
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(alice)
    expect(fail).toHaveBeenCalledTimes(1)
    // On failure the user is re-armed: a retry attempts again.
    await p.ensure(alice)
    expect(fail).toHaveBeenCalledTimes(2)
  })

  it('retries only the failed session-seed half without re-registering the workspace', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const attachRequests: Array<Record<string, unknown>> = []
    let failFirst = true
    const api: ProvisionSessionCreateApi = {
      sessions: {
        create: async (r: { payload?: Record<string, unknown> }) => {
          attachRequests.push(r?.payload ?? {})
          if (failFirst) {
            failFirst = false
            throw new Error('session seed failed')
          }
          return { result: { ok: true, value: { sessionId: 'prov-s1' } } }
        },
      },
    }
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(alice)
    // The workspace half succeeded; the session seed threw (getApi re-resolved
    // and its adapter threw) — the user stays un-provisioned.
    expect(created).toHaveLength(1)
    expect(ownership.lookup('prov-s1')).toBeUndefined()

    await p.ensure(alice)
    // Retry: the remembered workspace id is reused (no second registry.create),
    // only the session is seeded again, and ownership lands.
    expect(created).toHaveLength(1)
    expect(attachRequests).toEqual([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-1' }])
    expect(ownership.lookup('prov-s1')).toBe('alice')
  })

  it('keeps retrying when session.create returns an unusable shape', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const attachRequests: Array<Record<string, unknown>> = []
    let ok = false
    const api: ProvisionSessionCreateApi = {
      sessions: {
        create: async (r: { payload?: Record<string, unknown> }) => {
          attachRequests.push(r?.payload ?? {})
          return ok ? { result: { ok: true, value: { sessionId: 'prov-s1' } } } : { result: { ok: true, value: {} } }
        },
      },
    }
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry })

    await p.ensure(alice)
    expect(created).toHaveLength(1)
    expect(ownership.lookup('prov-s1')).toBeUndefined()

    ok = true
    await p.ensure(alice)
    expect(ownership.lookup('prov-s1')).toBe('alice')
    // Both attempts attached to the SAME workspace id — no duplicate workspace.
    expect(attachRequests.every((r) => r.workspaceId === 'ws-1')).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('skips provisioning while the live toggle is off, then provisions after re-enabling', async () => {
    const root = testRoot()
    const { registry, created } = fakeRegistry()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    let enabled = false
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership, workspaceRegistry: registry, enabled: () => enabled })

    await p.ensure(alice)
    expect(created).toHaveLength(0)
    expect(attachRequests).toHaveLength(0)

    // Re-enable: the same user is now provisioned (once).
    enabled = true
    await p.ensure(alice)
    expect(created).toHaveLength(1)
    expect(attachRequests).toHaveLength(1)

    // Stayed on: not double-provisioned.
    await p.ensure(alice)
    expect(created).toHaveLength(1)
  })
})
