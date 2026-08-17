// Minimal test runner that avoids esbuild entirely.
// Uses tsx's register hook to handle .ts imports, then runs
// assertions manually. This bypasses esbuild's binary, which the
// DSH sandbox blocks when spawned with piped stdio.
//
// Path mapping for @deepseek-ai/* packages is handled by a custom
// import resolution hook that redirects to the DSH checkout source.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DSH_ROOT = resolve(process.env.DSH_ROOT || 'E:/code/deepseek-harness')

// Map @deepseek-ai/* package names to their DSH source directories.
const PACKAGE_MAP = {
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

// Custom resolve hook for @deepseek-ai/* packages
const originalResolve = import.meta.resolve

// tsx already registers a loader; we just need to redirect imports.
// The simplest approach: create symlinks in node_modules for each package.
for (const [pkg, srcPath] of Object.entries(PACKAGE_MAP)) {
  const linkPath = join(process.cwd(), 'node_modules', pkg)
  const linkDir = linkPath.replace(/\\/g, '/')
  // Check if the symlink already exists
  try {
    const { mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } = await import('node:fs')
    mkdirSync(linkPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    let stat
    try { stat = lstatSync(linkPath) } catch { stat = undefined }
    if (stat !== undefined) {
      if (!stat.isSymbolicLink() && !stat.isDirectory()) {
        unlinkSync(linkPath)
      } else if (stat.isSymbolicLink() && readlinkSync(linkPath) === srcPath) {
        continue // already correct
      } else if (stat.isSymbolicLink()) {
        unlinkSync(linkPath)
      } else {
        continue // real directory, skip
      }
    }
    try {
      symlinkSync(srcPath, linkPath, 'junction')
    } catch (e) {
      if ((e).code !== 'EEXIST') throw e
    }
  } catch (e) {
    console.error(`Failed to link ${pkg}: ${e.message}`)
  }
}

// Now run the tests
let passed = 0
let failed = 0
const failures = []

function assert(condition, message) {
  if (condition) { passed++ }
  else { failed++; failures.push(message); console.error(`FAIL: ${message}`) }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) { passed++ }
  else {
    failed++
    failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    console.error(`FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// Test SessionStore
const { SessionStore } = await import('./../src/session.ts')

{
  const store = new SessionStore(3600)
  const session = store.create()
  assert(/^[0-9a-f]{64}$/.test(session.token), 'token is 64-char hex')
  assert(session.createdAt > 0, 'createdAt > 0')
  assertEqual(session.expiresAt, session.createdAt + 3600 * 1000, 'expiresAt = createdAt + ttl')
}
{
  const store = new SessionStore(3600)
  const session = store.create()
  assertEqual(store.verify(session.token), true, 'verify fresh session')
}
{
  const store = new SessionStore(3600)
  assertEqual(store.verify('deadbeef'), false, 'reject unknown token')
}
{
  const store = new SessionStore(3600)
  assertEqual(store.verify(''), false, 'reject empty token')
}
{
  const store = new SessionStore(3600)
  const session = store.create()
  assertEqual(store.verify(session.token), true, 'verify before revoke')
  store.revoke(session.token)
  assertEqual(store.verify(session.token), false, 'verify after revoke')
}
{
  const store = new SessionStore(3600)
  try { store.revoke('nonexistent'); passed++ } catch { failed++; failures.push('revoke unknown should not throw') }
}
{
  const store = new SessionStore(0)
  const session = store.create()
  await new Promise(r => setTimeout(r, 10))
  assertEqual(store.verify(session.token), false, 'reject expired session')
}
{
  const store = new SessionStore(0)
  store.create()
  await new Promise(r => setTimeout(r, 10))
  store.cleanup()
  try { store.cleanup(); passed++ } catch { failed++; failures.push('second cleanup should not throw') }
}
{
  const store = new SessionStore(3600)
  const tokens = new Set()
  for (let i = 0; i < 100; i++) tokens.add(store.create().token)
  assertEqual(tokens.size, 100, '100 unique tokens')
}

// Test Auth
const { COOKIE_NAME, verifyPassword, extractSessionToken, buildCookieHeader, buildClearCookieHeader } = await import('./../src/auth.ts')
assertEqual(verifyPassword('s3cret', 's3cret'), true, 'matching passwords')
assertEqual(verifyPassword('s3cret', 'wrong'), false, 'non-matching passwords')
assertEqual(verifyPassword('', 's3cret'), false, 'empty input')
assertEqual(verifyPassword('short', 'longerpassword'), false, 'different length')
assertEqual(extractSessionToken('dsh_session=abc123; other=val'), 'abc123', 'extract from multi-cookie')
assertEqual(extractSessionToken(undefined), undefined, 'missing header')
assertEqual(extractSessionToken('other=val'), undefined, 'cookie not present')
assertEqual(extractSessionToken('dsh_session=token123'), 'token123', 'only cookie')
assertEqual(extractSessionToken('other=val; dsh_session=lasttoken'), 'lasttoken', 'last cookie')
assertEqual(extractSessionToken('garbage'), undefined, 'malformed header')
assertEqual(buildCookieHeader('mytoken', 3600), 'dsh_session=mytoken; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600', 'cookie header')
assert(buildCookieHeader('tok', 604800).includes('Max-Age=604800'), 'ttl in Max-Age')
assertEqual(buildClearCookieHeader(), 'dsh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'clear cookie')
assertEqual(COOKIE_NAME, 'dsh_session', 'cookie name')

// Test Login Page
const { renderLoginPage } = await import('./../src/login-page.ts')
const html = renderLoginPage()
assert(html.includes('<!DOCTYPE html>'), 'has DOCTYPE')
assert(html.includes('</html>'), 'has closing html')
assert(html.includes('type="password"'), 'has password input')
assert(html.includes('id="password"'), 'has password id')
assert(html.includes('type="submit"'), 'has submit button')
assert(html.includes('/api/auth/login'), 'has login endpoint')
assert(html.includes("window.location"), 'has redirect')
assert(html.includes("'/'"), 'redirects to root')
assert(html.includes('401'), 'handles 401')
assert(!html.includes('src="http'), 'no external src')
assert(!html.includes('href="http'), 'no external href')
assert(!html.includes('<link'), 'no link tags')
assert(html.includes('background'), 'has background')
assert(/dark|#1|#0|#2[0-9a-f]/i.test(html), 'dark color')

console.log(`\nUnit Tests: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
