import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
import { createGatewayHandler } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootServer(): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gateway-'))
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
  return { ctx: context, port: context.webServer.port }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, redirect: 'manual' })
  return { status: response.status, body: await response.text(), headers: response.headers }
}

const config: Config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '/nonexistent/index.html',
  sessionTtl: 3600,
  enabled: true,
}

describe('gateway handler', () => {
  it('redirects unauthenticated requests to /login', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const store = new SessionStore(3600)
    const handler = createGatewayHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves static files when authenticated', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>shell</body></html>')
    const store = new SessionStore(3600)
    const session = store.create('alice', true)
    const cfg = { ...config, distIndex }
    const handler = createGatewayHandler(ctx, cfg, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    const res = await request(port, '/', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it('redirects to /login when cookie is invalid', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const store = new SessionStore(3600)
    const handler = createGatewayHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    const res = await request(port, '/', {
      headers: { Cookie: 'dsh_session=invalidtoken' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves SPA fallback (index.html) for unknown paths when authenticated', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>spa-fallback</body></html>')
    const store = new SessionStore(3600)
    const session = store.create('alice', true)
    const cfg = { ...config, distIndex }
    const handler = createGatewayHandler(ctx, cfg, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    const res = await request(port, '/some/spa/route', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('spa-fallback')
  })
})
