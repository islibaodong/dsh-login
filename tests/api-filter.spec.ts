import { describe, expect, it } from 'vitest'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createUserProxy, frameVisible, isUserAllowed, ownedSessionIds } from '../src/api-filter.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { tmpFile } from './helpers.ts'

const alice: { username: string; isAdmin: boolean } = { username: 'alice', isAdmin: false }
const root: { username: string; isAdmin: boolean } = { username: 'root', isAdmin: true }

function fakeApi(over: Partial<ApiProxy> = {}): ApiProxy {
  return {
    sessions: {
      list: async () => ({
        rpcId: RpcId('r'), result: { ok: true, value: { items: [
          { sessionId: 'own1' as never, updatedAt: 1, running: false, blank: false },
          { sessionId: 'child' as never, updatedAt: 2, running: false, blank: false, parentSessionId: 'own1' as never },
          { sessionId: 'alien' as never, updatedAt: 3, running: false, blank: false },
        ] } },
      }),
      create: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: ((r.payload as { sessionId?: string } | undefined)?.sessionId ?? 'new-1') as never } } }),
      prompt: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
    },
    subagents: {
      list: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: {
        parentAvailable: true,
        entries: [
          { kind: 'child', id: 'own1' as never, activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'a' },
          { kind: 'child', id: 'alien' as never, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
        ],
      } } }),
      history: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }),
    },
    events: {
      mux: async function* () {
        yield { rpcId: RpcId('m1'), payload: { type: 'session/subscribed', sessionId: 'own1', lastSeq: 0 } }
        yield { rpcId: RpcId('m2'), payload: { type: 'session/subscribed', sessionId: 'alien', lastSeq: 0 } }
        yield { rpcId: RpcId('m3'), payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } }
      },
      host: async function* () {},
    },
    workspace: {
      list: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
      archiveSession: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { archivedSessionIds: [(r.payload as { sessionId: string }).sessionId as never] } } }),
      insertSessionBefore: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { workspace: {} } } }),
      insertBefore: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
    },
    goals: {
      create: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { ref: { id: 'g' as never, revision: 1 } } } }),
      complete: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { ref: { id: 'g' as never, revision: 2 } } } }),
    },
    host: { describe: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { version: 'v', cwd: 'c', attachedSessions: 0, canOpenPath: false } } }) },
    llm: { providers: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: [] } }) },
    settings: {}, agentPresets: {}, skills: { list: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: [] } }) },
    downloads: {},
    respond: async () => ({ accepted: true }),
    credentials: { set: async (r: RpcRequest<never>) => { throw new Error('must not be called') } },
    ...over,
  } as unknown as ApiProxy
}

const req = (payload: unknown): RpcRequest<never> => ({ rpcId: RpcId('t'), payload }) as RpcRequest<never>

describe('createUserProxy', () => {
  it('ordinary list filters to owned + lineage children', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const res = await proxy.sessions.list(req({}))
    const ids = (res.result as { ok: true; value: { items: Array<{ sessionId: string }> } }).value.items.map(i => i.sessionId)
    expect(ids).toEqual(['own1', 'child'])
    expect(idx.lookup('child')).toBe('alice') // lineage attribution recorded
  })

  it('admin sees everything unfiltered', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), root, idx)
    const res = await proxy.sessions.list(req({}))
    const ids = (res.result as { ok: true; value: { items: Array<{ sessionId: string }> } }).value.items.map(i => i.sessionId)
    expect(ids).toEqual(['own1', 'child', 'alien'])
  })

  it('create records ownership; prompt rejects alien session', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    await proxy.sessions.create(req({}))
    expect(idx.lookup('new-1')).toBe('alice')
    const ok = await proxy.sessions.prompt(req({ sessionId: 'own1', mode: 'queue', content: [] }))
    expect(ok.result).toMatchObject({ ok: true })
    const deniedReq = req({ sessionId: 'alien', mode: 'queue', content: [] })
    const denied = await proxy.sessions.prompt(deniedReq)
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(denied.rpcId).toBe(deniedReq.rpcId) // rpcId echoed
  })

  it('goal methods guard the payload sessionId for ordinary users', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    idx.record('alien', 'bob')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const deniedCreate = await proxy.goals.create(req({ sessionId: 'alien' as never, objective: 'x' }))
    expect(deniedCreate.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    const deniedComplete = await proxy.goals.complete(req({ sessionId: 'alien' as never, ref: { id: 'g' as never, revision: 1 } }))
    expect(deniedComplete.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    const okCreate = await proxy.goals.create(req({ sessionId: 'own1' as never, objective: 'x' }))
    expect(okCreate.result).toMatchObject({ ok: true })
    const okComplete = await proxy.goals.complete(req({ sessionId: 'own1' as never, ref: { id: 'g' as never, revision: 1 } }))
    expect(okComplete.result).toMatchObject({ ok: true })
    // Admin is exempt from the goal session guard.
    const adminProxy = createUserProxy(fakeApi(), root, idx)
    const admin = await adminProxy.goals.create(req({ sessionId: 'alien' as never, objective: 'x' }))
    expect(admin.result).toMatchObject({ ok: true })
  })

  it('session.create forbids adopting another user\'s session and only records unowned results', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('alien', 'bob')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    // Alien sessionId in the payload: forbidden, ownership untouched.
    const denied = await proxy.sessions.create(req({ sessionId: 'alien' as never }))
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(idx.lookup('alien')).toBe('bob')
    // Unowned sessionId: allowed through and recorded for the caller.
    const adopt = await proxy.sessions.create(req({ sessionId: 'free-1' as never }))
    expect(adopt.result).toMatchObject({ ok: true })
    expect(idx.lookup('free-1')).toBe('alice')
    // Fresh create (no payload sessionId): current behavior, recorded.
    await proxy.sessions.create(req({}))
    expect(idx.lookup('new-1')).toBe('alice')
  })

  it('forbidden domains reject for ordinary users', async () => {
    const proxy = createUserProxy(fakeApi(), alice, new OwnershipIndex(tmpFile()))
    const res = await proxy.credentials.set(req({ ref: 'X', value: 'y' }))
    expect(res.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('mux frames filter to owned sessions; stream/error passes', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const frames: string[] = []
    for await (const f of await proxy.events.mux(req({}), new AbortController().signal)) {
      frames.push((f.payload as MuxFrame).type === 'session/subscribed'
        ? (f.payload as { sessionId: string }).sessionId
        : (f.payload as MuxFrame).type)
    }
    expect(frames).toEqual(['own1', 'stream/error'])
  })

  it('subagents.list filters to owned children; subagent history guards the child session', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const res = await proxy.subagents.list(req({ parentSessionId: 'own1' }))
    const ids = (res.result as { ok: true; value: { entries: Array<{ id: string }> } }).value.entries.map(e => e.id)
    expect(ids).toEqual(['own1'])
    const denied = await proxy.subagents.history(req({ parentSessionId: 'own1', childSessionId: 'alien', mode: 'one-shot' }))
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('workspace.archiveSession guards the session; insertSessionBefore guards every session field', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const denied = await proxy.workspace.archiveSession(req({ sessionId: 'alien' }))
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    const ok = await proxy.workspace.archiveSession(req({ sessionId: 'own1' }))
    expect(ok.result).toMatchObject({ ok: true })
    // beforeSessionId is guarded even when sessionId itself is owned.
    const anchorDenied = await proxy.workspace.insertSessionBefore(req({ workspaceId: 'w' as never, sessionId: 'own1', beforeSessionId: 'alien' as never }))
    expect(anchorDenied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    const anchorOk = await proxy.workspace.insertSessionBefore(req({ workspaceId: 'w' as never, sessionId: 'own1' }))
    expect(anchorOk.result).toMatchObject({ ok: true })
  })

  it('subagents.list rewrites parentAvailable to false for a non-owned parent', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const alien = await proxy.subagents.list(req({ parentSessionId: 'alien' as never }))
    expect((alien.result as { ok: true; value: { parentAvailable: boolean } }).value.parentAvailable).toBe(false)
    const owned = await proxy.subagents.list(req({ parentSessionId: 'own1' as never }))
    expect((owned.result as { ok: true; value: { parentAvailable: boolean } }).value.parentAvailable).toBe(true)
  })

  it('frameVisible host rules', () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const owned = new Set(['own1'])
    expect(frameVisible(alice, idx, { type: 'host/session-status', sessionId: 'own1' as never, running: true }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/session-status', sessionId: 'alien' as never, running: true }, owned)).toBe(false)
    expect(frameVisible(alice, idx, { type: 'host/remote-event', event: 'x', args: [] }, owned)).toBe(false)
    expect(frameVisible(root, idx, { type: 'host/remote-event', event: 'x', args: [] }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/workspace-changed', workspace: { workspaceId: 'w' as never, path: 'p', title: 'w', sessionIds: ['own1' as never], createdAt: '', updatedAt: '' } }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/workspace-changed', workspace: { workspaceId: 'w' as never, path: 'p', title: 'w', sessionIds: ['alien' as never], createdAt: '', updatedAt: '' } }, owned)).toBe(false)
  })
})

describe('isUserAllowed', () => {
  it('uses exact RpcMethodMap keys: allowed listings stay, privileged domains go', () => {
    expect(isUserAllowed('session.list')).toBe(true)
    expect(isUserAllowed('session.prompt')).toBe(true)
    expect(isUserAllowed('subagent.list')).toBe(true)
    expect(isUserAllowed('workspace.insertSessionBefore')).toBe(true)
    expect(isUserAllowed('goal.create')).toBe(true)
    expect(isUserAllowed('skill.list')).toBe(true)
    expect(isUserAllowed('llm.providers')).toBe(true)
    expect(isUserAllowed('host.describe')).toBe(true)
    expect(isUserAllowed('credentials.set')).toBe(false)
    expect(isUserAllowed('settings.describe')).toBe(false)
    expect(isUserAllowed('agentPreset.list')).toBe(false)
    expect(isUserAllowed('llm.discoverModels')).toBe(false)
    expect(isUserAllowed('host.pickDirectory')).toBe(false)
    // Wrong spellings must not sneak through (sessions.list does not exist).
    expect(isUserAllowed('sessions.list')).toBe(false)
    expect(isUserAllowed('session.export')).toBe(false)
  })
})
