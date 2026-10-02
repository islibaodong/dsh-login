import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

  it('returns 404 for unknown paths when authenticated (hash-routed shell)', { timeout: 60_000 }, async () => {
    // Harness 0.1.1-rc.1 removed frontend-static's SPA fallback: the web shell
    // is hash-routed and only '/' and the configured index path serve HTML,
    // every miss is a plain 404. The gateway delegates to serveStatic and
    // inherits the same semantics.
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
    const res = await request(port, '/some/spa/route', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(404)
  })

  it('renders the structured index injection table (boot manifest)', { timeout: 60_000 }, async () => {
    // Regression for harness 0.1.1-rc.1: the boot manifest (the
    // window.__ModuleLoader__ queue facade and window.__DSH_BOOT__) moved from
    // raw tapIndex transforms into the structured injection table, rendered
    // only by webServer.renderIndex. A gateway that still calls
    // applyIndexTaps alone serves an index with no module loader and the shell
    // fails with "web boot: window.__ModuleLoader__ bootstrap facade is
    // missing". The gateway must render through whichever pipeline exists.
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><head></head><body>shell</body></html>')
    const store = new SessionStore(3600)
    const session = store.create('alice', true)
    const cfg = { ...config, distIndex }
    const handler = createGatewayHandler(ctx, cfg, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: 'window.__ModuleLoader__ = { marker: true }' })
      table.push({ kind: 'global', name: '__DSH_BOOT__', value: { marker: true } })
    })
    const res = await request(port, '/', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('window.__ModuleLoader__ = { marker: true }')
    expect(res.body).toContain('globalThis["__DSH_BOOT__"]')
  })

  it('serves the shell dist verbatim apart from the framework boot manifest', { timeout: 60_000 }, async () => {
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
    // dsh-login adds no DOM of its own; the served index is the shell's body
    // plus whatever the framework's renderIndex boot-manifest injects (the
    // sibling "renders structured injection" test pins that pipeline).
    expect(res.body).toContain('shell')
    expect(res.body).toContain('<html')
  })
})

/**
 * The upstream Connection service dsh-login's index handshake forwards to.
 * The core dsh-client-connection provides HostConnectionService: the real
 * BrowserAuth lives in its `browserAuth` field, whose `authorizeIndex` only
 * mints the authority-bound browser cookie during the `GET /?token=`
 * exchange and answers every cookie-less request with its plain-text 401.
 */
describe('gateway authorizeIndex: core browser-auth handshake (issue #3)', () => {
  interface FakeConnectionOptions {
    /** Whether the core browser cookie is present and valid on requests. */
    coreCookie?: boolean
    /** The process launch token exposed by browserAuth ('' = unusable). */
    launchToken?: string
  }

  /**
   * Provide a fake upstream `connection` service that mirrors the core
   * decision shape: the token exchange mints a cookie and 303s to clean
   * `./`, a valid cookie admits the index, everything else is the same
   * plain-text 401 the real BrowserAuth writes.
   */
  function provideFakeConnection(ctx: Context, options: FakeConnectionOptions): void {
    ctx.provide('connection', {
      browserAuth: {
        launchToken: options.launchToken,
        isAuthenticated: () => options.coreCookie === true,
      },
      authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        if (url.searchParams.getAll('token').length > 0) {
          res.writeHead(303, { location: './', 'set-cookie': 'dsh.browser=core-minted' })
          res.end()
          return false
        }
        if (options.coreCookie === true) return true
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
        return false
      },
    })
  }

  /** Boot the gateway over a real webserver with a dist shell and a session. */
  async function bootGateway(fake: FakeConnectionOptions): Promise<{ port: number; token: string }> {
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>shell</body></html>')
    const store = new SessionStore(3600)
    const session = store.create('alice', true)
    const handler = createGatewayHandler(ctx, { ...config, distIndex }, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    provideFakeConnection(ctx, fake)
    return { port, token: session.token }
  }

  it('bounces a logged-in fresh device through the launch-token exchange (issue #3)', { timeout: 60_000 }, async () => {
    // Fresh device: valid dsh_session, no core browser cookie, no token in
    // the URL. Forwarding the bare index request lets the core answer with
    // its plain-text 401 ("dsh web authentication required") right after a
    // successful login — the gateway must instead bounce the browser through
    // the core's launch-token exchange so the cookie gets minted.
    const { port, token } = await bootGateway({ coreCookie: false, launchToken: 'test-launch-token' })
    const res = await request(port, '/', { headers: { Cookie: `dsh_session=${token}` } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?token=test-launch-token')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('lets the forwarded token exchange mint the core cookie', { timeout: 60_000 }, async () => {
    // The follow-up redirect MUST reach the core instead of bouncing again:
    // the exchange mints the authority-bound cookie and 303s to clean `./`.
    const { port, token } = await bootGateway({ coreCookie: false, launchToken: 'test-launch-token' })
    const res = await request(port, '/?token=test-launch-token', { headers: { Cookie: `dsh_session=${token}` } })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('./')
    expect(res.headers.get('set-cookie')).toContain('dsh.browser=core-minted')
  })

  it('serves the index directly when the core browser cookie is valid', { timeout: 60_000 }, async () => {
    // Devices that already hold a valid core cookie keep the direct serve —
    // no redirect may be injected on their path.
    const { port, token } = await bootGateway({ coreCookie: true, launchToken: 'test-launch-token' })
    const res = await request(port, '/', { headers: { Cookie: `dsh_session=${token}` } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it('still forwards to a connection without the browserAuth wrapper', { timeout: 60_000 }, async () => {
    // Alternative/test connection services expose authorizeIndex directly
    // with no browserAuth field: they keep the plain forward semantics.
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>shell</body></html>')
    const store = new SessionStore(3600)
    const session = store.create('alice', true)
    const handler = createGatewayHandler(ctx, { ...config, distIndex }, store)
    ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
    ctx.provide('connection', { authorizeIndex: () => true })
    const res = await request(port, '/', { headers: { Cookie: `dsh_session=${session.token}` } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it('lets the core answer when no usable launch token is available', { timeout: 60_000 }, async () => {
    // Without a launch token dsh-login cannot route the exchange; the core's
    // own 401 must pass through untouched instead of a redirect to /?token=.
    const { port, token } = await bootGateway({ coreCookie: false, launchToken: '' })
    const res = await request(port, '/', { headers: { Cookie: `dsh_session=${token}` } })
    expect(res.status).toBe(401)
    expect(res.body).toContain('dsh web authentication required')
  })
})
