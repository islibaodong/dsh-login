import { randomBytes } from 'node:crypto'

/** One created session with its token and expiry timestamps. */
export interface Session {
  token: string
  createdAt: number
  expiresAt: number
}

/**
 * In-memory session token store with automatic TTL expiry. Sessions are lost
 * on process restart - acceptable for single-password local/edge deployment.
 */
export class SessionStore {
  private readonly store = new Map<string, Session>()

  /**
   * @param ttlSeconds - session lifetime in seconds.
   */
  constructor(private readonly ttlSeconds: number) {}

  /** Generate a 32-byte random token, store it with its expiry, and return it. */
  create(): Session {
    const token = randomBytes(32).toString('hex')
    const createdAt = Date.now()
    const expiresAt = createdAt + this.ttlSeconds * 1000
    const session: Session = { token, createdAt, expiresAt }
    this.store.set(token, session)
    return session
  }

  /** Check whether a token exists and has not expired. */
  verify(token: string): boolean {
    if (token.length === 0) return false
    const session = this.store.get(token)
    if (session === undefined) return false
    if (Date.now() > session.expiresAt) {
      this.store.delete(token)
      return false
    }
    return true
  }

  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token: string): void {
    this.store.delete(token)
  }

  /** Remove all expired sessions. Called opportunistically inside verify. */
  cleanup(): void {
    const now = Date.now()
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) this.store.delete(token)
    }
  }
}
