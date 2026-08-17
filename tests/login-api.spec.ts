import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { createLoginHandler, createLogoutHandler } from '../src/login-api.ts'
import type { Config } from '../src/config.ts'
import { COOKIE_NAME, extractSessionToken } from '../src/auth.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const config: Config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '/nonexistent/index.html',
  sessionTtl: 3600,
  enabled: true,
}

async function bootWithCreds(seed: Record<string, string> = {}): Promise<{ ctx: Context; port: number }> {
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
  await context.plugin(MemoryCredentials, seed)
  return { ctx: context, port: context.webServer.port }
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

describe('POST /api/auth/login', () => {
  it('returns 200 with Set-Cookie on correct password', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 's3cret' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie!).toContain('dsh_session=')
    expect(setCookie!).toContain('HttpOnly')
    expect(setCookie!).toContain('Max-Age=3600')
  })

  it('returns 401 on wrong password', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'invalid credentials' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 500 when password is not configured', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({})
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 'anything' })
    expect(res.status).toBe(500)
    expect(res.json).toEqual({ error: 'password not configured' })
  })

  it('returns 400 on malformed JSON body', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when password field is missing', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { notpassword: 'x' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const loginHandler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler: loginHandler }), 'login')
    const loginRes = await postJson(port, '/api/auth/login', { password: 's3cret' })
    const setCookie = loginRes.headers.get('set-cookie')!
    const token = extractSessionToken(setCookie.split(';')[0])!

    const logoutHandler = createLogoutHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler: logoutHandler }), 'logout')
    const res = await postJson(port, '/api/auth/logout', {}, `${COOKIE_NAME}=${token}`)
    expect(res.status).toBe(200)
    const clearCookie = res.headers.get('set-cookie')
    expect(clearCookie).not.toBeNull()
    expect(clearCookie!).toContain('Max-Age=0')
    expect(store.verify(token)).toBe(false)
  })

  it('returns 200 even without a session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLogoutHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler }), 'logout')
    const res = await postJson(port, '/api/auth/logout', {})
    expect(res.status).toBe(200)
  })
})
