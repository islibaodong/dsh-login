import { mkdtempSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from './memory-credentials.ts'
import { SessionStore } from '../src/session.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { createApiBridgeAuth, type ApiBridgeAuthDeps } from '../src/api-bridge-auth.ts'
import * as DshLogin from '../src/index.ts'

/**
 * Minimal stand-ins: the wall reads headers.cookie (+ method/url/body on the
 * POST paths) and writes a response.
 */
interface FakeRequest {
  headers: { cookie?: string }
  method?: string
  url?: string
  setEncoding?(encoding: string): unknown
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<string>
}

function fakeRequest(cookie?: string, opts?: { method?: string; url?: string; body?: string }): FakeRequest {
  const req: FakeRequest = { headers: cookie === undefined ? {} : { cookie } }
  if (opts?.method !== undefined) req.method = opts.method
  if (opts?.url !== undefined) req.url = opts.url
  if (opts?.body !== undefined) {
    const chunk = opts.body
    req.setEncoding = () => req
    req[Symbol.asyncIterator] = async function* () { yield chunk }
  }
  return req
}

/** Plain fake: captures status + body for deny/401 paths (no tee surface). */
function fakeResponse(): { status?: number; body?: string; writeHead(n: number, h?: unknown): unknown; end(b?: string): unknown } {
  const res: { status?: number; body?: string; writeHead(n: number, h?: unknown): unknown; end(b?: string): unknown } = {
    writeHead(n) { res.status = n; return res },
    end(b) { res.body = b ?? ''; return res },
  }
  return res
}

/**
 * Full fake with the ServerResponse surface the response tee wraps. The tee
 * binds the ORIGINAL methods first and replaces them; the bridge (next) then
 * writes through the wrapped ones and flush() replays through the originals.
 */
function fakeTeeResponse(): {
  headersSent: boolean
  status?: number
  headers: Record<string, unknown>
  chunks: string[]
  setHeader(name: string, value: unknown): unknown
  writeHead(n: number, ...rest: unknown[]): unknown
  write(b: unknown): unknown
  end(b?: unknown): unknown
} {
  const res = {
    headersSent: false,
    status: undefined as number | undefined,
    headers: {} as Record<string, unknown>,
    chunks: [] as string[],
    setHeader(name: string, value: unknown) { res.headers[String(name).toLowerCase()] = value; return res },
    writeHead(n: number) { res.status = n; return res },
    write(b: unknown) { res.chunks.push(String(b)); return true },
    end(b?: unknown) { if (b !== undefined) res.chunks.push(String(b)); return res },
  }
  return res
}

const unitOwnershipPath = join(mkdtempSync(join(tmpdir(), 'dsh-bridge-auth-unit-')), 'ownership.json')

function unitDeps(store: SessionStore, overrides: Partial<ApiBridgeAuthDeps> = {}): ApiBridgeAuthDeps {
  return {
    store,
    ownership: new OwnershipIndex(unitOwnershipPath),
    quietDenials: true,
    ...overrides,
  }
}

describe('createApiBridgeAuth (unit)', () => {
  it('admits a request carrying a live dsh_session cookie (calls next)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const next = async () => 'inner'
    const res = fakeResponse()
    const result = await createApiBridgeAuth(unitDeps(store))(fakeRequest(`dsh_session=${token}`) as never, res as never, next)
    expect(result).toBe('inner')
    expect(res.status).toBeUndefined()
  })

  it('answers 401 without calling next when the cookie is missing or unknown', async () => {
    const store = new SessionStore(3600)
    const wall = createApiBridgeAuth(unitDeps(store))
    let innerRan = false
    const next = async () => { innerRan = true }

    for (const cookie of [undefined, 'other=1', 'dsh_session=', 'dsh_session=deadbeef']) {
      const res = fakeResponse()
      await wall(fakeRequest(cookie) as never, res as never, next)
      expect(res.status).toBe(401)
      expect(res.body).toBe('unauthorized')
    }
    expect(innerRan).toBe(false)
  })

  it('denies an expired session (fail-closed)', async () => {
    const store = new SessionStore(-1) // negative ttl → already expired
    const { token } = store.create('alice', false)
    const res = fakeResponse()
    await createApiBridgeAuth(unitDeps(store))(fakeRequest(`dsh_session=${token}`) as never, res as never, async () => 'inner')
    expect(res.status).toBe(401)
  })

  it('denies a revoked session — logout actually revokes the bridge', async () => {
    const store = new SessionStore(3600)
    const wall = createApiBridgeAuth(unitDeps(store))
    const { token } = store.create('alice', false)
    const admitted = await wall(fakeRequest(`dsh_session=${token}`) as never, fakeResponse() as never, async () => 'inner')
    expect(admitted).toBe('inner')

    store.revoke(token)
    const res = fakeResponse()
    await wall(fakeRequest(`dsh_session=${token}`) as never, res as never, async () => 'inner')
    expect(res.status).toBe(401)
  })

  it('passes non-POST bridge traffic through (GET/SSE ride the upstream fence)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store))
    const res = fakeResponse()
    const result = await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'GET', url: '/api/credentials.list' }) as never,
      res as never,
      async () => 'inner',
    )
    expect(result).toBe('inner')
    expect(res.status).toBeUndefined()
  })

  it('quietly denies a non-admin POST to a non-whitelisted endpoint with a wire-correct envelope', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store))
    let innerRan = false
    const res = fakeResponse()
    await wall(
      fakeRequest(`dsh_session=${token}`, {
        method: 'POST',
        url: '/api/credentials.list',
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'credentials.list', payload: {} }),
      }) as never,
      res as never,
      async () => { innerRan = true },
    )
    expect(innerRan).toBe(false)
    expect(res.status).toBe(200)
    const envelope = JSON.parse(res.body!) as { type?: string; rpcId?: string; result?: { ok?: boolean; error?: { code?: string } } }
    expect(envelope.type).toBe('server-response')
    expect(envelope.rpcId).toBe('rpc-1')
    expect(envelope.result?.ok).toBe(false)
    expect(envelope.result?.error?.code).toBe('forbidden')
  })

  it('answers a plain 403 for denied methods when quietDenials is off', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store, { quietDenials: false }))
    const res = fakeResponse()
    await wall(
      fakeRequest(`dsh_session=${token}`, {
        method: 'POST',
        url: '/api/credentials.list',
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'credentials.list', payload: {} }),
      }) as never,
      res as never,
      async () => 'inner',
    )
    expect(res.status).toBe(403)
  })

  it('falls back to 403 when the denied body cannot yield an rpcId', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store))
    const res = fakeResponse()
    await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/credentials.list', body: 'not-json' }) as never,
      res as never,
      async () => 'inner',
    )
    expect(res.status).toBe(403)
  })

  it('lets an admin POST reach a non-whitelisted endpoint (no enforcement for admins)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('root', true)
    const wall = createApiBridgeAuth(unitDeps(store))
    const res = fakeResponse()
    const result = await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/terminal.create', body: '{}' }) as never,
      res as never,
      async () => 'inner',
    )
    expect(result).toBe('inner')
    expect(res.status).toBeUndefined()
  })

  it('records ownership from an admitted non-admin session.create response (tee)', async () => {
    const store = new SessionStore(3600)
    const ownership = new OwnershipIndex(join(mkdtempSync(join(tmpdir(), 'dsh-tee-')), 'ownership.json'))
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store, { ownership }))
    const res = fakeTeeResponse()

    await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/session.create', body: '{}' }) as never,
      res as never,
      // The bridge answers a wire envelope; the tee must not corrupt it.
      async () => {
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { sessionId: 's-created' } } }))
        return 'bridged'
      },
    )

    expect(res.status).toBe(200)
    expect(JSON.parse(res.chunks.join(''))).toEqual({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { sessionId: 's-created' } } })
    expect(ownership.lookup('s-created')).toBe('alice')
  })

  it('filters session.list responses down to the owned set (bare controller shape)', async () => {
    const store = new SessionStore(3600)
    const ownership = new OwnershipIndex(join(mkdtempSync(join(tmpdir(), 'dsh-tee-')), 'ownership.json'))
    ownership.record('s-owned', 'alice')
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store, {
      ownership,
      ownedProvider: async () => new Set(['s-owned']),
    }))
    const res = fakeTeeResponse()

    await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/session.list', body: '{}' }) as never,
      res as never,
      async () => {
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ items: [{ sessionId: 's-owned' }, { sessionId: 's-other' }] }))
        return 'bridged'
      },
    )

    expect(JSON.parse(res.chunks.join(''))).toEqual({ items: [{ sessionId: 's-owned' }] })
  })

  it('flushes a non-JSON or failing-shape response unchanged (observation never corrupts)', async () => {
    const store = new SessionStore(3600)
    const ownership = new OwnershipIndex(join(mkdtempSync(join(tmpdir(), 'dsh-tee-')), 'ownership.json'))
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store, {
      ownership,
      ownedProvider: async () => new Set(['s-owned']),
    }))
    const res = fakeTeeResponse()
    const rawBody = '<html>unexpected</html>'

    await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/session.list', body: '{}' }) as never,
      res as never,
      async () => {
        res.setHeader('content-type', 'text/html')
        res.writeHead(200)
        res.end(rawBody)
        return 'bridged'
      },
    )

    expect(res.chunks.join('')).toBe(rawBody)
  })

  it('records admin-created sessions too (record-only observation, no filtering)', async () => {
    const store = new SessionStore(3600)
    const ownership = new OwnershipIndex(join(mkdtempSync(join(tmpdir(), 'dsh-tee-')), 'ownership.json'))
    const { token } = store.create('root', true)
    const wall = createApiBridgeAuth(unitDeps(store, { ownership }))
    const res = fakeTeeResponse()

    await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/session.create', body: '{}' }) as never,
      res as never,
      async () => {
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ result: { ok: true, value: { sessionId: 's-admin' } } }))
        return 'bridged'
      },
    )

    expect(ownership.lookup('s-admin')).toBe('root')
  })

  it('fires the provisioner on the first admitted non-admin POST (fire-and-forget)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const provisioner = { ensure: vi.fn(async () => {}) }
    const wall = createApiBridgeAuth(unitDeps(store, { provisioner }))
    const result = await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/api/session.list', body: '{}' }) as never,
      fakeTeeResponse() as never,
      async () => 'inner',
    )
    expect(result).toBe('inner')
    // The wall does not await ensure (best-effort), so yield a tick first.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provisioner.ensure).toHaveBeenCalledWith({ username: 'alice', isAdmin: false })
  })

  it('leaves an unrecognized URL alone (no enforcement outside /api/)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const wall = createApiBridgeAuth(unitDeps(store))
    const res = fakeResponse()
    const result = await wall(
      fakeRequest(`dsh_session=${token}`, { method: 'POST', url: '/other/path', body: '{}' }) as never,
      res as never,
      async () => 'inner',
    )
    expect(result).toBe('inner')
    expect(res.status).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Full-composition wiring: dsh-login registers the wall on the shared
// `connection/request` waterfall. There is no connection row in this test
// composition, so the test itself emits the event exactly like the native
// /api route handler does (webCtx.waterfall('connection/request', req, res,
// () => bridge(...))) and observes admit/veto.
// ---------------------------------------------------------------------------

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(apiBridgeAuth: boolean): Promise<{ port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bridge-auth-'))
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
    "- id: login",
    "  name: '@islibaodong/dsh-login'",
    '  config:',
    '    password: DSH_LOGIN_PASSWORD',
    `    distIndex: '${distIndex}'`,
    `    dataDir: '${dataDir}'`,
    '    sessionTtl: 3600',
    '    enabled: true',
    `    apiBridgeAuth: ${String(apiBridgeAuth)}`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
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

async function setupAdmin(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 's3cret' }),
  })
  if (res.status !== 200) throw new Error(`setup failed: ${String(res.status)}`)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

/**
 * Emit `connection/request` exactly like the native /api route handler
 * (`webCtx.waterfall('connection/request', req, res, () => bridge(...))`) and
 * return both the waterfall result and the fake response so tests can observe
 * the wall's 401.
 */
function emitBridgeRequest(cookie: string | undefined, next: () => Promise<unknown>): { result: Promise<unknown>; res: ReturnType<typeof fakeResponse> } {
  const req = fakeRequest(cookie)
  const res = fakeResponse()
  const events = context as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown> }
  return { result: events.waterfall('connection/request', req, res, next), res }
}

describe('dsh-login /api bridge auth wall (full composition)', () => {
  it('admits bridged requests of a logged-in user and vetoes anonymous ones', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition(true)
    const cookie = await setupAdmin(port)

    // A logged-in session rides the bridge (inner = the native bridge).
    const inner = async () => 'bridged'
    await expect(emitBridgeRequest(cookie, inner).result).resolves.toBe('bridged')

    // No cookie: the wall answers 401 and the bridge never runs.
    let innerRan = false
    const spyInner = async () => { innerRan = true }
    const anonymous = emitBridgeRequest(undefined, spyInner)
    await expect(anonymous.result).resolves.toBeUndefined()
    expect(innerRan).toBe(false)
    expect(anonymous.res.status).toBe(401)

    // Logout: the same cookie that was admitted is now vetoed.
    await fetch(`http://127.0.0.1:${String(port)}/api/auth/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
    })
    let innerRanAfterLogout = false
    const afterLogout = emitBridgeRequest(cookie, async () => { innerRanAfterLogout = true })
    await expect(afterLogout.result).resolves.toBeUndefined()
    expect(innerRanAfterLogout).toBe(false)
    expect(afterLogout.res.status).toBe(401)
  })

  it('is absent when apiBridgeAuth is off (the bridge inner runs unauthenticated)', { timeout: 60_000 }, async () => {
    await loadComposition(false)
    const inner = async () => 'bridged'
    const { result } = emitBridgeRequest(undefined, inner)
    await expect(result).resolves.toBe('bridged')
  })

  it('publishes the ownership sidecar as the dshLoginOwnership service', { timeout: 60_000 }, async () => {
    await loadComposition(true)
    const ownership = (context as unknown as { get(key: string): unknown }).get('dshLoginOwnership')
    expect(ownership).toBeDefined()
    expect((ownership as { lookup(id: string): string | undefined }).lookup('anything')).toBeUndefined()
  })
})
