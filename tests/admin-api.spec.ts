import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from './memory-credentials.ts'
import { SessionStore } from '../src/session.ts'
import { UserStore } from '../src/users.ts'
import { createLoginHandler } from '../src/login-api.ts'
import { createAdminRoutes } from '../src/admin-api.ts'
import { TrustedHosts } from '../src/hosts.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a real webserver plus login + all admin routes wired against ONE
 * UserStore/SessionStore pair (the shape src/index.ts composes).
 */
async function boot(seed?: { rootPassword?: string }): Promise<{
  ctx: Context
  port: number
  users: UserStore
  store: SessionStore
  hosts: TrustedHosts
}> {
  root = await mkdtemp(join(tmpdir(), 'dsh-login-admin-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-webserver', HttpServer]])
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
  const users = new UserStore(context.credentials, credentialRef('DSH_LOGIN_PASSWORD_USERS'))
  const store = new SessionStore(3600)
  const hosts = new TrustedHosts(join(root, 'trusted-hosts.json'))
  if (seed?.rootPassword !== undefined) await users.create('root', seed.rootPassword, true)
  await users.create('bob', 'bobpw', false)
  ctx_routes(context, users, store, hosts)
  return { ctx: context, port: context.webServer.port, users, store, hosts }
}

function ctx_routes(ctx: Context, users: UserStore, store: SessionStore, hosts?: TrustedHosts): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/auth/login',
    handler: createLoginHandler({ users, store, sessionTtl: 3600 }),
  }), 'login')
  for (const route of createAdminRoutes(hosts !== undefined ? { users, store, hosts } : { users, store })) {
    ctx.effect(() => ctx.webServer.register(route), `admin: ${route.path}`)
  }
}

async function req(port: number, method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie !== undefined) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    ...body !== undefined ? { body: JSON.stringify(body) } : {},
    redirect: 'manual',
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

async function loginCookie(port: number, username: string, password: string): Promise<string> {
  const res = await req(port, 'POST', '/api/auth/login', { username, password })
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${String(res.status)}`)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/auth/me', () => {
  it('returns the session user with a valid cookie', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'GET', '/api/auth/me', undefined, cookie)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ username: 'root', isAdmin: true })
  })

  it('returns 401 anonymously', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const res = await req(port, 'GET', '/api/auth/me')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/auth/admin/users', () => {
  it('lists users for an admin, with last-login stamps', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'GET', '/api/auth/admin/users', undefined, cookie)
    expect(res.status).toBe(200)
    const body = res.json as { users: Array<{ username: string; isAdmin: boolean; lastLoginAt: number | null }> }
    expect(body.users.map(u => u.username).sort()).toEqual(['bob', 'root'])
    for (const u of body.users) {
      expect(typeof u.isAdmin).toBe('boolean')
    }
    // root just logged in (loginCookie); bob never did since the feature shipped.
    const root = body.users.find(u => u.username === 'root')!
    const bob = body.users.find(u => u.username === 'bob')!
    expect(typeof root.lastLoginAt).toBe('number')
    expect(bob.lastLoginAt).toBeNull()
    // Logging in stamps bob's record.
    await loginCookie(port, 'bob', 'bobpw')
    const res2 = await req(port, 'GET', '/api/auth/admin/users', undefined, cookie)
    const body2 = res2.json as typeof body
    expect(typeof body2.users.find(u => u.username === 'bob')!.lastLoginAt).toBe('number')
  })

  it('returns 403 for an ordinary user', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'bob', 'bobpw')
    const res = await req(port, 'GET', '/api/auth/admin/users', undefined, cookie)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/auth/admin/users', () => {
  it('creates a user as admin (201), who can then log in', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'POST', '/api/auth/admin/users', { username: 'carol', password: 'cpw', isAdmin: false }, cookie)
    expect(res.status).toBe(201)
    expect(res.json).toEqual({ ok: true })
    const record = (await users.list()).find(u => u.username === 'carol')
    expect(record).toMatchObject({ username: 'carol', isAdmin: false })
    const login = await req(port, 'POST', '/api/auth/login', { username: 'carol', password: 'cpw' })
    expect(login.status).toBe(200)
  })

  it('returns 403 for an ordinary user', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'bob', 'bobpw')
    const res = await req(port, 'POST', '/api/auth/admin/users', { username: 'carol', password: 'cpw' }, cookie)
    expect(res.status).toBe(403)
    expect((await users.list()).some(u => u.username === 'carol')).toBe(false)
  })

  it('returns 409 on duplicate and 400 on invalid input', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/users', { username: 'bob', password: 'x' }, cookie)).status).toBe(409)
    expect((await req(port, 'POST', '/api/auth/admin/users', { username: 'new', password: '' }, cookie)).status).toBe(400)
    expect((await req(port, 'POST', '/api/auth/admin/users', { username: 'bad name', password: 'x' }, cookie)).status).toBe(400)
  })
})

describe('POST /api/auth/admin/users/password', () => {
  it('changes a password; the new one logs in and the old one stops working', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'POST', '/api/auth/admin/users/password', { username: 'bob', password: 'newpw' }, cookie)
    expect(res.status).toBe(200)
    expect((await req(port, 'POST', '/api/auth/login', { username: 'bob', password: 'newpw' })).status).toBe(200)
    expect((await req(port, 'POST', '/api/auth/login', { username: 'bob', password: 'bobpw' })).status).toBe(401)
  })

  it('revokes the password-changed user\'s live sessions (old cookie → 401)', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(200)
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/users/password', { username: 'bob', password: 'newpw' }, rootCookie)).status).toBe(200)
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(401)
    // The admin's own session survives the change.
    expect((await req(port, 'GET', '/api/auth/me', undefined, rootCookie)).status).toBe(200)
  })

  it('returns 404 for an unknown user and 400 for an empty password', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/users/password', { username: 'nobody', password: 'x' }, cookie)).status).toBe(404)
    expect((await req(port, 'POST', '/api/auth/admin/users/password', { username: 'bob', password: '' }, cookie)).status).toBe(400)
  })
})

describe('POST /api/auth/admin/users/remove', () => {
  it('removes an ordinary user', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'bob' }, cookie)
    expect(res.status).toBe(200)
    expect((await users.list()).some(u => u.username === 'bob')).toBe(false)
  })

  it('revokes the removed user\'s live sessions (old cookie → 401 on /api/auth/me)', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(200)
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'bob' }, rootCookie)).status).toBe(200)
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(401)
    // The admin's own session survives the removal.
    expect((await req(port, 'GET', '/api/auth/me', undefined, rootCookie)).status).toBe(200)
  })

  it('refuses to remove the last admin (409)', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'root' }, cookie)
    expect(res.status).toBe(409)
    expect((await users.list()).some(u => u.username === 'root')).toBe(true)
  })

  it('allows removing an admin when another admin remains, and 404s unknown users', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    await req(port, 'POST', '/api/auth/admin/users', { username: 'root2', password: 'pw', isAdmin: true }, cookie)
    expect((await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'root2' }, cookie)).status).toBe(200)
    expect((await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'ghost' }, cookie)).status).toBe(404)
    expect(await users.list()).toHaveLength(2)
  })

  it('returns 403 for an ordinary user', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'bob', 'bobpw')
    const res = await req(port, 'POST', '/api/auth/admin/users/remove', { username: 'root' }, cookie)
    expect(res.status).toBe(403)
    expect(await users.list()).toHaveLength(2)
  })
})

describe('GET /api/auth/admin/users (status fields)', () => {
  it('reports onlineSessions and disabled per user', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    const res = await req(port, 'GET', '/api/auth/admin/users', undefined, rootCookie)
    expect(res.status).toBe(200)
    const body = res.json as { users: Array<{ username: string; onlineSessions: number; disabled: boolean }> }
    const root = body.users.find(u => u.username === 'root')!
    const bob = body.users.find(u => u.username === 'bob')!
    expect(root.onlineSessions).toBeGreaterThanOrEqual(1)
    expect(bob.onlineSessions).toBeGreaterThanOrEqual(1)
    expect(root.disabled).toBe(false)
    expect(bob.disabled).toBe(false)
    void bobCookie
  })
})

describe('POST /api/auth/admin/users/disable', () => {
  it('disables a user: login rejected, live sessions revoked', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(200)
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    const res = await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob', disabled: true }, rootCookie)
    expect(res.status).toBe(200)
    // Cookie dead, fresh login rejected with the generic invalid-credentials 401.
    expect((await req(port, 'GET', '/api/auth/me', undefined, bobCookie)).status).toBe(401)
    expect((await req(port, 'POST', '/api/auth/login', { username: 'bob', password: 'bobpw' })).status).toBe(401)
    expect((await users.list()).find(u => u.username === 'bob')?.disabled).toBe(true)
  })

  it('re-enables a disabled user who can then log in again', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob', disabled: true }, rootCookie)
    expect((await req(port, 'POST', '/api/auth/login', { username: 'bob', password: 'bobpw' })).status).toBe(401)
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob', disabled: false }, rootCookie)).status).toBe(200)
    expect((await req(port, 'POST', '/api/auth/login', { username: 'bob', password: 'bobpw' })).status).toBe(200)
  })

  it('refuses to disable the last enabled admin (409), allows when another enabled admin remains', { timeout: 60_000 }, async () => {
    const { port, users } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    await req(port, 'POST', '/api/auth/admin/users', { username: 'root2', password: 'pw', isAdmin: true }, cookie)
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'root2', disabled: true }, cookie)).status).toBe(200)
    // root is now the last ENABLED admin — disabling them is refused.
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'root', disabled: true }, cookie)).status).toBe(409)
    expect((await users.list()).find(u => u.username === 'root')?.disabled).toBeUndefined()
    // Re-enabling root2 is always allowed (un-disabling can never lock out).
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'root2', disabled: false }, cookie)).status).toBe(200)
  })

  it('returns 404 unknown, 400 bad input, 403 for ordinary users', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'ghost', disabled: true }, rootCookie)).status).toBe(404)
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob' }, rootCookie)).status).toBe(400)
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob', disabled: 'yes' }, rootCookie)).status).toBe(400)
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    expect((await req(port, 'POST', '/api/auth/admin/users/disable', { username: 'bob', disabled: true }, bobCookie)).status).toBe(403)
  })
})

describe('/api/auth/admin/hosts', () => {
  it('lists, adds, and removes hosts for an admin and persists them', { timeout: 60_000 }, async () => {
    const { port, hosts } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    // empty initially
    expect((await req(port, 'GET', '/api/auth/admin/hosts', undefined, cookie)).json).toEqual({ hosts: [] })
    // add
    const add = await req(port, 'POST', '/api/auth/admin/hosts', { host: 'PUB.example.com' }, cookie)
    expect(add.status).toBe(201)
    // list reflects the canonical form
    expect((await req(port, 'GET', '/api/auth/admin/hosts', undefined, cookie)).json).toEqual({ hosts: ['pub.example.com'] })
    // hosts instance is updated live
    expect(hosts.has('pub.example.com')).toBe(true)
    // re-adding an existing host is idempotent (200, not 201 or 400)
    expect((await req(port, 'POST', '/api/auth/admin/hosts', { host: 'PUB.example.com' }, cookie)).status).toBe(200)
    // loopback is always already trusted → reflected as ok, never stored
    expect((await req(port, 'POST', '/api/auth/admin/hosts', { host: '127.0.0.1' }, cookie)).status).toBe(200)
    expect(hosts.has('127.0.0.1')).toBe(false)
    expect((await req(port, 'GET', '/api/auth/admin/hosts', undefined, cookie)).json).toEqual({ hosts: ['pub.example.com'] })
    // remove
    const del = await req(port, 'DELETE', '/api/auth/admin/hosts', { host: 'pub.example.com' }, cookie)
    expect(del.status).toBe(200)
    expect((await req(port, 'GET', '/api/auth/admin/hosts', undefined, cookie)).json).toEqual({ hosts: [] })
    await hosts.flush()
  })

  it('rejects invalid hosts (400) and is admin-gated (403/401)', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const rootCookie = await loginCookie(port, 'root', 'rootpw')
    expect((await req(port, 'POST', '/api/auth/admin/hosts', { host: 'not a host with spaces!' }, rootCookie)).status).toBe(400)
    expect((await req(port, 'POST', '/api/auth/admin/hosts', { host: '' }, rootCookie)).status).toBe(400)
    // ordinary user → 403
    const bobCookie = await loginCookie(port, 'bob', 'bobpw')
    expect((await req(port, 'GET', '/api/auth/admin/hosts', undefined, bobCookie)).status).toBe(403)
    expect((await req(port, 'POST', '/api/auth/admin/hosts', { host: 'a.example.com' }, bobCookie)).status).toBe(403)
    // anonymous → 401
    expect((await req(port, 'GET', '/api/auth/admin/hosts')).status).toBe(401)
  })
})

describe('GET /admin (removed standalone page)', () => {
  it('no longer registers a route: the path falls through unclaimed', { timeout: 60_000 }, async () => {
    const { port } = await boot({ rootPassword: 'rootpw' })
    const cookie = await loginCookie(port, 'root', 'rootpw')
    // User management moved into the GUI settings panel; without the old
    // exact route (and with no gateway fallback in this harness) the
    // webserver itself answers 404 for admin and ordinary sessions alike.
    expect((await req(port, 'GET', '/admin', undefined, cookie)).status).toBe(404)
    expect((await req(port, 'GET', '/admin')).status).toBe(404)
  })
})
