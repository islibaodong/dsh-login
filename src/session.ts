import { randomBytes } from 'node:crypto'

/** One created login session: token, owning user, and expiry timestamps. */
export interface Session {
  token: string
  user: string
  isAdmin: boolean
  createdAt: number
  expiresAt: number
}

/**
 * In-memory session token store with automatic TTL expiry. Sessions are lost
 * on process restart — users simply log in again.
 */
export class SessionStore {
  private readonly store = new Map<string, Session>()

  constructor(private readonly ttlSeconds: number) {}

  /** Generate a 32-byte random token for `user` with its admin flag. */
  create(user: string, isAdmin: boolean): Session {
    const token = randomBytes(32).toString('hex')
    const createdAt = Date.now()
    const session: Session = { token, user, isAdmin, createdAt, expiresAt: createdAt + this.ttlSeconds * 1000 }
    this.store.set(token, session)
    return session
  }

  /** Return the live session for a token, or undefined. */
  verify(token: string): Session | undefined {
    if (token.length === 0) return undefined
    const session = this.store.get(token)
    if (session === undefined) return undefined
    if (Date.now() > session.expiresAt) {
      this.store.delete(token)
      return undefined
    }
    return session
  }

  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token: string): void {
    this.store.delete(token)
  }

  /**
   * Revoke every live session belonging to `user` (user removal or password
   * change). Returns the number of sessions removed.
   */
  revokeAllFor(user: string): number {
    let removed = 0
    for (const [token, session] of this.store) {
      if (session.user === user) {
        this.store.delete(token)
        removed++
      }
    }
    return removed
  }

  /** Remove all expired sessions. */
  cleanup(): void {
    const now = Date.now()
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) this.store.delete(token)
    }
  }
}
