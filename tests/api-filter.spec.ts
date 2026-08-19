import { describe, expect, it } from 'vitest'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createUserProxy, frameVisible, ownedSessionIds } from '../src/api-filter.ts'
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
      create: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'new-1' as never } } }),
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
    },
    goals: {
      create: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { ref: { id: 'g' as never, revision: 1 } } } }),
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
