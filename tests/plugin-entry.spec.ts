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

async function loadComposition(seed: Record<string, string> = {}): Promise<{ ctx: Context; port: number; distIndex: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-entry-'))
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>shell</body></html>')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // dsh-login takes over the fallback seat; frontend-static is not
    // included because both would try to claim the fallback handler.
    "- id: login",
    "  name: '@deepseek-ai/dsh-login'",
    '  config:',
    '    password: DSH_LOGIN_PASSWORD',
    `    distIndex: '${distIndex}'`,
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
    ['@deepseek-ai/dsh-login', DshLogin],
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
  await context.plugin(MemoryCredentials, seed)
  return { ctx: context, port: context.webServer.port, distIndex }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function login(port: number, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const setCookie = res.headers.get('set-cookie')!
  return setCookie.split(';')[0]
}

describe('dsh-login plugin (full composition)', () => {
  it('protects the root with a redirect to /login when unauthenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves the login page at /login', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('password')
    expect(res.body).toContain('/api/auth/login')
  })

  it('completes the full login -> access -> logout flow', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })

    const before = await request(port, '/')
    expect(before.status).toBe(302)

    const cookie = await login(port, 's3cret')
    expect(cookie).toContain('dsh_session=')

    const after = await request(port, '/', { headers: { Cookie: cookie } })
    expect(after.status).toBe(200)
    expect(after.body).toContain('shell')

    const logoutRes = await fetch(`http://127.0.0.1:${String(port)}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    })
    expect(logoutRes.status).toBe(200)

    const afterLogout = await request(port, '/', { headers: { Cookie: cookie } })
    expect(afterLogout.status).toBe(302)
  })

  it('serves static assets when authenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const cookie = await login(port, 's3cret')
    const res = await request(port, '/index.html', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })
})
