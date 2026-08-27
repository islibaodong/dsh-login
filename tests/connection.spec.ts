/** Connection takeover plugin: /api carrier with cookie auth + per-user dispatch. */
import { EventEmitter, once } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AuthUser } from '../src/api-filter.ts'
import { createConnectionPlugin, type TakeoverDeps } from '../src/connection.ts'
import { SessionStore } from '../src/session.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { TrustedHosts } from '../src/hosts.ts'
import { fakeHttpServer, tmpFile } from './helpers.ts'

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = '/api/session.list'): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    on() { return this },
    off() { return this },
    once() { return this },
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

const LOOPBACK = { host: '127.0.0.1:3080' }

interface Setup {
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  store: SessionStore
  alice: { token: string }
  admin: { token: string }
  ownership: OwnershipIndex
  calls: string[]
  seen: string[]
  ctx: Context
  dispose: () => Promise<void>
}

async function setup(
  effectiveTrustedHosts?: () => string[],
  provision?: { defaultWorkspaceRoot: string; created: Array<{ path: string }> },
): Promise<Setup> {
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const ctx = new Context()
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as never)
  const calls: string[] = []
  const api = {
    sessions: {
      list: async (r: { rpcId: string }) => {
        calls.push('session.list')
        return { rpcId: r.rpcId, result: { ok: true, value: { items: [] } } }
      },
      create: async (r: { rpcId: string }) => {
        calls.push('session.create')
        return { rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'prov-' + calls.length } } }
      },
    },
    subagents: {
      list: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { parentAvailable: true, entries: [] } } }),
      history: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      interrupt: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
    },
    workspace: {
      list: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
      create: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      rename: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      delete: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      insertBefore: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      insertSessionBefore: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      archiveSession: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { archivedSessionIds: [] } } }),
    },
    goals: {
      create: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      edit: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      pause: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      resume: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      complete: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
      clear: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: {} } }),
    },
    events: {
      mux: async function* () {},
      host: async function* () {},
    },
    host: { describe: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: { version: 'v', cwd: 'c', attachedSessions: 0, canOpenPath: false } } }) },
    llm: { providers: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: [] } }), models: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: [] } }) },
    skills: { list: async (r: { rpcId: string }) => ({ rpcId: r.rpcId, result: { ok: true, value: [] } }) },
    settings: {},
    agentPresets: {},
    downloads: {
      sessionLog: async () => {
        calls.push('session.export')
        return new Response('session log body')
      },
    },
    respond: async () => ({ accepted: true }),
    credentials: {
      set: async (r: { rpcId: string }) => {
        calls.push('credentials.set')
        return { rpcId: r.rpcId, result: { ok: true, value: { configured: true } } }
      },
    },
  } as unknown as ApiProxy
  ctx.provide('apiProxy', api)
  if (provision !== undefined) {
    ctx.provide('workspaceRegistry', {
      create: async (path: string) => {
        provision.created.push({ path })
        return { id: 'ws-prov', path }
      },
    } as never)
  }
  const store = new SessionStore(60)
  const alice = store.create('alice', false)
  const admin = store.create('root', true)
  const ownership = new OwnershipIndex(tmpFile())
  ownership.record('own1', 'alice')
  const seen: string[] = []
  const fetchForTest: NonNullable<TakeoverDeps['fetchForTest']> = (downlinks, user: AuthUser) => {
    seen.push(user.username)
    return toFetchHandler(downlinks)
  }
  const fiber = ctx.plugin(createConnectionPlugin({
    store,
    ownership,
    trustedHosts: [],
    effectiveTrustedHosts,
    defaultWorkspaceRoot: provision?.defaultWorkspaceRoot,
    fetchForTest,
  }))
  await fiber.await()
  return {
    routes, upgrades, store, alice, admin, ownership, calls, seen, ctx,
    dispose: () => fiber.dispose(),
  }
}

const envelope = (method: string, rpcId = 't1'): unknown => ({
  type: 'client-request', rpcId, method, payload: method === 'credentials.set' ? { ref: 'X', value: 'y' } : {},
})

/** Provisioning-enabled setup: injects a defaultWorkspaceRoot + workspaceRegistry. */
async function provisionSetup(): Promise<Setup & { created: Array<{ path: string }> }> {
  const created: Array<{ path: string }> = []
  const workspaceRoot = join(mkdtempSync(join(tmpdir(), 'dsh-login-prov-e2e-')), 'ws')
  const base = await setup(() => [], { defaultWorkspaceRoot: workspaceRoot, created })
  return { ...base, created }
}

describe('dsh-login-connection', () => {
  it('registers the /api prefix route plus both event upgrades and removes them with the fiber', async () => {
    const { routes, upgrades, dispose } = await setup()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/api' })
    expect(upgrades.map(u => u.path).sort()).toEqual(['/api/events.host', '/api/events.mux'])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('refuses an untrusted Host before the bridge runs', async () => {
    const { routes, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin' }),
      response,
    )
    expect(state).toMatchObject({ status: 403, body: 'forbidden' })
    await dispose()
  })

  it('accepts a public Host listed in effectiveTrustedHosts once a session cookie is present', async () => {
    const { routes, alice, calls, seen, dispose } = await setup(() => ['pub.example.com'])
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ host: 'pub.example.com', origin: 'http://pub.example.com', 'sec-fetch-site': 'same-origin', cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-pub')),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(String(state.body))).toMatchObject({ type: 'server-response', rpcId: 'rpc-pub' })
    expect(calls).toContain('session.list')
    expect(seen).toEqual(['alice'])
    await dispose()
  })

  it('a host learned via canonicalAuthority satisfies the real isTrustedApiRequest fence', async () => {
    // Prove the persistence + canonicalization round-trip: a literal learned
    // by TrustedHosts.learn (as a real login would) must be accepted by the
    // actual fence, even when the request Host has different casing.
    const hosts = new TrustedHosts(tmpFile())
    hosts.learn('Pub.Example.com')
    expect(hosts.list()).toEqual(['pub.example.com'])
    const { routes, alice, calls, seen, dispose } = await setup(() => hosts.list())
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ host: 'PUB.example.com', origin: 'http://pub.example.com', 'sec-fetch-site': 'same-origin', cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-learned')),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(String(state.body))).toMatchObject({ type: 'server-response', rpcId: 'rpc-learned' })
    expect(calls).toContain('session.list')
    await hosts.flush()
    await dispose()
  })

  it('anonymous fetch gets 401', async () => {
    const { routes, seen, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakePost(LOOPBACK, '/api/session.list', envelope('session.list')), response)
    expect(state).toMatchObject({ status: 401, body: 'authentication required' })
    expect(seen).toEqual([])
    await dispose()
  })

  it('an invalid cookie gets 401', async () => {
    const { routes, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: 'dsh_session=bogus' }, '/api/session.list', envelope('session.list')),
      response,
    )
    expect(state).toMatchObject({ status: 401, body: 'authentication required' })
    await dispose()
  })

  it('an authenticated alice reaches the proxied session.list through her own user proxy', async () => {
    const { routes, alice, calls, seen, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-alice')),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(String(state.body))).toMatchObject({ type: 'server-response', rpcId: 'rpc-alice' })
    expect(calls).toContain('session.list')
    expect(seen).toEqual(['alice'])
    await dispose()
  })

  it('an ordinary user gets a physical 403 for a non-allowed method', async () => {
    const { routes, alice, calls, seen, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/credentials.set', envelope('credentials.set')),
      response,
    )
    expect(state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toEqual([])
    expect(seen).toEqual([])
    await dispose()
  })

  it('an admin cookie passes a privileged method unfiltered', async () => {
    const { routes, admin, calls, seen, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: `dsh_session=${admin.token}` }, '/api/credentials.set', envelope('credentials.set', 'rpc-admin')),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(String(state.body))).toMatchObject({ type: 'server-response', rpcId: 'rpc-admin', result: { ok: true } })
    expect(calls).toContain('credentials.set')
    expect(seen).toEqual(['root'])
    await dispose()
  })

  it('guards the physical session.export by ownership', async () => {
    const { routes, alice, calls, seen, dispose } = await setup()
    const denied = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.export?sessionId=alien'),
      denied.response,
    )
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(seen).toEqual([])
    const allowed = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.export?sessionId=own1'),
      allowed.response,
    )
    expect(allowed.state.status).toBe(200)
    expect(String(allowed.state.body)).toBe('session log body')
    expect(calls).toContain('session.export')
    expect(seen).toEqual(['alice'])
    await dispose()
  })

  it('answers a plain GET to an event path with 426, mirroring the upstream carrier', async () => {
    const { routes, alice, dispose } = await setup()
    for (const path of ['/api/events.mux', '/api/events.host']) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, path), response)
      expect(state).toMatchObject({ status: 426, body: 'upgrade required' })
    }
    await dispose()
  })

  it('rejects an anonymous WebSocket upgrade with the 403 socket rejection', async () => {
    const { upgrades, dispose } = await setup()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({ ...LOOPBACK }, '/api/events.mux'), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before authentication', async () => {
    const { upgrades, dispose } = await setup()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(
      fakeRequest({ host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin' }, '/api/events.mux'),
      socket,
      Buffer.alloc(0),
    )
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  // Typert Remote endpoints (`POST /api/<namespace>/<method>`) are how
  // browser UI plugins reach their host halves: the dsh-api-gateway
  // registers a shared `/api` interceptor on the `connection` service the
  // takeover must provide. Without it every installed UI plugin (SSH, task
  // board, …) fails after login even for admins.
  it('provides the connection service so the Typert gateway can register its interceptor', async () => {
    const { ctx, dispose } = await setup()
    expect(ctx.get('connection')).toBeDefined()
    await dispose()
  })

  it('dispatches a Typert endpoint claimed by an interceptor for an ordinary user', async () => {
    const { routes, alice, ctx, seen, dispose } = await setup()
    ctx.connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'ssh/listHosts',
      async () => ({ ok: true, value: { hosts: 1 } }),
      { authority: 'trusted-host' },
    )
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/ssh/listHosts', envelope('ssh/listHosts', 'rpc-ssh')),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(String(state.body))).toMatchObject({
      type: 'server-response', rpcId: 'rpc-ssh', result: { ok: true, value: { hosts: 1 } },
    })
    // Native interceptor dispatch: no per-user RpcMethodMap proxy involved.
    expect(seen).toEqual([])
    await dispose()
  })

  it('still requires a session cookie for Typert endpoints', async () => {
    const { routes, ctx, seen, dispose } = await setup()
    ctx.connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'ssh/listHosts',
      async () => ({ ok: true, value: {} }),
      { authority: 'trusted-host' },
    )
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakePost(LOOPBACK, '/api/ssh/listHosts', envelope('ssh/listHosts')), response)
    expect(state).toMatchObject({ status: 401, body: 'authentication required' })
    expect(seen).toEqual([])
    await dispose()
  })

  it('answers 404 for an unclaimed two-segment endpoint instead of leaking into the RpcMethodMap handler', async () => {
    const { routes, alice, seen, dispose } = await setup()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/nope/missing', envelope('nope/missing')),
      response,
    )
    expect(state).toMatchObject({ status: 404, body: 'not found' })
    expect(seen).toEqual([])
    await dispose()
  })
})

describe('dsh-login-connection default-workspace provisioning', () => {
  it('provisions a non-admin user\u2019s default workspace on first /api access, once', async () => {
    const { routes, alice, admin, created, dispose } = await provisionSetup()
    const first = fakeResponse(); const second = fakeResponse()
    await routes[0]!.handler(fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-prov-1')), first.response)
    await routes[0]!.handler(fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-prov-1b')), second.response)
    expect(first.state.status).toBe(200)
    expect(second.state.status).toBe(200)
    // Exactly one per-user workspace was provisioned (idempotent across requests).
    expect(created).toHaveLength(1)
    expect(join(created[0]!.path)).toContain(join('ws', 'alice'))

    // Admin is never provisioned.
    const adminReq = fakePost({ ...LOOPBACK, cookie: `dsh_session=${admin.token}` }, '/api/session.list', envelope('session.list', 'rpc-prov-admin'))
    const adminRes = fakeResponse()
    await routes[0]!.handler(adminReq, adminRes.response)
    expect(adminRes.state.status).toBe(200)
    expect(created).toHaveLength(1)
    await dispose()
  })

  it('provisions each non-admin user independently', async () => {
    const { routes, alice, store, created, dispose } = await provisionSetup()
    const bob = store.create('bob', false)
    const a = fakeResponse()
    await routes[0]!.handler(fakePost({ ...LOOPBACK, cookie: `dsh_session=${alice.token}` }, '/api/session.list', envelope('session.list', 'rpc-a')), a.response)
    expect(a.state.status).toBe(200)
    expect(created).toHaveLength(1)
    const b = fakeResponse()
    await routes[0]!.handler(fakePost({ ...LOOPBACK, cookie: `dsh_session=${bob.token}` }, '/api/session.list', envelope('session.list', 'rpc-b')), b.response)
    expect(b.state.status).toBe(200)
    // alice + bob each get their own workspace sandbox.
    expect(created).toHaveLength(2)
    expect(created.some(w => w.path.endsWith(join('ws', 'alice')))).toBe(true)
    expect(created.some(w => w.path.endsWith(join('ws', 'bob')))).toBe(true)
    await dispose()
  })
})
