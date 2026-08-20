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
import { createLoginHandler, createLogoutHandler, createLogoutRedirectHandler, createSetupHandler } from '../src/login-api.ts'
import { COOKIE_NAME, extractSessionToken } from '../src/auth.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootWithCreds(): Promise<{ ctx: Context; port: number; users: UserStore }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-login-api-'))
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
  return { ctx: context, port: context.webServer.port, users }
}

async function postJson(port: number, path: string, body: unknown, cookie?: string): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie !== undefined) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let json: unknown = null
  const text = await res.text()
  if (text.length > 0) {
    try { json = JSON.parse(text) } catch { /* not JSON */ }
  }
  return { status: res.status, json, headers: res.headers }
}

/** Register login/logout/setup/admin-free routes exactly like src/index.ts does. */
async function registerAuthRoutes(ctx: Context, users: UserStore, store: SessionStore): Promise<void> {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/auth/login',
    handler: createLoginHandler({ users, store, sessionTtl: 3600 }),
  }), 'login')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/auth/logout',
    handler: createLogoutHandler(store),
  }), 'logout')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/logout',
    handler: createLogoutRedirectHandler(store),
  }), 'logout redirect')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/auth/setup',
    handler: createSetupHandler({ users, store, sessionTtl: 3600 }),
  }), 'setup')
}

describe('POST /api/auth/login', () => {
  it('returns 200 with Set-Cookie on correct username/password', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    const store = new SessionStore(3600)
    await registerAuthRoutes(ctx, users, store)
    const res = await postJson(port, '/api/auth/login', { username: 'alice', password: 's3cret' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie!).toContain('dsh_session=')
    expect(setCookie!).toContain('HttpOnly')
    expect(setCookie!).toContain('Max-Age=3600')
    const token = extractSessionToken(setCookie!.split(';')[0])
    expect(token).toBeDefined()
    expect(store.verify(token!)).toMatchObject({ user: 'alice', isAdmin: true })
  })

  it('returns 401 on wrong password', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/login', { username: 'alice', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'invalid credentials' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 401 on unknown username', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/login', { username: 'mallory', password: 's3cret' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when the username field is missing', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/login', { password: 's3cret' })
    expect(res.status).toBe(400)
  })

  it('returns 500 when no user exists yet (setup mode)', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/login', { username: 'alice', password: 's3cret' })
    expect(res.status).toBe(500)
  })

  it('returns 400 on malformed JSON body', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/setup', () => {
  it('creates the forced-admin account when the store is empty and logs it in', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    const store = new SessionStore(3600)
    await registerAuthRoutes(ctx, users, store)
    const res = await postJson(port, '/api/auth/setup', { username: 'root', password: 'pw123' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const records = await users.list()
    expect(records).toHaveLength(1)
    expect(records[0]!).toMatchObject({ username: 'root', isAdmin: true })
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('dsh_session=')
    const token = extractSessionToken(setCookie!.split(';')[0])
    expect(store.verify(token!)).toMatchObject({ user: 'root', isAdmin: true })
  })

  it('returns 403 when users already exist', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('root', 'pw', true)
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/setup', { username: 'eve', password: 'pw' })
    expect(res.status).toBe(403)
    expect(await users.list()).toHaveLength(1)
  })

  it('returns 400 on missing username or empty password', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    expect((await postJson(port, '/api/auth/setup', { password: 'pw' })).status).toBe(400)
    expect((await postJson(port, '/api/auth/setup', { username: 'root' })).status).toBe(400)
    expect((await postJson(port, '/api/auth/setup', { username: 'bad name!', password: 'pw' })).status).toBe(400)
    expect(await users.isEmpty()).toBe(true)
  })
})

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    const store = new SessionStore(3600)
    await registerAuthRoutes(ctx, users, store)
    const loginRes = await postJson(port, '/api/auth/login', { username: 'alice', password: 's3cret' })
    const setCookie = loginRes.headers.get('set-cookie')!
    const token = extractSessionToken(setCookie.split(';')[0])!

    const res = await postJson(port, '/api/auth/logout', {}, `${COOKIE_NAME}=${token}`)
    expect(res.status).toBe(200)
    const clearCookie = res.headers.get('set-cookie')
    expect(clearCookie).not.toBeNull()
    expect(clearCookie!).toContain('Max-Age=0')
    expect(store.verify(token)).toBeUndefined()
  })

  it('returns 200 even without a session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await postJson(port, '/api/auth/logout', {})
    expect(res.status).toBe(200)
  })
})

describe('GET /logout', () => {
  it('revokes the session, clears the cookie, and redirects to /login', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await users.create('alice', 's3cret', true)
    const store = new SessionStore(3600)
    await registerAuthRoutes(ctx, users, store)
    const loginRes = await postJson(port, '/api/auth/login', { username: 'alice', password: 's3cret' })
    const token = extractSessionToken(loginRes.headers.get('set-cookie')!.split(';')[0])!

    const res = await fetch(`http://127.0.0.1:${String(port)}/logout`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(store.verify(token)).toBeUndefined()
  })

  it('redirects to /login anonymously without error', { timeout: 60_000 }, async () => {
    const { ctx, port, users } = await bootWithCreds()
    await registerAuthRoutes(ctx, users, new SessionStore(3600))
    const res = await fetch(`http://127.0.0.1:${String(port)}/logout`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })
})
