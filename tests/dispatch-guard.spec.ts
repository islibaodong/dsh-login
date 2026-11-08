import { describe, expect, it } from 'vitest'
import { installAdmitShadow, installDispatchShadows, filterWorkspaceFollowFrames, peerUser, deniedRpc } from '../src/dispatch-guard.ts'
import { collectIds } from '../src/remote-guard.ts'
import { SessionStore } from '../src/session.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { buildCookieHeader } from '../src/auth.ts'
import { tmpFile } from './helpers.ts'
import type { IncomingMessage } from 'node:http'

function fakeRequest(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as unknown as IncomingMessage
}

interface Harness {
  store: SessionStore
  ownership: OwnershipIndex
  browserPeer: { id: string; principal: { kind: string }; interactions: string; signal: AbortSignal }
  apiPeer: { id: string; principal: { kind: string }; interactions: string; signal: AbortSignal }
  admit: (request: IncomingMessage) => { peer?: unknown; rejection?: number }
  gateway: {
    dispatchRpc: (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<unknown>
    openWireStream: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: unknown, signal: AbortSignal, control: unknown, window: unknown) => Promise<unknown>
  }
  uninstalls: Array<() => void>
}

function harness(sessionSource?: () => undefined): Harness {
  const store = new SessionStore(3600)
  const ownership = new OwnershipIndex(tmpFile())
  const browserPeer = { id: 'browser-peer', principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }
  const apiPeer = { id: 'api-peer', principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal }
  const connection = {
    browserPeer,
    admit(request: IncomingMessage): { peer?: unknown; rejection?: number } {
      // Mirrors the upstream admit(): a v1 browser cookie → the shared peer,
      // a v2 API credential → the per-connection peer, anything else → 401.
      const cookie = request.headers.cookie
      if (cookie === undefined) return { rejection: 401 }
      if (cookie.includes('dsh-auth-v2=')) return { peer: apiPeer }
      if (cookie.startsWith('dsh-auth-')) return { peer: browserPeer }
      return { rejection: 401 }
    },
  }
  const dispatchCalls: Array<{ endpoint: string; payload: unknown }> = []
  const streamCalls: Array<{ endpoint: string; payload: unknown }> = []
  const gateway = {
    dispatchRpc: async (endpoint: string, payload: unknown) => {
      dispatchCalls.push({ endpoint, payload })
      return { ok: true, value: null }
    },
    openWireStream: async (endpoint: string, payload: unknown) => {
      streamCalls.push({ endpoint, payload })
      return async function* stream(): AsyncGenerator<unknown> {
        yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
      }()
    },
  }
  const warns: string[] = []
  const deps = { store, ownership, sessionSource: sessionSource ?? (() => undefined) }
  const warn = (message: string): void => { warns.push(message) }
  const uninstalls = [
    installAdmitShadow(connection as never, deps, warn),
    installDispatchShadows(gateway as never, deps, warn),
  ]
  const h = {
    store,
    ownership,
    browserPeer,
    apiPeer,
    admit: (request: IncomingMessage) => connection.admit(request),
    gateway: {
      dispatchRpc: gateway.dispatchRpc.bind(gateway),
      openWireStream: gateway.openWireStream.bind(gateway),
    },
    uninstalls,
  } as Harness
  ;(h as Harness & { dispatchCalls: unknown[]; streamCalls: unknown[]; warns: string[] }).dispatchCalls = dispatchCalls
  ;(h as Harness & { dispatchCalls: unknown[]; streamCalls: unknown[]; warns: string[] }).streamCalls = streamCalls
  ;(h as Harness & { dispatchCalls: unknown[]; streamCalls: unknown[]; warns: string[] }).warns = warns
  return h
}

function calls(h: Harness): { dispatchCalls: Array<{ endpoint: string; payload: unknown }>; streamCalls: Array<{ endpoint: string; payload: unknown }>; warns: string[] } {
  return h as unknown as { dispatchCalls: Array<{ endpoint: string; payload: unknown }>; streamCalls: Array<{ endpoint: string; payload: unknown }>; warns: string[] }
}

describe('admit shadow (issue #11)', () => {
  const coreV1 = 'dsh-auth-v1=valid'

  it('tags the browser peer with the dsh-login user and reuses the wrapper per session', () => {
    const h = harness()
    const { token } = h.store.create('alice', false)
    const first = h.admit(fakeRequest(`${coreV1}; ${buildCookieHeader(token, 3600)}`))
    expect(first.rejection).toBeUndefined()
    expect(peerUser(first.peer)).toEqual({ username: 'alice', isAdmin: false })
    const second = h.admit(fakeRequest(`${coreV1}; ${buildCookieHeader(token, 3600)}`))
    expect(second.peer).toBe(first.peer)
    expect((first.peer as { id: string }).id).toBe(h.browserPeer.id)
  })

  it('rejects browser-path admissions without a live dsh-login session (upgrade-wall gap)', () => {
    const h = harness()
    for (const cookie of [undefined, 'other=1', 'dsh_session=deadbeef', `${coreV1}; dsh_session=deadbeef`]) {
      const admission = h.admit(fakeRequest(cookie))
      expect(admission.rejection).toBe(401)
      expect(admission.peer).toBeUndefined()
    }
  })

  it('wraps an api-credential peer only when a dsh-login session rides along', () => {
    const h = harness()
    const { token } = h.store.create('bob', false)
    const without = h.admit(fakeRequest('dsh-auth-v2=credential'))
    expect(without.peer).toBe(h.apiPeer)
    expect(peerUser(without.peer)).toBeUndefined()
    const withSession = h.admit(fakeRequest(`dsh-auth-v2=credential; ${buildCookieHeader(token, 3600)}`))
    expect(withSession.peer).not.toBe(h.apiPeer)
    expect(peerUser(withSession.peer)).toEqual({ username: 'bob', isAdmin: false })
  })

  it('treats an expired session as unauthenticated on the browser path', () => {
    const h = harness()
    const { token } = new SessionStore(-1).create('alice', false)
    const admission = h.admit(fakeRequest(`${coreV1}; ${buildCookieHeader(token, 3600)}`))
    expect(admission.rejection).toBe(401)
  })

  it('uninstall restores the original admit', () => {
    const h = harness()
    h.uninstalls[0]!()
    expect((h.admit(fakeRequest(`${coreV1}; ${buildCookieHeader(h.store.create('alice', false).token, 3600)}`))).peer).toBe(h.browserPeer)
  })
})

describe('dispatch shadows (issue #11)', () => {
  const coreV1 = 'dsh-auth-v1=valid'
  const tagAs = (h: Harness, user: string, isAdmin: boolean): unknown => {
    const { token } = h.store.create(user, isAdmin)
    return h.admit(fakeRequest(`${coreV1}; ${buildCookieHeader(token, 3600)}`)).peer
  }

  it('passes untagged peers through untouched (CLI/SDK, owner)', async () => {
    const h = harness()
    await h.gateway.dispatchRpc('credentials/list', { args: {} }, new AbortController().signal, h.apiPeer)
    await h.gateway.openWireStream('workspace/follow', { args: {} }, undefined as never, h.apiPeer, new AbortController().signal, {}, {})
    expect(calls(h).dispatchCalls).toHaveLength(1)
    expect(calls(h).streamCalls).toHaveLength(1)
  })

  it('passes admins unconditionally', async () => {
    const h = harness()
    const peer = tagAs(h, 'root', true)
    await h.gateway.dispatchRpc('credentials/list', { args: {} }, new AbortController().signal, peer)
    await h.gateway.openWireStream('credentials/list', { args: {} }, undefined as never, peer, new AbortController().signal, {}, {})
    expect(calls(h).dispatchCalls).toHaveLength(1)
    expect(calls(h).streamCalls).toHaveLength(1)
  })

  it('denies admin-only methods for tagged non-admins with the wall envelope', async () => {
    const h = harness()
    const peer = tagAs(h, 'alice', false)
    const result = await h.gateway.dispatchRpc('credentials/list', { args: {} }, new AbortController().signal, peer)
    expect(result).toEqual(deniedRpc())
    expect(calls(h).dispatchCalls).toHaveLength(0)
  })

  it('denies unknown wire methods for tagged non-admins (fail closed) and warns once', async () => {
    const h = harness()
    const peer = tagAs(h, 'alice', false)
    await h.gateway.dispatchRpc('session/futureMethod', { args: {} }, new AbortController().signal, peer)
    await h.gateway.dispatchRpc('session/futureMethod', { args: {} }, new AbortController().signal, peer)
    expect(calls(h).dispatchCalls).toHaveLength(0)
    expect(calls(h).warns).toHaveLength(1)
  })

  it('lets the $events endpoints through for tagged users (UI event stream)', async () => {
    const h = harness()
    const peer = tagAs(h, 'alice', false)
    await h.gateway.openWireStream('$events', { args: {} }, undefined as never, peer, new AbortController().signal, {}, {})
    await h.gateway.dispatchRpc('$events/result', { args: {} }, new AbortController().signal, peer)
    expect(calls(h).streamCalls).toHaveLength(1)
    expect(calls(h).dispatchCalls).toHaveLength(1)
  })

  it('denies id-carrying calls for sessions the user does not own', async () => {
    const h = harness()
    h.ownership.record('victim-session', 'root')
    const peer = tagAs(h, 'alice', false)
    const result = await h.gateway.dispatchRpc('session/page', { args: { sessionId: 'victim-session' } }, new AbortController().signal, peer)
    expect(result).toEqual(deniedRpc())
    expect(calls(h).dispatchCalls).toHaveLength(0)
  })

  it('allows id-carrying calls the user owns', async () => {
    const h = harness()
    h.ownership.record('alice-session', 'alice')
    const peer = tagAs(h, 'alice', false)
    const result = await h.gateway.dispatchRpc('session/page', { args: { sessionId: 'alice-session' } }, new AbortController().signal, peer)
    expect(result).toEqual({ ok: true, value: null })
    expect(calls(h).dispatchCalls).toHaveLength(1)
  })

  it('throws a forbidden stream error on denied stream opens', async () => {
    const h = harness()
    const peer = tagAs(h, 'alice', false)
    await expect(h.gateway.openWireStream('credentials/list', { args: {} }, undefined as never, peer, new AbortController().signal, {}, {}))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(calls(h).streamCalls).toHaveLength(0)
  })
})

describe('workspace.follow stream filtering (issue #11)', () => {
  type Frame = Record<string, unknown>

  async function collect(gen: AsyncIterable<unknown>): Promise<Frame[]> {
    const frames: Frame[] = []
    for await (const frame of gen) frames.push(frame as Frame)
    return frames
  }

  const workspace = (workspaceId: string, sessionIds: string[], title = workspaceId): Frame => ({
    workspaceId,
    path: `E:/host/${workspaceId}`,
    title,
    sessionIds,
    createdAt: 0,
    updatedAt: 0,
  })

  const baseline = (items: Frame[]): Frame => ({
    type: 'baseline',
    value: { items, archivedSessionIds: [], pinnedSessionIds: [] },
  })

  it('narrows the baseline to the user’s workspaces and owned sessions', async () => {
    const ownership = new OwnershipIndex(tmpFile())
    ownership.record('ws-alice', 'alice')
    ownership.record('s-alice-1', 'alice')
    ownership.record('s-alice-2', 'alice')
    const deps = { store: new SessionStore(3600), ownership, sessionSource: () => undefined }
    const source = (async function* (): AsyncGenerator<Frame> {
      yield baseline([workspace('ws-alice', ['s-alice-1']), workspace('ws-root', ['s-root-1']), workspace('ws-shared', ['s-alice-2', 's-root-2'])])
    })()
    const frames = await collect(filterWorkspaceFollowFrames(source, deps, { username: 'alice', isAdmin: false }))
    expect(frames).toHaveLength(1)
    const value = frames[0]!.value as { items: Array<{ workspaceId: string; sessionIds: string[] }> }
    expect(value.items.map(item => item.workspaceId)).toEqual(['ws-alice', 'ws-shared'])
    expect(value.items[1]!.sessionIds).toEqual(['s-alice-2'])
  })

  it('drops foreign upserts and delivers a replace resync when a delivered workspace loses visibility', async () => {
    const ownership = new OwnershipIndex(tmpFile())
    ownership.record('ws-alice', 'alice')
    ownership.record('s-alice', 'alice')
    ownership.record('s-alice-2', 'alice')
    const deps = { store: new SessionStore(3600), ownership, sessionSource: () => undefined }
    const source = (async function* (): AsyncGenerator<Frame> {
      yield baseline([workspace('ws-alice', ['s-alice']), workspace('ws-shared', ['s-alice', 's-root'])])
      // Foreign workspace upsert: silently dropped.
      yield { type: 'upsert', workspace: workspace('ws-root', ['s-root']) }
      // ws-shared loses the last owned session → visibility is gone → replace resync.
      yield { type: 'upsert', workspace: workspace('ws-shared', ['s-root']) }
      // Owned workspace upsert: forwarded narrowed.
      yield { type: 'upsert', workspace: workspace('ws-alice', ['s-alice', 's-alice-2']) }
    })()
    const frames = await collect(filterWorkspaceFollowFrames(source, deps, { username: 'alice', isAdmin: false }))
    expect(frames.map(frame => frame.type)).toEqual(['baseline', 'replace', 'upsert'])
    const resync = frames[1]!.value as { items: Array<{ workspaceId: string }> }
    expect(resync.items.map(item => item.workspaceId)).toEqual(['ws-alice'])
    const upsert = frames[2]!.workspace as { workspaceId: string; sessionIds: string[] }
    expect(upsert.sessionIds).toEqual(['s-alice', 's-alice-2'])
  })

  it('forwards removes only for delivered workspaces and resyncs order on revocation', async () => {
    const ownership = new OwnershipIndex(tmpFile())
    ownership.record('ws-alice', 'alice')
    ownership.record('ws-shared', 'alice')
    ownership.record('s-alice', 'alice')
    const deps = { store: new SessionStore(3600), ownership, sessionSource: () => undefined }
    const source = (async function* (): AsyncGenerator<Frame> {
      yield baseline([workspace('ws-alice', ['s-alice']), workspace('ws-shared', ['s-alice'])])
      yield { type: 'order', workspaceIds: ['ws-shared', 'ws-alice'] }
      // Foreign remove: not delivered → dropped.
      yield { type: 'remove', workspaceId: 'ws-root' }
      // Delivered remove: forwarded.
      yield { type: 'remove', workspaceId: 'ws-alice' }
      // ws-shared visibility is revoked (workspace + its last owned session
      // both change hands) → no longer visible → replace resync.
      ownership.record('ws-shared', 'root')
      ownership.record('s-alice', 'root')
      yield { type: 'order', workspaceIds: ['ws-shared'] }
    })()
    const frames = await collect(filterWorkspaceFollowFrames(source, deps, { username: 'alice', isAdmin: false }))
    expect(frames.map(frame => frame.type)).toEqual(['baseline', 'order', 'remove', 'replace'])
    expect((frames[1] as { workspaceIds: string[] }).workspaceIds).toEqual(['ws-shared', 'ws-alice'])
    expect((frames[2] as { workspaceId: string }).workspaceId).toBe('ws-alice')
    const resync = frames[3]!.value as { items: Array<{ workspaceId: string }> }
    expect(resync.items.map(item => item.workspaceId)).toEqual([])
  })

  it('narrows archived/pinned frames and drops unknown frame types', async () => {
    const ownership = new OwnershipIndex(tmpFile())
    ownership.record('s-alice', 'alice')
    const deps = { store: new SessionStore(3600), ownership, sessionSource: () => undefined }
    const source = (async function* (): AsyncGenerator<Frame> {
      yield baseline([])
      yield { type: 'archived', archivedSessionIds: ['s-alice', 's-root'] }
      yield { type: 'pinned', pinnedSessionIds: ['s-root'] }
      yield { type: 'mystery', value: { items: ['everything'] } }
    })()
    const frames = await collect(filterWorkspaceFollowFrames(source, deps, { username: 'alice', isAdmin: false }))
    expect(frames.map(frame => frame.type)).toEqual(['baseline', 'archived', 'pinned'])
    expect((frames[1] as { archivedSessionIds: string[] }).archivedSessionIds).toEqual(['s-alice'])
    expect((frames[2] as { pinnedSessionIds: string[] }).pinnedSessionIds).toEqual([])
  })

  it('picks up newly owned sessions mid-stream (ownership refresh per frame)', async () => {
    const ownership = new OwnershipIndex(tmpFile())
    ownership.record('ws-alice', 'alice')
    const deps = { store: new SessionStore(3600), ownership, sessionSource: () => undefined }
    const source = (async function* (): AsyncGenerator<Frame> {
      yield baseline([workspace('ws-alice', [])])
      ownership.record('s-alice-new', 'alice')
      yield { type: 'upsert', workspace: workspace('ws-alice', ['s-alice-new']) }
    })()
    const frames = await collect(filterWorkspaceFollowFrames(source, deps, { username: 'alice', isAdmin: false }))
    const upsert = frames[1]!.workspace as { sessionIds: string[] }
    expect(upsert.sessionIds).toEqual(['s-alice-new'])
  })
})

describe('dispatch guard regression coverage (issue #11)', () => {
  it('checks every guarded id field in args, not just the first', async () => {
    const h = harness()
    h.ownership.record('alice-session', 'alice')
    h.ownership.record('root-ws', 'root')
    const { token } = h.store.create('alice', false)
    const peer = h.admit(fakeRequest(`dsh-auth-v1=valid; ${buildCookieHeader(token, 3600)}`)).peer as unknown
    // The sessionId is owned but the workspaceId is not: the call is denied.
    const result = await h.gateway.dispatchRpc('session/page', { args: { sessionId: 'alice-session', workspaceId: 'root-ws' } }, new AbortController().signal, peer)
    expect(result).toEqual(deniedRpc())
    expect(calls(h).dispatchCalls).toHaveLength(0)
  })

  it('collectIds reads scalar and nested id values', () => {
    expect(collectIds('s1')).toEqual(['s1'])
    expect(collectIds({ sessionId: 's1' })).toEqual(['s1'])
    expect(collectIds([{ id: 's1' }, { id: 's2' }])).toEqual(['s1', 's2'])
  })
})
