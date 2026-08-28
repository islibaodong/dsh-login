import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One created login session: token, owning user, and expiry timestamps. */
export interface Session {
  token: string
  user: string
  isAdmin: boolean
  createdAt: number
  expiresAt: number
}

/** Debounce window for coalescing disk writes (ms), mirroring the sidecar files. */
const SAVE_DEBOUNCE_MS = 200

/**
 * Session token store with automatic TTL expiry.
 *
 * In-memory map is authoritative for the running process. When a `filePath` is
 * supplied (production — `<dataDir>/sessions.json`), sessions are persisted on
 * every mutation with a debounced, best-effort write, and restored on boot, so
 * a process restart (or a plugin reload while testing) does not silently
 * invalidate every existing login cookie — which previously turned an already-
 * loaded SPA's next `/api` call into a 401 while the page itself redirected to
 * /login only on a full reload. Tokens are written with `0o600`; the file is
 * fail-closed on boot (unreadable/corrupt → start empty).
 */
export class SessionStore {
  private readonly store = new Map<string, Session>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly ttlSeconds: number,
    private readonly filePath?: string,
  ) {
    if (filePath !== undefined) this.load()
  }

  /** Generate a 32-byte random token for `user` with its admin flag. */
  create(user: string, isAdmin: boolean): Session {
    const token = randomBytes(32).toString('hex')
    const createdAt = Date.now()
    const session: Session = { token, user, isAdmin, createdAt, expiresAt: createdAt + this.ttlSeconds * 1000 }
    this.store.set(token, session)
    this.scheduleSave()
    return session
  }

  /** Return the live session for a token, or undefined. */
  verify(token: string): Session | undefined {
    if (token.length === 0) return undefined
    const session = this.store.get(token)
    if (session === undefined) return undefined
    if (Date.now() > session.expiresAt) {
      this.store.delete(token)
      this.scheduleSave()
      return undefined
    }
    return session
  }

  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token: string): void {
    if (this.store.delete(token)) this.scheduleSave()
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
    if (removed > 0) this.scheduleSave()
    return removed
  }

  /**
   * Count live (unexpired) sessions per username. Used by the admin user
   * list to report online status; expired entries are swept along the way.
   */
  onlineCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    const now = Date.now()
    let swept = false
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token)
        swept = true
        continue
      }
      counts.set(session.user, (counts.get(session.user) ?? 0) + 1)
    }
    if (swept) this.scheduleSave()
    return counts
  }

  /** Remove all expired sessions. */
  cleanup(): void {
    const now = Date.now()
    let swept = false
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token)
        swept = true
      }
    }
    if (swept) this.scheduleSave()
  }

  /** Force the pending save; resolves when the queued write settled (teardown). */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.saving
    await this.writeNow()
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath!, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : []
      const now = Date.now()
      for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue
        const s = entry as Partial<Session>
        if (typeof s.token !== 'string' || typeof s.user !== 'string' || typeof s.isAdmin !== 'boolean') continue
        if (typeof s.createdAt !== 'number' || typeof s.expiresAt !== 'number') continue
        if (now > s.expiresAt) continue // already expired: drop on load
        this.store.set(s.token, { token: s.token, user: s.user, isAdmin: s.isAdmin, createdAt: s.createdAt, expiresAt: s.expiresAt })
      }
    } catch { /* absent or corrupt: start empty (fail-closed) */ }
  }

  private scheduleSave(): void {
    if (this.filePath === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    if (this.filePath === undefined) return
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify([...this.store.values()])}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}