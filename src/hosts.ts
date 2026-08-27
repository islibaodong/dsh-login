/**
 * TrustedHosts — live + persisted set of Host authorities the /api trust
 * fence accepts in addition to loopback and config.trustedHosts.
 *
 * Two writers populate it:
 *   - automatic learning: a successful login/setup learns the request Host
 *     (a caller who presented valid credentials is a real user, so trusting
 *     their origin is safe — it only gates reachability of /api, never the
 *     per-user permission model);
 *   - manual admin management: the 设置-用户管理 panel lists, adds and
 *     removes entries through /api/auth/admin/hosts.
 *
 * The in-memory Set is authoritative; the JSON file is restart survival
 * (debounced, best-effort — same contract as OwnershipIndex). Entries are
 * stored in canonical bare-authority form (`host` or `host:port`), which is
 * exactly the shape isTrustedApiRequest compares against.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Debounce window for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 200

/** Upper bound for a bare-authority string (hostname [1,253] + ':' + port [1,5]). */
export const MAX_HOST_LENGTH = 255

/**
 * Canonical bare-authority form of a Host-ish string (`host` or `host:port`),
 * or undefined when it is not a parsesble, bare authority. Mirrors the
 * normalization in @deepseek-ai/dsh-client-connection's api-request-trust
 * (default port stripped via the https scheme).
 */
export function canonicalAuthority(host: string): string | undefined {
  let entryUrl: URL
  try {
    entryUrl = new URL(`http://${host}`)
  } catch {
    return undefined
  }
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${host}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the raw input is already a bare authority (only case differences
 * allowed) — i.e. canonicalization would not silently strip/rewrite anything.
 * Mirrors config's assertTrustedAuthority: fail loudly rather than quietly
 * broadening a grant (a Host of `evil.com/path` or `user@evil.com` must be
 * rejected, not re-written to `evil.com`). Review #2.
 */
export function isBareAuthority(host: string): boolean {
  const c = canonicalAuthority(host)
  return c !== undefined && c === host.toLowerCase() && host.length <= MAX_HOST_LENGTH
}

/** Whether a canonical authority is a loopback host (always already trusted). */
function isLoopbackCanonical(authority: string): boolean {
  const hostname = (authority.split(':')[0] ?? '').toLowerCase()
  if (hostname === 'localhost') return true
  if (hostname === '::1') return true
  if (/^127\./.test(hostname)) return true
  if (hostname === '0.0.0.0') return true
  if (/^\[?::1\]?/.test(authority)) return true
  return false
}

export class TrustedHosts {
  private readonly set = new Set<string>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  /** Tail of a single serialized write queue; writes never overlap. */
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {
    // Fail-closed load: unreadable/corrupt file starts empty; only entries
    // that survive canonicalization are kept.
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const entries = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object'
          ? Object.keys(parsed as Record<string, unknown>)
          : []
      for (const entry of entries) {
        if (typeof entry === 'string') {
          const c = canonicalAuthority(entry)
          if (c !== undefined) this.set.add(c)
        }
      }
    } catch { /* absent or corrupt: start empty */ }
  }

  /** Canonicalize an authority; undefined when not a bare authority. */
  canonicalize(host: string): string | undefined {
    return canonicalAuthority(host)
  }

  /** Whether this authority is currently trusted (canonical comparison). */
  has(authority: string): boolean {
    const c = canonicalAuthority(authority)
    return c !== undefined && this.set.has(c)
  }

  /**
   * Add one (auto-learned) Host authority, skipping loopback, invalid and
   * non-bare inputs. Returns true when newly recorded. Idempotent.
   */
  learn(host: string): boolean {
    // Only learn from an input that is already a bare authority (no path /
    // userinfo / query that canonicalization would silently strip). Request
    // Host headers are bare by spec; this is belt-and-suspenders.
    if (!isBareAuthority(host)) return false
    const c = canonicalAuthority(host)!
    if (isLoopbackCanonical(c)) return false
    if (this.set.has(c)) return false
    this.set.add(c)
    this.scheduleSave()
    return true
  }

  /** Add a validated authority (admin manual add). Returns true when new. */
  add(authority: string): boolean {
    if (!isBareAuthority(authority)) return false
    const c = canonicalAuthority(authority)!
    // Loopback is always already trusted; storing it is redundant/misleading.
    if (isLoopbackCanonical(c)) return false
    if (this.set.has(c)) return false
    this.set.add(c)
    this.scheduleSave()
    return true
  }

  /** Remove an authority; returns true when it existed. Idempotent. */
  remove(authority: string): boolean {
    const c = canonicalAuthority(authority)
    const key = c ?? authority
    const existed = this.set.delete(key)
    if (existed) this.scheduleSave()
    return existed
  }

  /** Snapshot of the currently trusted authorities. */
  list(): string[] {
    return [...this.set]
  }

  /** Force the pending save; resolves when the queued write settled. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.saving = this.saving.then(() => this.writeNow())
    await this.saving
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      // Chain onto the tail so concurrent writes are serialized (an older
      // in-flight write can never finish after a newer one and clobber it).
      this.saving = this.saving.then(() => this.writeNow())
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify(this.list())}
`, 'utf8')
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}
