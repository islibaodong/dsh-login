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
import * as DshLogin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; port: number; distIndex: string; dataDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-entry-'))
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
    // dsh-login takes over the fallback seat; frontend-static is not
    // included because both would try to claim the fallback handler.
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
  return { ctx: context, port: context.webServer.port, distIndex, dataDir }
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

/** First-time setup: create the root admin through the setup endpoint. */
async function setupAdmin(port: number, password: string): Promise<string> {
  const res = await postJson(port, '/api/auth/setup', { username: 'root', password })
  if (res.status !== 200) throw new Error(`setup failed: ${String(res.status)}`)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('dsh-login plugin (full composition)', () => {
  it('protects the root with a redirect to /login when unauthenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('shows the setup form at /login while no user exists', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('/api/auth/setup')
    expect(res.body).toContain('name="username"')
  })

  it('shows the login form (with username field) once users exist', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    await setupAdmin(port, 's3cret')
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('/api/auth/login')
    expect(res.body).toContain('name="username"')
    expect(res.body).not.toContain('/api/auth/setup')
  })

  it('completes setup -> logout -> username login -> access -> logout', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()

    const setupCookie = await setupAdmin(port, 's3cret')
    expect(setupCookie).toContain('dsh_session=')
    expect((await request(port, '/', { headers: { Cookie: setupCookie } })).status).toBe(200)

    // End the setup session, then log in through the normal flow.
    await postJson(port, '/api/auth/logout', {}, setupCookie)
    expect((await request(port, '/', { headers: { Cookie: setupCookie } })).status).toBe(302)

    const bad = await postJson(port, '/api/auth/login', { username: 'root', password: 'wrong' })
    expect(bad.status).toBe(401)

    const missing = await postJson(port, '/api/auth/login', { password: 's3cret' })
    expect(missing.status).toBe(400)

    const login = await postJson(port, '/api/auth/login', { username: 'root', password: 's3cret' })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!

    const after = await request(port, '/', { headers: { Cookie: cookie } })
    expect(after.status).toBe(200)
    expect(after.body).toContain('shell')

    expect((await postJson(port, '/api/auth/logout', {}, cookie)).status).toBe(200)
    expect((await request(port, '/', { headers: { Cookie: cookie } })).status).toBe(302)
  })

  it('serves /api/auth/me for the live session', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const cookie = await setupAdmin(port, 's3cret')
    const me = await request(port, '/api/auth/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body)).toEqual({ username: 'root', isAdmin: true })
    const anon = await request(port, '/api/auth/me')
    expect(anon.status).toBe(401)
  })

  it('serves /admin and the admin JSON routes for admins', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const anon = await request(port, '/admin')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/login')

    const cookie = await setupAdmin(port, 's3cret')
    const page = await request(port, '/admin', { headers: { Cookie: cookie } })
    expect(page.status).toBe(200)
    expect(page.body).toContain('/api/auth/admin/users')

    const created = await postJson(port, '/api/auth/admin/users', { username: 'alice', password: 'apw' }, cookie)
    expect(created.status).toBe(201)

    const list = await request(port, '/api/auth/admin/users', { headers: { Cookie: cookie } })
    expect(list.status).toBe(200)
    const body = JSON.parse(list.body) as { users: Array<{ username: string }> }
    expect(body.users.map(u => u.username).sort()).toEqual(['alice', 'root'])
  })

  it('mounts the connection takeover on the /api prefix', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const cookie = await setupAdmin(port, 's3cret')

    // The takeover's /api prefix route answers before any session check:
    // apiProxy is absent in this composition, so both anonymous and authed
    // POSTs reach its `api === undefined` → 404 arm. Without the takeover,
    // the gateway fallback would answer 405 for a POST (fallback-only
    // semantics) — 404 proves the second plugin's route is mounted.
    const anon = await request(port, '/api/sessions.list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(anon.status).toBe(404)
    const authed = await request(port, '/api/sessions.list', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })
    expect(authed.status).toBe(404)
  })
})
