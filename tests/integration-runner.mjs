// Integration test runner for dsh-login plugin.
// Boots a real WebServer with the Cordis Loader, registers routes,
// and exercises the full authentication flow via HTTP.
//
// This avoids vitest/vite's esbuild binary (blocked by sandbox) by
// running assertions directly. The .spec.ts files are the canonical
// vitest tests; this runner is the sandbox-compatible execution harness.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_ROOT = process.env.DSH_ROOT || 'E:/code/deepseek-harness'

// Link DSH packages into node_modules
const { mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } = await import('node:fs')
const PKG_MAP = {
  '@deepseek-ai/cordis': join(DSH_ROOT, 'vendor/cordis/src'),
  '@deepseek-ai/cosmokit': join(DSH_ROOT, 'vendor/cosmokit/src'),
  '@deepseek-ai/schemastery': join(DSH_ROOT, 'vendor/schemastery/src'),
  '@deepseek-ai/cordis-plugin-loader': join(DSH_ROOT, 'vendor/loader/src'),
  '@deepseek-ai/cordis-plugin-include': join(DSH_ROOT, 'vendor/include/src'),
  '@deepseek-ai/dsh-host-webserver': join(DSH_ROOT, 'packages/host/webserver/src'),
  '@deepseek-ai/dsh-host-frontend-static': join(DSH_ROOT, 'packages/host/frontend-static/src'),
  '@deepseek-ai/dsh-credentials': join(DSH_ROOT, 'packages/credentials/credentials/src'),
  '@deepseek-ai/dsh-invariants': join(DSH_ROOT, 'packages/runtime-diagnostics/invariants/src'),
}
for (const [pkg, srcPath] of Object.entries(PKG_MAP)) {
  const linkPath = join(process.cwd(), 'node_modules', pkg)
  const linkDir = linkPath.replace(/[/\\][^/\\]+$/, '')
  mkdirSync(linkDir, { recursive: true })
  let stat
  try { stat = lstatSync(linkPath) } catch { stat = undefined }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) continue
    if (readlinkSync(linkPath) === srcPath) continue
    unlinkSync(linkPath)
  }
  try { symlinkSync(srcPath, linkPath, 'junction') } catch (e) { if (e.code !== 'EEXIST') throw e }
}

let passed = 0
let failed = 0
const failures = []

function assert(condition, message) {
  if (condition) { passed++ }
  else { failed++; failures.push(message); console.error(`FAIL: ${message}`) }
}

async function bootServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-integ-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'))
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
  const HttpServer = (await import('@deepseek-ai/dsh-host-webserver')).default
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([['@deepseek-ai/dsh-host-webserver', HttpServer]])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, port: ctx.webServer.port, root }
}

async function bootWithCreds(seed = {}) {
  const { ctx, port, root } = await bootServer()
  const { MemoryCredentials } = await import('./memory-credentials.ts')
  await ctx.plugin(MemoryCredentials, seed)
  return { ctx, port, root }
}

async function request(port, path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function postJson(port, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  let json = null
  const text = await res.text()
  if (text.length > 0) { try { json = JSON.parse(text) } catch {} }
  return { status: res.status, json, headers: res.headers }
}

const config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '/nonexistent/index.html',
  sessionTtl: 3600,
  enabled: true,
}

// === Gateway tests ===
console.log('\n--- Gateway Tests ---')

// Test: redirects unauthenticated to /login
{
  const { ctx, port, root } = await bootServer()
  const { SessionStore } = await import('./../src/session.ts')
  const { createGatewayHandler } = await import('./../src/gateway.ts')
  const store = new SessionStore(3600)
  const handler = createGatewayHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
  const res = await request(port, '/')
  assert(res.status === 302, 'gateway: redirect unauth to /login (status)')
  assert(res.headers.get('location') === '/login', 'gateway: redirect location /login')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: serves static files when authenticated
{
  const { ctx, port, root } = await bootServer()
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>shell</body></html>')
  const { SessionStore } = await import('./../src/session.ts')
  const { createGatewayHandler } = await import('./../src/gateway.ts')
  const store = new SessionStore(3600)
  const session = store.create()
  const cfg = { ...config, distIndex }
  const handler = createGatewayHandler(ctx, cfg, store)
  ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
  const res = await request(port, '/', { headers: { Cookie: `dsh_session=${session.token}` } })
  assert(res.status === 200, 'gateway: serve auth request (status)')
  assert(res.body.includes('shell'), 'gateway: serve auth request (body)')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: redirects when cookie is invalid
{
  const { ctx, port, root } = await bootServer()
  const { SessionStore } = await import('./../src/session.ts')
  const { createGatewayHandler } = await import('./../src/gateway.ts')
  const store = new SessionStore(3600)
  const handler = createGatewayHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
  const res = await request(port, '/', { headers: { Cookie: 'dsh_session=invalidtoken' } })
  assert(res.status === 302, 'gateway: redirect invalid cookie (status)')
  assert(res.headers.get('location') === '/login', 'gateway: redirect invalid cookie (location)')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: SPA fallback
{
  const { ctx, port, root } = await bootServer()
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>spa-fallback</body></html>')
  const { SessionStore } = await import('./../src/session.ts')
  const { createGatewayHandler } = await import('./../src/gateway.ts')
  const store = new SessionStore(3600)
  const session = store.create()
  const cfg = { ...config, distIndex }
  const handler = createGatewayHandler(ctx, cfg, store)
  ctx.effect(() => ctx.webServer.registerFallback(handler), 'gateway')
  const res = await request(port, '/some/spa/route', { headers: { Cookie: `dsh_session=${session.token}` } })
  assert(res.status === 200, 'gateway: SPA fallback (status)')
  assert(res.body.includes('spa-fallback'), 'gateway: SPA fallback (body)')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// === Login API tests ===
console.log('\n--- Login API Tests ---')

// Test: login success
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
  const res = await postJson(port, '/api/auth/login', { password: 's3cret' })
  assert(res.status === 200, 'login: 200 on correct password')
  assert(JSON.stringify(res.json) === JSON.stringify({ ok: true }), 'login: ok response')
  const setCookie = res.headers.get('set-cookie')
  assert(setCookie !== null, 'login: Set-Cookie present')
  assert(setCookie.includes('dsh_session='), 'login: cookie has session name')
  assert(setCookie.includes('HttpOnly'), 'login: cookie is HttpOnly')
  assert(setCookie.includes('Max-Age=3600'), 'login: cookie has Max-Age')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: login wrong password
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
  const res = await postJson(port, '/api/auth/login', { password: 'wrong' })
  assert(res.status === 401, 'login: 401 on wrong password')
  assert(JSON.stringify(res.json) === JSON.stringify({ error: 'invalid credentials' }), 'login: error response')
  assert(res.headers.get('set-cookie') === null, 'login: no cookie on failure')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: login password not configured
{
  const { ctx, port, root } = await bootWithCreds({})
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
  const res = await postJson(port, '/api/auth/login', { password: 'anything' })
  assert(res.status === 500, 'login: 500 when password not configured')
  assert(JSON.stringify(res.json) === JSON.stringify({ error: 'password not configured' }), 'login: not configured error')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: login malformed body
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  })
  assert(res.status === 400, 'login: 400 on malformed JSON')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: login missing password field
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
  const res = await postJson(port, '/api/auth/login', { notpassword: 'x' })
  assert(res.status === 400, 'login: 400 on missing password field')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: logout
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLoginHandler, createLogoutHandler } = await import('./../src/login-api.ts')
  const { extractSessionToken, COOKIE_NAME } = await import('./../src/auth.ts')
  const store = new SessionStore(3600)
  const loginHandler = createLoginHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler: loginHandler }), 'login')
  const loginRes = await postJson(port, '/api/auth/login', { password: 's3cret' })
  const setCookie = loginRes.headers.get('set-cookie')
  const token = extractSessionToken(setCookie.split(';')[0])

  const logoutHandler = createLogoutHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler: logoutHandler }), 'logout')
  const res = await postJson(port, '/api/auth/logout', {}, `${COOKIE_NAME}=${token}`)
  assert(res.status === 200, 'logout: 200 status')
  const clearCookie = res.headers.get('set-cookie')
  assert(clearCookie !== null, 'logout: Set-Cookie present')
  assert(clearCookie.includes('Max-Age=0'), 'logout: cookie cleared')
  assert(store.verify(token) === false, 'logout: session revoked')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: logout without cookie
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
  const { SessionStore } = await import('./../src/session.ts')
  const { createLogoutHandler } = await import('./../src/login-api.ts')
  const store = new SessionStore(3600)
  const handler = createLogoutHandler(ctx, config, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler }), 'logout')
  const res = await postJson(port, '/api/auth/logout', {})
  assert(res.status === 200, 'logout: 200 without cookie')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// === Setup API tests (first-time password) ===
console.log('\n--- Setup API Tests (First-Time Password) ---')

// Test: setup succeeds when no password configured
{
  const { ctx, port, root } = await bootWithCreds({})  // no password seeded
  const { createSetupHandler } = await import('./../src/login-api.ts')
  const handler = createSetupHandler(ctx, config)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/setup', handler }), 'setup')
  const res = await postJson(port, '/api/auth/setup', { password: 'newpass' })
  assert(res.status === 200, 'setup: 200 on first set')
  assert(JSON.stringify(res.json) === JSON.stringify({ ok: true }), 'setup: ok response')
  // Verify the password was actually stored
  const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
  const resolved = await ctx.credentials.resolve(credentialRef('DSH_LOGIN_PASSWORD'))
  assert(resolved !== undefined, 'setup: password stored in credentials')
  assert(resolved.value === 'newpass', 'setup: stored value matches')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: setup returns 403 when password already set
{
  const { ctx, port, root } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 'existing' })
  const { createSetupHandler } = await import('./../src/login-api.ts')
  const handler = createSetupHandler(ctx, config)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/setup', handler }), 'setup')
  const res = await postJson(port, '/api/auth/setup', { password: 'hijack' })
  assert(res.status === 403, 'setup: 403 when password already set')
  assert(JSON.stringify(res.json) === JSON.stringify({ error: 'password already set' }), 'setup: error message')
  // Verify original password unchanged
  const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
  const resolved = await ctx.credentials.resolve(credentialRef('DSH_LOGIN_PASSWORD'))
  assert(resolved.value === 'existing', 'setup: original password unchanged')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: setup returns 400 on empty password
{
  const { ctx, port, root } = await bootWithCreds({})
  const { createSetupHandler } = await import('./../src/login-api.ts')
  const handler = createSetupHandler(ctx, config)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/setup', handler }), 'setup')
  const res = await postJson(port, '/api/auth/setup', { password: '' })
  assert(res.status === 400, 'setup: 400 on empty password')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: setup returns 400 on malformed body
{
  const { ctx, port, root } = await bootWithCreds({})
  const { createSetupHandler } = await import('./../src/login-api.ts')
  const handler = createSetupHandler(ctx, config)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/setup', handler }), 'setup')
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  })
  assert(res.status === 400, 'setup: 400 on malformed JSON')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// === Plugin Entry (full composition) tests ===
console.log('\n--- Plugin Entry (Full Composition) Tests ---')

async function loadComposition(seed = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-'))
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
    // dsh-login takes over the fallback seat from frontend-static.
    // Including both would cause "fallback already registered" since
    // frontend-static claims it first.
    "- id: login",
    "  name: '@deepseek-ai/dsh-login'",
    '  config:',
    '    password: DSH_LOGIN_PASSWORD',
    `    distIndex: '${distIndex}'`,
    '    sessionTtl: 3600',
    '    enabled: true',
    '',
  ].join('\n'))
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
  const HttpServer = (await import('@deepseek-ai/dsh-host-webserver')).default
  const FrontendStatic = await import('@deepseek-ai/dsh-host-frontend-static')
  const DshLogin = await import('./../src/index.ts')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
    ['@deepseek-ai/dsh-login', DshLogin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const { MemoryCredentials } = await import('./memory-credentials.ts')
  await ctx.plugin(MemoryCredentials, seed)
  return { ctx, port: ctx.webServer.port, distIndex, root }
}

async function doLogin(port, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  })
  return res.headers.get('set-cookie').split(';')[0]
}

// Test: protects root
{
  const { ctx, port, root } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
  const res = await request(port, '/')
  assert(res.status === 302, 'plugin: redirect unauth root')
  assert(res.headers.get('location') === '/login', 'plugin: redirect to /login')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: serves login page
{
  const { ctx, port, root } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
  const res = await request(port, '/login')
  assert(res.status === 200, 'plugin: /login status')
  assert(res.body.includes('password'), 'plugin: /login has password')
  assert(res.body.includes('/api/auth/login'), 'plugin: /login has endpoint')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: full login -> access -> logout flow
{
  const { ctx, port, root } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
  const before = await request(port, '/')
  assert(before.status === 302, 'plugin: flow - before login redirect')

  const cookie = await doLogin(port, 's3cret')
  assert(cookie.includes('dsh_session='), 'plugin: flow - login sets cookie')

  const after = await request(port, '/', { headers: { Cookie: cookie } })
  assert(after.status === 200, 'plugin: flow - after login access')
  assert(after.body.includes('shell'), 'plugin: flow - after login body')

  const logoutRes = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
  })
  assert(logoutRes.status === 200, 'plugin: flow - logout status')

  const afterLogout = await request(port, '/', { headers: { Cookie: cookie } })
  assert(afterLogout.status === 302, 'plugin: flow - after logout redirect')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: serves static assets when authenticated
{
  const { ctx, port, root } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
  const cookie = await doLogin(port, 's3cret')
  const res = await request(port, '/index.html', { headers: { Cookie: cookie } })
  assert(res.status === 200, 'plugin: static asset access')
  assert(res.body.includes('shell'), 'plugin: static asset body')
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: first-time setup flow (no password -> setup page -> set -> login)
{
  const { ctx, port, root } = await loadComposition({})  // no password seeded

  // /login should show the setup page (not the login form)
  const loginPage = await request(port, '/login')
  assert(loginPage.status === 200, 'plugin: setup - /login status')
  assert(loginPage.body.includes('/api/auth/setup'), 'plugin: setup - has setup endpoint')
  assert(loginPage.body.includes('Set Password'), 'plugin: setup - has Set Password button')
  assert(!loginPage.body.includes('/api/auth/login'), 'plugin: setup - no login endpoint in setup mode')

  // Setup: set the password
  const setupRes = await postJson(port, '/api/auth/setup', { password: 'mynewpass' })
  assert(setupRes.status === 200, 'plugin: setup - 200 on set password')
  assert(JSON.stringify(setupRes.json) === JSON.stringify({ ok: true }), 'plugin: setup - ok response')

  // Now /login should show the normal login form (not setup)
  const afterSetup = await request(port, '/login')
  assert(afterSetup.body.includes('/api/auth/login'), 'plugin: setup - /login shows login form after setup')
  assert(afterSetup.body.includes('Login'), 'plugin: setup - has Login button')
  assert(!afterSetup.body.includes('Set Password'), 'plugin: setup - no Set Password after configured')

  // Login with the newly set password
  const cookie = await doLogin(port, 'mynewpass')
  assert(cookie.includes('dsh_session='), 'plugin: setup - can login after setup')

  // Access protected content
  const protectedRes = await request(port, '/', { headers: { Cookie: cookie } })
  assert(protectedRes.status === 200, 'plugin: setup - access after setup login')
  assert(protectedRes.body.includes('shell'), 'plugin: setup - body after setup login')

  // Setup endpoint should now return 403 (password already set)
  const hijackRes = await postJson(port, '/api/auth/setup', { password: 'hijack' })
  assert(hijackRes.status === 403, 'plugin: setup - 403 after password already set')

  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Test: shipped cordis.patch.yml applies correctly to a web-app-like base
// (regression: rows must be inserted via `- insert:`, and the disabled key
// is `disabled`, not `disable`; the old top-level row form was a silent no-op)
{
  const { entryListSchema, applyEntryPatches } = await import('@deepseek-ai/cordis-plugin-include')
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const yaml = createRequire(join(DSH_ROOT, 'package.json'))('js-yaml')

  const patchText = await readFile(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  const patches = yaml.load(patchText, { schema: entryListSchema })
  const warnings = []
  const base = [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: {} },
    { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app', config: { printUrl: true } },
  ]
  const result = applyEntryPatches(base, patches, (msg) => warnings.push(msg))

  const loginRow = result.find((e) => e.id === 'dsh-login')
  assert(loginRow !== undefined, 'patch: dsh-login row inserted')
  assert(loginRow.name === '@deepseek-ai/dsh-login', 'patch: inserted row name')
  assert(loginRow.config.password === 'DSH_LOGIN_PASSWORD', 'patch: credential ref config')
  assert(loginRow.config.takeOverWebRuntime === true, 'patch: takeOverWebRuntime config')
  const runtimeRow = result.find((e) => e.id === 'web-runtime')
  assert(runtimeRow.disabled === true, 'patch: web-runtime row disabled')
  assert(warnings.length === 0, `patch: no patch warnings (got: ${warnings.join('; ')})`)
}

console.log(`\nIntegration Tests: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
