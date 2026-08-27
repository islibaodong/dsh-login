import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { DefaultWorkspaceProvisioner, sandboxSegment, type WorkspaceRegistryLike } from '../src/provision.ts'
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

function fakeApi(): { api: ApiProxy; attachRequests: Array<Record<string, unknown>> } {
  const attachRequests: Array<Record<string, unknown>> = []
  return {
    attachRequests,
    // Simulate only the session.create surface createUserProxy-free provisioning touches.
    api: {
      sessions: {
        create: async (r: { payload?: Record<string, unknown> }) => {
          attachRequests.push(r?.payload ?? {})
          return { rpcId: r?.rpcId, result: { ok: true, value: { sessionId: 'prov-s1' } } }
        },
      },
    } as unknown as ApiProxy,
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

  it('is a no-op when the workspace registry service is absent', async () => {
    const root = testRoot()
    const { api, attachRequests } = fakeApi()
    const ownership = new OwnershipIndex(join(root, 'ownership.json'))
    const p = new DefaultWorkspaceProvisioner({ workspaceRoot: root, getApi: () => api, ownership })

    await p.ensure(alice)
    expect(attachRequests).toHaveLength(0)
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
})