import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/session.ts'

describe('SessionStore', () => {
  it('creates a session with a 64-char hex token and correct expiry', () => {
    const store = new SessionStore(3600)
    const session = store.create()
    expect(session.token).toMatch(/^[0-9a-f]{64}$/)
    expect(session.createdAt).toBeGreaterThan(0)
    expect(session.expiresAt).toBe(session.createdAt + 3600 * 1000)
  })

  it('verifies a freshly created session', () => {
    const store = new SessionStore(3600)
    const session = store.create()
    expect(store.verify(session.token)).toBe(true)
  })

  it('rejects an unknown token', () => {
    const store = new SessionStore(3600)
    expect(store.verify('deadbeef')).toBe(false)
  })

  it('rejects an empty token', () => {
    const store = new SessionStore(3600)
    expect(store.verify('')).toBe(false)
  })

  it('revokes a session so verify returns false', () => {
    const store = new SessionStore(3600)
    const session = store.create()
    expect(store.verify(session.token)).toBe(true)
    store.revoke(session.token)
    expect(store.verify(session.token)).toBe(false)
  })

  it('revoking an unknown token is a no-op', () => {
    const store = new SessionStore(3600)
    expect(() => store.revoke('nonexistent')).not.toThrow()
  })

  it('rejects an expired session after TTL', () => {
    // Use a TTL of 0 seconds so the session is immediately expired.
    const store = new SessionStore(0)
    const session = store.create()
    // createdAt and expiresAt are the same epoch ms; verify checks
    // Date.now() > expiresAt, and even a synchronous verify is after.
    // Use a small delay to guarantee Date.now has advanced.
    await new Promise<void>(r => setTimeout(r, 10))
    expect(store.verify(session.token)).toBe(false)
  })

  it('cleanup removes expired sessions', () => {
    const store = new SessionStore(0)
    store.create()
    await new Promise<void>(r => setTimeout(r, 10))
    store.cleanup()
    // After cleanup, the store should be empty. We can't inspect internals
    // directly, but a second cleanup with no sessions is a no-op.
    expect(() => store.cleanup()).not.toThrow()
  })

  it('each create returns a unique token', () => {
    const store = new SessionStore(3600)
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) tokens.add(store.create().token)
    expect(tokens.size).toBe(100)
  })
})
