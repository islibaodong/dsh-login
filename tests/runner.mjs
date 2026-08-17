// Simple test runner that avoids esbuild entirely.
// Uses tsx's register hook to handle .ts imports, then runs
// assertions manually. This is a minimal harness for unit tests
// that don't need DSH integration.
import { register } from 'node:module'

// tsx already registered via --import tsx, so .ts imports work.

let passed = 0
let failed = 0
const failures = []

function assert(condition, message) {
  if (condition) {
    passed++
  } else {
    failed++
    failures.push(message)
    console.error(`FAIL: ${message}`)
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++
  } else {
    failed++
    failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    console.error(`FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// Test SessionStore
const { SessionStore } = await import('./../src/session.ts')

// Test 1: creates a session with a 64-char hex token
{
  const store = new SessionStore(3600)
  const session = store.create()
  assert(/^[0-9a-f]{64}$/.test(session.token), 'token is 64-char hex')
  assert(session.createdAt > 0, 'createdAt > 0')
  assertEqual(session.expiresAt, session.createdAt + 3600 * 1000, 'expiresAt = createdAt + ttl')
}

// Test 2: verifies a freshly created session
{
  const store = new SessionStore(3600)
  const session = store.create()
  assertEqual(store.verify(session.token), true, 'verify fresh session')
}

// Test 3: rejects an unknown token
{
  const store = new SessionStore(3600)
  assertEqual(store.verify('deadbeef'), false, 'reject unknown token')
}

// Test 4: rejects an empty token
{
  const store = new SessionStore(3600)
  assertEqual(store.verify(''), false, 'reject empty token')
}

// Test 5: revokes a session
{
  const store = new SessionStore(3600)
  const session = store.create()
  assertEqual(store.verify(session.token), true, 'verify before revoke')
  store.revoke(session.token)
  assertEqual(store.verify(session.token), false, 'verify after revoke')
}

// Test 6: revoking unknown is no-op
{
  const store = new SessionStore(3600)
  try {
    store.revoke('nonexistent')
    passed++
  } catch (e) {
    failed++
    failures.push('revoke unknown should not throw')
  }
}

// Test 7: rejects expired session
{
  const store = new SessionStore(0)
  const session = store.create()
  await new Promise(r => setTimeout(r, 10))
  assertEqual(store.verify(session.token), false, 'reject expired session')
}

// Test 8: cleanup removes expired
{
  const store = new SessionStore(0)
  store.create()
  await new Promise(r => setTimeout(r, 10))
  store.cleanup()
  try {
    store.cleanup()
    passed++
  } catch (e) {
    failed++
    failures.push('second cleanup should not throw')
  }
}

// Test 9: unique tokens
{
  const store = new SessionStore(3600)
  const tokens = new Set()
  for (let i = 0; i < 100; i++) tokens.add(store.create().token)
  assertEqual(tokens.size, 100, '100 unique tokens')
}

// Test Auth
const { COOKIE_NAME, verifyPassword, extractSessionToken, buildCookieHeader, buildClearCookieHeader } = await import('./../src/auth.ts')

// verifyPassword
assertEqual(verifyPassword('s3cret', 's3cret'), true, 'matching passwords')
assertEqual(verifyPassword('s3cret', 'wrong'), false, 'non-matching passwords')
assertEqual(verifyPassword('', 's3cret'), false, 'empty input')
assertEqual(verifyPassword('short', 'longerpassword'), false, 'different length')

// extractSessionToken
assertEqual(extractSessionToken('dsh_session=abc123; other=val'), 'abc123', 'extract from multi-cookie')
assertEqual(extractSessionToken(undefined), undefined, 'missing header')
assertEqual(extractSessionToken('other=val'), undefined, 'cookie not present')
assertEqual(extractSessionToken('dsh_session=token123'), 'token123', 'only cookie')
assertEqual(extractSessionToken('other=val; dsh_session=lasttoken'), 'lasttoken', 'last cookie')
assertEqual(extractSessionToken('garbage'), undefined, 'malformed header')

// buildCookieHeader
assertEqual(buildCookieHeader('mytoken', 3600), 'dsh_session=mytoken; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600', 'cookie header')
assert(buildCookieHeader('tok', 604800).includes('Max-Age=604800'), 'ttl in Max-Age')

// buildClearCookieHeader
assertEqual(buildClearCookieHeader(), 'dsh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'clear cookie')

// COOKIE_NAME
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
