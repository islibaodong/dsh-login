/**
 * Task 7 — one end-to-end multi-user isolation scenario against the COMPOSED
 * plugin (src/index.ts: real SessionStore/UserStore/OwnershipIndex/
 * createUserProxy/connection takeover), booted on a real WebServer through
 * the Cordis Loader exactly like tests/plugin-entry.spec.ts, plus a fake
 * apiProxy (modeled on tests/connection.spec.ts and tests/api-filter.spec.ts)
 * so every isolation rule is exercised over real HTTP with real cookies —
 * including the /api/events.mux WebSocket downlink.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { MemoryCredentials } from './memory-credentials.ts'
import * as DshLogin from '../src/index.ts'

const HARNESS = process.env.DSH_HARNESS_CHECKOUT ?? 'E:/code/deepseek-harness'

// 'ws' is not a dependency of this checkout; resolve it the way the aliased
// dsh-client-connection source does (from the harness checkout, same trick
// tests/integration-runner.mjs uses for js-yaml).
const requireFromHarness = createRequire(join(HARNESS, 'packages/client/connection/src/index.ts'))
type WsMessage = (data: unknown) => void
interface WsClient {
  on(event: 'message', cb: WsMessage): WsClient
  on(event: 'close', cb: () => void): WsClient
}
const WebSocketClient = requireFromHarness('ws') as new (url: string, options: { headers: Record<string, string> }) => WsClient

/** Mutable fake-host state observed by the scenario's assertions. */
interface FakeHost {
  api: ApiProxy
  sessions: Array<{ sessionId: string; updatedAt: number; running: boolean; blank: false }>
  prompts: string[]
  exports: string[]
  calls: string[]
}

/** Fake ApiProxy satisfying the real surface (extends the connection.spec fake). */
function fakeApiProxy(): FakeHost {
  const calls: string[] = []
  const prompts: string[] = []
  const exports: string[] = []
  const sessions = [
    { sessionId: 's-alice', updatedAt: 1, running: false, blank: false },
    { sessionId: 's-bob', updatedAt: 2, running: false, blank: false },
    { sessionId: 's-orphan', updatedAt: 3, running: false, blank: false },
  ]
  let created = 0
  const ok = <T,>(rpcId: string, value: T) => ({ rpcId: rpcId as never, result: { ok: true as const, value } })
  const api = {
    sessions: {
      list: async (r: { rpcId: string }) => {
        calls.push('session.list')
        return ok(r.rpcId, { items: sessions.map(s => ({ ...s, sessionId: s.sessionId as never })) })
      },
      create: async (r: { rpcId: string }) => {
        calls.push('session.create')
        created += 1
        const sessionId = `s-new-${created}`
        sessions.push({ sessionId, updatedAt: Date.now(), running: false, blank: false })
        return ok(r.rpcId, { sessionId: sessionId as never })
      },
      prompt: async (r: { rpcId: string; payload: { sessionId?: string } }) => {
        calls.push('session.prompt')
        prompts.push(r.payload.sessionId ?? '(none)')
        return ok(r.rpcId, { accepted: true })
      },
    },
    subagents: {
      list: async (r: { rpcId: string }) => ok(r.rpcId, { parentAvailable: true, entries: [] }),
      history: async (r: { rpcId: string }) => ok(r.rpcId, { events: [], hasMore: false }),
      prompt: async (r: { rpcId: string }) => ok(r.rpcId, { accepted: true }),
      interrupt: async (r: { rpcId: string }) => ok(r.rpcId, {}),
    },
    workspace: {
      list: async (r: { rpcId: string }) => ok(r.rpcId, { items: [], archivedSessionIds: [] }),
      create: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      rename: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      delete: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      insertBefore: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      insertSessionBefore: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      archiveSession: async (r: { rpcId: string }) => ok(r.rpcId, { archivedSessionIds: [] }),
    },
    goals: {
      create: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      edit: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      pause: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      resume: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      complete: async (r: { rpcId: string }) => ok(r.rpcId, {}),
      clear: async (r: { rpcId: string }) => ok(r.rpcId, {}),
    },
    events: {
      mux: async function* () {
        yield { rpcId: RpcId('mux-1'), payload: { type: 'session/subscribed', sessionId: 's-alice', lastSeq: 0 } }
        yield { rpcId: RpcId('mux-2'), payload: { type: 'session/subscribed', sessionId: 's-bob', lastSeq: 0 } }
      },
      host: async function* () {},
    },
    host: { describe: async (r: { rpcId: string }) => ok(r.rpcId, { version: 'v', cwd: 'c', attachedSessions: 0, canOpenPath: false }) },
    llm: {
      providers: async (r: { rpcId: string }) => ok(r.rpcId, []),
      models: async (r: { rpcId: string }) => ok(r.rpcId, []),
    },
    skills: { list: async (r: { rpcId: string }) => ok(r.rpcId, []) },
    settings: {},
    agentPresets: {},
    downloads: {
      sessionLog: async (query: { sessionId?: string }) => {
        calls.push('session.export')
        exports.push(query.sessionId ?? '(none)')
        return new Response('session log body')
      },
    },
    respond: async () => ({ accepted: true }),
    credentials: {
      set: async (r: { rpcId: string }) => {
        calls.push('credentials.set')
        return ok(r.rpcId, { configured: true })
      },
    },
  } as unknown as ApiProxy
  return { api, sessions, prompts, exports, calls }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the composed plugin on a real WebServer (plugin-entry pattern) with
 * a fake apiProxy and a pre-seeded ownership index (s-alice→alice, s-bob→bob,
 * exactly the file OwnershipIndex.record would have persisted). */
async function loadComposition(): Promise<{ port: number; host: FakeHost }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-login-e2e-'))
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>shell</body></html>')
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'ownership.json'), `${JSON.stringify({ 's-alice': 'alice', 's-bob': 'bob' })}\n`)
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
    '',
  ].join('\n'))
  const host = fakeApiProxy()
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  context.provide('apiProxy', host.api as never)
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
  return { port: context.webServer.port, host }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function postJson(port: number, path: string, body: unknown, cookie?: string): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie !== undefined) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers }
}

/** POST one client-request envelope to /api/<method> and parse the reply. */
async function rpc(port: number, cookie: string, method: string, payload: unknown, rpcId = `e2e-${method}`): Promise<{ status: number; envelope: Record<string, any> }> {
  const res = await postJson(port, `/api/${method}`, { type: 'client-request', rpcId, method, payload }, cookie)
  return { status: res.status, envelope: (res.json ?? {}) as Record<string, any> }
}

const listedIds = (envelope: Record<string, any>): string[] =>
  (envelope.result?.value?.items ?? []).map((item: { sessionId: string }) => item.sessionId)

/** Open the mux WebSocket downlink with the given cookie; resolves with the
 * payload frames received before the server closes the stream. */
async function openMux(port: number, cookie: string): Promise<Array<{ type: string; sessionId?: string }>> {
  const ws = new WebSocketClient(`ws://127.0.0.1:${String(port)}/api/events.mux`, { headers: { Cookie: cookie } })
  const frames: Array<{ type: string; sessionId?: string }> = []
  const closed = new Promise<void>(resolve => ws.on('close', () => resolve()))
  ws.on('message', (data: unknown) => {
    const parsed = JSON.parse(String(data)) as { payload: { type: string; sessionId?: string } }
    frames.push(parsed.payload)
  })
  await closed
  return frames
}

describe('dsh-login multi-user end-to-end isolation', () => {
  it('drives the full 9-step scenario through the composed plugin over real HTTP', { timeout: 60_000 }, async () => {
    const { port, host } = await loadComposition()

    // Step 1: empty users -> setup creates the forced admin; login works; me -> admin.
    const setup = await postJson(port, '/api/auth/setup', { username: 'alice', password: 'alice-pw' })
    expect(setup.status).toBe(200)
    expect(setup.json).toEqual({ ok: true })
    const aliceLogin = await postJson(port, '/api/auth/login', { username: 'alice', password: 'alice-pw' })
    expect(aliceLogin.status).toBe(200)
    const aliceCookie = aliceLogin.headers.get('set-cookie')!.split(';')[0]!
    const aliceMe = await request(port, '/api/auth/me', { headers: { Cookie: aliceCookie } })
    expect(aliceMe.status).toBe(200)
    expect(JSON.parse(aliceMe.body)).toEqual({ username: 'alice', isAdmin: true })

    // Step 2: alice creates bob via the admin route; bob logs in as non-admin.
    const createBob = await postJson(port, '/api/auth/admin/users', { username: 'bob', password: 'bob-pw' }, aliceCookie)
    expect(createBob.status).toBe(201)
    expect(createBob.json).toEqual({ ok: true })
    const bobLogin = await postJson(port, '/api/auth/login', { username: 'bob', password: 'bob-pw' })
    expect(bobLogin.status).toBe(200)
    const bobCookie = bobLogin.headers.get('set-cookie')!.split(';')[0]!
    const bobMe = await request(port, '/api/auth/me', { headers: { Cookie: bobCookie } })
    expect(JSON.parse(bobMe.body)).toEqual({ username: 'bob', isAdmin: false })

    // Step 3: alice (admin) lists every session; bob lists only s-bob.
    const aliceList = await rpc(port, aliceCookie, 'session.list', {})
    expect(aliceList.envelope.result.ok).toBe(true)
    expect(listedIds(aliceList.envelope)).toEqual(['s-alice', 's-bob', 's-orphan'])
    const bobList = await rpc(port, bobCookie, 'session.list', {})
    expect(listedIds(bobList.envelope)).toEqual(['s-bob'])

    // Step 4: bob creates a session; ownership is recorded for bob; alice and
    // bob list it, but a third user carol (created by alice) does not.
    const bobCreate = await rpc(port, bobCookie, 'session.create', {})
    expect(bobCreate.envelope.result.ok).toBe(true)
    const newId: string = bobCreate.envelope.result.value.sessionId
    expect(newId).toMatch(/^s-new-/)
    expect(listedIds((await rpc(port, aliceCookie, 'session.list', {})).envelope)).toContain(newId)
    expect(listedIds((await rpc(port, bobCookie, 'session.list', {})).envelope)).toContain(newId)
    const createCarol = await postJson(port, '/api/auth/admin/users', { username: 'carol', password: 'carol-pw' }, aliceCookie)
    expect(createCarol.status).toBe(201)
    const carolLogin = await postJson(port, '/api/auth/login', { username: 'carol', password: 'carol-pw' })
    const carolCookie = carolLogin.headers.get('set-cookie')!.split(';')[0]!
    expect(listedIds((await rpc(port, carolCookie, 'session.list', {})).envelope)).toEqual([])

    // Step 5: bob cannot prompt alice's session (envelope forbidden); alice
    // (admin) can prompt bob's; the fake proxy recorded only the allowed one.
    const bobDenied = await rpc(port, bobCookie, 'session.prompt', { sessionId: 's-alice', mode: 'queue', content: [] })
    expect(bobDenied.envelope.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(bobDenied.envelope.rpcId).toBe('e2e-session.prompt')
    const alicePrompt = await rpc(port, aliceCookie, 'session.prompt', { sessionId: 's-bob', mode: 'queue', content: [] })
    expect(alicePrompt.envelope.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(host.prompts).toEqual(['s-bob'])

    // Step 6: physical session.export — bob gets 403 for s-alice, forwards for s-bob.
    const exportDenied = await request(port, '/api/session.export?sessionId=s-alice', { headers: { Cookie: bobCookie } })
    expect(exportDenied.status).toBe(403)
    expect(exportDenied.body).toBe('forbidden')
    const exportOk = await request(port, '/api/session.export?sessionId=s-bob', { headers: { Cookie: bobCookie } })
    expect(exportOk.status).toBe(200)
    expect(exportOk.body).toBe('session log body')
    expect(host.exports).toEqual(['s-bob'])

    // Step 7: mux WebSocket — bob receives only s-bob frames; alice receives both.
    const bobFrames = await openMux(port, bobCookie)
    expect(bobFrames.map(f => f.sessionId)).toEqual(['s-bob'])
    const aliceFrames = await openMux(port, aliceCookie)
    expect(aliceFrames.map(f => f.sessionId)).toEqual(['s-alice', 's-bob'])

    // Step 8: credentials.set is a physical 403 for bob, passes for alice (admin).
    const credDenied = await postJson(port, '/api/credentials.set', { type: 'client-request', rpcId: 'e2e-cred-bob', method: 'credentials.set', payload: { ref: 'X', value: 'y' } }, bobCookie)
    expect(credDenied.status).toBe(403)
    const credOk = await rpc(port, aliceCookie, 'credentials.set', { ref: 'X', value: 'y' })
    expect(credOk.envelope.result).toMatchObject({ ok: true, value: { configured: true } })
    expect(host.calls).toContain('credentials.set')

    // Step 9: removing alice, the last admin, is refused with 409.
    const remove = await postJson(port, '/api/auth/admin/users/remove', { username: 'alice' }, aliceCookie)
    expect(remove.status).toBe(409)
    expect(remove.json).toEqual({ error: 'cannot remove the last admin' })
  })
})
