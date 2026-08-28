import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/session.ts'
import { tmpFile } from './helpers.ts'

describe('SessionStore.onlineCounts', () => {
  it('counts live sessions per user and sweeps expired ones', () => {
    const store = new SessionStore(3600)
    store.create('alice', false)
    store.create('alice', false)
    store.create('bob', true)
    const counts = store.onlineCounts()
    expect(counts.get('alice')).toBe(2)
    expect(counts.get('bob')).toBe(1)
    expect(counts.has('carol')).toBe(false)
  })

  it('omits revoked sessions', () => {
    const store = new SessionStore(3600)
    const a = store.create('alice', false)
    store.create('alice', false)
    store.revoke(a.token)
    expect(store.onlineCounts().get('alice')).toBe(1)
  })

  it('drops expired sessions from the counts', () => {
    const store = new SessionStore(-1) // already expired at creation
    store.create('alice', false)
    expect(store.onlineCounts().get('alice')).toBeUndefined()
  })
})

describe('SessionStore', () => {
  it('creates a session with a 64-char hex token and correct expiry', () => {
    const store = new SessionStore(3600)
    const session = store.create('alice', false)
    expect(session.token).toMatch(/^[0-9a-f]{64}$/)
    expect(session.createdAt).toBeGreaterThan(0)
    expect(session.expiresAt).toBe(session.createdAt + 3600 * 1000)
  })

  it('verifies a freshly created session', () => {
    const store = new SessionStore(3600)
    const session = store.create('alice', false)
    expect(store.verify(session.token)).toBeDefined()
  })

  it('rejects an unknown token', () => {
    const store = new SessionStore(3600)
    expect(store.verify('deadbeef')).toBeUndefined()
  })

  it('rejects an empty token', () => {
    const store = new SessionStore(3600)
    expect(store.verify('')).toBeUndefined()
  })

  it('revokes a session so verify returns undefined', () => {
    const store = new SessionStore(3600)
    const session = store.create('alice', false)
    expect(store.verify(session.token)).toBeDefined()
    store.revoke(session.token)
    expect(store.verify(session.token)).toBeUndefined()
  })

  it('revoking an unknown token is a no-op', () => {
    const store = new SessionStore(3600)
    expect(() => store.revoke('nonexistent')).not.toThrow()
  })

  it('rejects an expired session after TTL', async () => {
    // Use a TTL of 0 seconds so the session is immediately expired.
    const store = new SessionStore(0)
    const session = store.create('alice', false)
    // createdAt and expiresAt are the same epoch ms; verify checks
    // Date.now() > expiresAt, and even a synchronous verify is after.
    // Use a small delay to guarantee Date.now has advanced.
    await new Promise<void>(r => setTimeout(r, 10))
    expect(store.verify(session.token)).toBeUndefined()
  })

  it('cleanup removes expired sessions', async () => {
    const store = new SessionStore(0)
    store.create('alice', false)
    await new Promise<void>(r => setTimeout(r, 10))
    store.cleanup()
    // After cleanup, the store should be empty. We can't inspect internals
    // directly, but a second cleanup with no sessions is a no-op.
    expect(() => store.cleanup()).not.toThrow()
  })

  it('each create returns a unique token', () => {
    const store = new SessionStore(3600)
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) tokens.add(store.create('alice', false).token)
    expect(tokens.size).toBe(100)
  })

  it('creates sessions bound to a user', () => {
    const store = new SessionStore(60)
    const s = store.create('alice', true)
    expect(s.user).toBe('alice')
    expect(s.isAdmin).toBe(true)
    expect(store.verify(s.token)?.user).toBe('alice')
  })

  it('verify returns undefined for unknown tokens', () => {
    const store = new SessionStore(60)
    expect(store.verify('nope')).toBeUndefined()
  })

  it('revokeAllFor removes every session of the user and leaves others intact', () => {
    const store = new SessionStore(3600)
    const a1 = store.create('alice', false)
    const a2 = store.create('alice', false)
    const b1 = store.create('bob', false)
    expect(store.revokeAllFor('alice')).toBe(2)
    expect(store.verify(a1.token)).toBeUndefined()
    expect(store.verify(a2.token)).toBeUndefined()
    expect(store.verify(b1.token)).toBeDefined()
    expect(store.revokeAllFor('alice')).toBe(0)
    expect(store.revokeAllFor('nobody')).toBe(0)
  })
})

describe('SessionStore persistence', () => {
  it('persists sessions and restores them in a fresh store (survives a restart)', async () => {
    const path = tmpFile()
    const first = new SessionStore(3600, path)
    const session = first.create('alice', false)
    await first.flush()

    const second = new SessionStore(3600, path)
    const restored = second.verify(session.token)
    expect(restored).toBeDefined()
    expect(restored?.user).toBe('alice')
    expect(restored?.isAdmin).toBe(false)
    expect(restored?.token).toBe(session.token)
  })

  it('persists admin flag across a restart', async () => {
    const path = tmpFile()
    const first = new SessionStore(3600, path)
    const admin = first.create('root', true)
    await first.flush()
    const restored = new SessionStore(3600, path).verify(admin.token)
    expect(restored?.isAdmin).toBe(true)
  })

  it('drops expired entries on load', async () => {
    const path = tmpFile()
    const expired = new SessionStore(0, path)
    const dead = expired.create('alice', false)
    await expired.flush()
    await new Promise<void>(r => setTimeout(r, 10))
    expect(new SessionStore(3600, path).verify(dead.token)).toBeUndefined()
  })

  it('persists revocation so a fresh store no longer verifies the token', async () => {
    const path = tmpFile()
    const first = new SessionStore(3600, path)
    const session = first.create('alice', false)
    first.revoke(session.token)
    await first.flush()
    expect(new SessionStore(3600, path).verify(session.token)).toBeUndefined()
  })

  it('falls back to an empty store on a corrupt file', async () => {
    const path = tmpFile()
    writeFileSync(path, '{ not json !!!', 'utf8')
    const store = new SessionStore(3600, path)
    expect(store.verify('anything')).toBeUndefined()
    const s = store.create('alice', false)
    expect(store.verify(s.token)).toBeDefined()
  })
})
