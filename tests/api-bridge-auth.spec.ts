import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from './memory-credentials.ts'
import { SessionStore } from '../src/session.ts'
import { createApiBridgeAuth } from '../src/api-bridge-auth.ts'
import * as DshLogin from '../src/index.ts'

/** Minimal stand-ins: the wall only reads headers.cookie and writes a response. */
function fakeRequest(cookie?: string): { headers: { cookie?: string } } {
  return { headers: cookie === undefined ? {} : { cookie } }
}
function fakeResponse(): { status?: number; body?: string; writeHead(n: number, h?: unknown): unknown; end(b?: string): unknown } {
  const res: { status?: number; body?: string; writeHead(n: number, h?: unknown): unknown; end(b?: string): unknown } = {
    writeHead(n) { res.status = n; return res },
    end(b) { res.body = b ?? ''; return res },
  }
  return res
}

describe('createApiBridgeAuth (unit)', () => {
  it('admits a request carrying a live dsh_session cookie (calls next)', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const next = async () => 'inner'
    const res = fakeResponse()
    const result = await createApiBridgeAuth(store)(fakeRequest(`dsh_session=${token}`) as never, res as never, next)
    expect(result).toBe('inner')
    expect(res.status).toBeUndefined()
  })

  it('answers 401 without calling next when the cookie is missing or unknown', async () => {
    const store = new SessionStore(3600)
    let innerRan = false
    const next = async () => { innerRan = true }

    for (const cookie of [undefined, 'other=1', 'dsh_session=', 'dsh_session=deadbeef']) {
      const res = fakeResponse()
      await createApiBridgeAuth(store)(fakeRequest(cookie) as never, res as never, next)
      expect(res.status).toBe(401)
      expect(res.body).toBe('unauthorized')
    }
    expect(innerRan).toBe(false)
  })

  it('denies an expired session (fail-closed)', async () => {
    const store = new SessionStore(-1) // negative ttl → already expired
    const { token } = store.create('alice', false)
    const res = fakeResponse()
    await createApiBridgeAuth(store)(fakeRequest(`dsh_session=${token}`) as never, res as never, async () => 'inner')
    expect(res.status).toBe(401)
  })

  it('denies a revoked session — logout actually revokes the bridge', async () => {
    const store = new SessionStore(3600)
    const { token } = store.create('alice', false)
    const admitted = await createApiBridgeAuth(store)(fakeRequest(`dsh_session=${token}`) as never, fakeResponse() as never, async () => 'inner')
    expect(admitted).toBe('inner')

    store.revoke(token)
    const res = fakeResponse()
    await createApiBridgeAuth(store)(fakeRequest(`dsh_session=${token}`) as never, res as never, async () => 'inner')
    expect(res.status).toBe(401)
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
})
