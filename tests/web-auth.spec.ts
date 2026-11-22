import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { MemoryCredentials } from './memory-credentials.ts'
import * as DshLogin from '../src/index.ts'
import { createWebIdentity, sessionFromHeaders, type ConnectionLike, type PeerScopeLike } from '../src/web-auth.ts'
import { peerUser } from '../src/dispatch-guard.ts'
import { SessionStore } from '../src/session.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A connection service stand-in that records peers and providers. */
function fakeConnection(): { service: ConnectionLike; created: PeerScopeLike[]; providers: { authenticate(request: { headers: unknown }): PeerScopeLike | undefined }[] } {
  const created: PeerScopeLike[] = []
  const providers: { authenticate(request: { headers: unknown }): PeerScopeLike | undefined }[] = []
  const service: ConnectionLike = {
    createPeer(options) {
      const peer: PeerScopeLike & { disposed?: boolean } = {
        id: `peer-${String(created.length)}`,
        principal: options.principal,
        dispose: async () => {
          peer.disposed = true
        },
      }
      created.push(peer)
      return peer
    },
    authentication: {
      register(provider) {
        providers.push(provider as { authenticate(request: { headers: unknown }): PeerScopeLike | undefined })
        return async () => {}
      },
    },
  }
  return { service, created, providers }
}

describe('sessionFromHeaders', () => {
  it('reads the dsh_session cookie from a Fetch Headers object', () => {
    const store = new SessionStore(3600)
    const session = store.create('alice', false)
    const headers = new Headers({ cookie: `theme=dark; dsh_session=${session.token}` })
    expect(sessionFromHeaders(headers, store)).toEqual({ token: session.token, user: { username: 'alice', isAdmin: false } })
  })

  it('reads node header records, including repeated cookie headers', () => {
    const store = new SessionStore(3600)
    const session = store.create('root', true)
    expect(sessionFromHeaders({ cookie: [`theme=dark`, `dsh_session=${session.token}`] }, store)).toEqual({
      token: session.token,
      user: { username: 'root', isAdmin: true },
    })
    expect(sessionFromHeaders({ cookie: `theme=dark; dsh_session=${session.token}` }, store)?.user.isAdmin).toBe(true)
  })

  it('rejects absent and unknown cookies', () => {
    const store = new SessionStore(3600)
    expect(sessionFromHeaders(undefined, store)).toBeUndefined()
    expect(sessionFromHeaders({}, store)).toBeUndefined()
    expect(sessionFromHeaders({ cookie: 'dsh_session=nope' }, store)).toBeUndefined()
  })
})

describe('web identity', () => {
  it('claims exactly one tagged owner peer per live session token', () => {
    const ctx = new Context()
    const store = new SessionStore(3600)
    const fake = fakeConnection()
    ctx.provide('connection', fake.service as never)
    const identity = createWebIdentity(ctx, store)
    const session = store.create('bob', false)
    const first = identity.peerForSession(session.token, { username: 'bob', isAdmin: false })
    const second = identity.peerForSession(session.token, { username: 'bob', isAdmin: false })
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(fake.created).toHaveLength(1)
    expect(first?.principal).toEqual({ kind: 'owner' })
    expect(peerUser(first)).toEqual({ username: 'bob', isAdmin: false })
    identity.disposeAll()
    expect((first as PeerScopeLike & { disposed?: boolean }).disposed).toBe(true)
  })

  it('falls back to undefined when the connection seam is absent (rc.5 boot)', () => {
    const ctx = new Context()
    const store = new SessionStore(3600)
    const identity = createWebIdentity(ctx, store)
    const session = store.create('bob', false)
    expect(identity.peerForSession(session.token, { username: 'bob', isAdmin: false })).toBeUndefined()
  })

  it('registers a provider that authenticates live sessions and declines everything else', () => {
    const ctx = new Context()
    const store = new SessionStore(3600)
    const fake = fakeConnection()
    ctx.provide('connection', fake.service as never)
    const identity = createWebIdentity(ctx, store)
    identity.register(fake.service)
    expect(fake.providers).toHaveLength(1)
    const session = store.create('alice', true)
    const claimed = fake.providers[0]!.authenticate({ headers: { cookie: `dsh_session=${session.token}` } })
    expect(claimed).toBe(identity.peerForSession(session.token, { username: 'alice', isAdmin: true }))
    expect(peerUser(claimed)).toEqual({ username: 'alice', isAdmin: true })
    expect(fake.providers[0]!.authenticate({ headers: {} })).toBeUndefined()
    expect(fake.providers[0]!.authenticate({ headers: { cookie: 'dsh_session=stale' } })).toBeUndefined()
  })

  it('keeps the peer cache bounded by disposing the oldest claim', () => {
    const ctx = new Context()
    const store = new SessionStore(3600)
    const fake = fakeConnection()
    ctx.provide('connection', fake.service as never)
    const identity = createWebIdentity(ctx, store)
    for (let index = 0; index < 257; index += 1) {
      const session = store.create(`user${String(index)}`, false)
      identity.peerForSession(session.token, { username: `user${String(index)}`, isAdmin: false })
    }
    expect(fake.created).toHaveLength(257)
    expect((fake.created[0] as PeerScopeLike & { disposed?: boolean }).disposed).toBe(true)
    expect(identity.disposeAll()).toBeUndefined()
  })
})

describe('alpha.1 connection admission (full composition)', () => {
  async function boot(): Promise<{ port: number }> {
    root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-'))
    const dist = join(root, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>shell</body></html>')
    const dataDir = join(root, 'data')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-client-connection'",
      '  config:',
      '    trustedHosts: []',
      "- id: login",
      "  name: '@islibaodong/dsh-login'",
      '  config:',
      '    password: DSH_LOGIN_PASSWORD',
      `    distIndex: '${distIndex}'`,
      `    dataDir: '${dataDir}'`,
      '    sessionTtl: 3600',
      '    enabled: true',
      '    apiBridgeAuth: false',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-client-connection', Connection],
      ['@islibaodong/dsh-login', DshLogin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    await context.plugin(MemoryCredentials)
    return { port: context.webServer.port }
  }

  async function request(port: number, path: string, cookie?: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {}
    if (cookie !== undefined) headers.Cookie = cookie
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { headers, redirect: 'manual' })
    return { status: res.status, text: await res.text() }
  }

  it('answers 401 on /api for an anonymous browser', { timeout: 60_000 }, async () => {
    const { port } = await boot()
    const res = await request(port, '/api/does-not-exist')
    expect(res.status).toBe(401)
  })

  it('admits a logged-in browser past the webserver fence and keeps a tagged peer', { timeout: 60_000 }, async () => {
    const { port } = await boot()
    // Create a user + session through the plugin's own login API so the
    // session store and the provider agree on the token.
    const setup = await fetch(`http://127.0.0.1:${String(port)}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 's3cret!!' }),
    })
    const cookie = setup.headers.get('set-cookie') ?? ''
    const token = cookie.split(';')[0]
    const me = await request(port, '/api/auth/me', token)
    expect(setup.status).toBe(200)
    expect(me.status).toBe(200)
    // The carrier admits the peer: the bridge answers an unregistered channel
    // itself (4xx from the bridge, not the webserver fence's 401).
    const res = await request(port, '/api/does-not-exist', token)
    expect(res.status).not.toBe(401)
    expect(res.status).toBeGreaterThanOrEqual(400)
    // The index fallback still runs its own cookie wall and reaches the shell.
    const idxResp = await fetch('http://127.0.0.1:' + String(port) + '/', { headers: { cookie: token } })
    expect(idxResp.status).toBe(200)
    expect((await request(port, '/', 'dsh_session=stale')).status).toBe(302)
  })
})
