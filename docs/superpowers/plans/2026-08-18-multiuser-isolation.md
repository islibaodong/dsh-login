# Multi-User Login & Logical Session Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn dsh-login into a multi-user gateway where every logged-in user sees and operates only their own conversations (admin sees all), with no deepseek-harness core changes.

**Architecture:** A user store (scrypt hashes in one credentials ref), a sidecar sessionId→username ownership index, and a per-user `ApiProxy` decorator. A new dual-face plugin `dsh-login-connection` takes over the `/api` carrier from `dsh-client-connection` (disabled by `cordis.patch.yml`), resolving the cookie user per request and per WebSocket upgrade, dispatching through `toFetchHandler(wrappedProxy)` and filtering event frames.

**Tech Stack:** TypeScript, Vitest, node:crypto scrypt, `@deepseek-ai/dsh-host-apiproxy` (`toFetchHandler`, `ApiProxy`), `@deepseek-ai/dsh-client-connection` internals via its `./src/*` export.

**Spec:** `docs/superpowers/specs/2026-08-18-multiuser-isolation-design.md`

## Global Constraints

- Never modify the deepseek-harness repository. dsh-login consumes only its published exports.
- Plain TypeScript, ESM `.ts` imports (repo style: relative `./x.ts` imports).
- No new npm dependencies. Password hashing: `node:crypto` `scryptSync`.
- Fail-closed: unknown ownership ⇒ admin-only visibility; never leak across users.
- Cookie name stays `dsh_session`; cookie semantics (HttpOnly, SameSite=Strict) unchanged.
- Ordinary users are conversation-only: allowed methods are exactly `session.*`, `workspace.*`, `subagent.*`, `goal.*`, `skill.list`, `llm.providers`, `llm.models`, `host.describe`, `events.*`, `respond`, own-session `session.export`. All other `/api/*` methods reject with a `forbidden` RPC error (HTTP 403 for physical routes).
- Users credential ref is derived as `credentialRef(`${config.password}_USERS`)` (valid POSIX env name because `config.password` already is one).
- Test command: `npx vitest run` from the repo root (repo has no build step).

---

### Task 1: User store (`src/users.ts`)

**Files:**
- Create: `src/users.ts`
- Test: `tests/users.spec.ts`

**Interfaces:**
- Consumes: `ctx.credentials` (`CredentialProvider` from `@deepseek-ai/dsh-credentials`: `resolve/describe/set/unset`, all `Promise`, values non-empty strings).
- Produces: `UserRecord { username, hash, salt, isAdmin, createdAt }`; `class UserStore { constructor(credentials, ref); isEmpty(); create(username, password, isAdmin); verify(username, password); setPassword(username, password); remove(username); list() }` — all async. `verify` returns the record or `undefined`. `create/remove/setPassword` throw `Error` with user-safe messages on duplicate username, unknown username, removing self-referenced last admin is enforced by the ADMIN API (Task 6), not here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/users.spec.ts
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { UserStore } from '../src/users.ts'
import { MemoryCredentials } from './memory-credentials.ts'

const ref = credentialRef('DSH_LOGIN_PASSWORD_USERS')

function makeStore(): { store: UserStore; creds: MemoryCredentials } {
  const creds = new MemoryCredentials()
  return { store: new UserStore(creds as never, ref), creds }
}

describe('UserStore', () => {
  it('starts empty', async () => {
    const { store } = makeStore()
    expect(await store.isEmpty()).toBe(true)
  })

  it('first user becomes admin, second not by default', async () => {
    const { store } = makeStore()
    const admin = await store.create('alice', 'pw-a-123456', true)
    expect(admin.isAdmin).toBe(true)
    const bob = await store.create('bob', 'pw-b-123456', false)
    expect(bob.isAdmin).toBe(false)
    expect((await store.list()).map(u => u.username)).toEqual(['alice', 'bob'])
  })

  it('verify accepts correct password and rejects wrong/unknown', async () => {
    const { store } = makeStore()
    await store.create('alice', 'correct horse', true)
    expect((await store.verify('alice', 'correct horse'))?.username).toBe('alice')
    expect(await store.verify('alice', 'wrong')).toBeUndefined()
    expect(await store.verify('nobody', 'x')).toBeUndefined()
  })

  it('verify is false after setPassword change', async () => {
    const { store } = makeStore()
    await store.create('alice', 'old', true)
    await store.setPassword('alice', 'new')
    expect(await store.verify('alice', 'old')).toBeUndefined()
    expect((await store.verify('alice', 'new'))?.username).toBe('alice')
  })

  it('create rejects duplicates and invalid input', async () => {
    const { store } = makeStore()
    await store.create('alice', 'pw', true)
    await expect(store.create('alice', 'pw2', false)).rejects.toThrow(/exists/i)
    await expect(store.create('Bad Name', 'pw', false)).rejects.toThrow(/username/i)
    await expect(store.create('bob', '', false)).rejects.toThrow(/password/i)
  })

  it('remove deletes the user', async () => {
    const { store } = makeStore()
    await store.create('alice', 'pw', true)
    await store.remove('alice')
    expect(await store.isEmpty()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/users.spec.ts`
Expected: FAIL — `src/users.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/users.ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

/** One stored user. `hash`/`salt` are hex; the password itself is never stored. */
export interface UserRecord {
  username: string
  hash: string
  salt: string
  isAdmin: boolean
  createdAt: number
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/
const KEY_LEN = 64

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LEN).toString('hex')
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * Multi-user account store persisted as one JSON document inside the DSH
 * credentials system. Every mutation re-reads then rewrites the document, so
 * concurrent edits converge on last-write-wins (single-process gateway).
 */
export class UserStore {
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly ref: CredentialRef,
  ) {}

  /** Current records, oldest first. Unconfigured ref ⇒ empty array. */
  async list(): Promise<UserRecord[]> {
    const resolved = await this.credentials.resolve(this.ref)
    if (resolved === undefined) return []
    try {
      const parsed = JSON.parse(resolved.value) as UserRecord[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async isEmpty(): Promise<boolean> {
    return (await this.list()).length === 0
  }

  /** Create a user; the first user in an empty store is forced to admin. */
  async create(username: string, password: string, isAdmin: boolean): Promise<UserRecord> {
    if (!USERNAME_PATTERN.test(username)) throw new Error('invalid username')
    if (password.length === 0) throw new Error('password must not be empty')
    const records = await this.list()
    if (records.some(u => u.username === username)) throw new Error(`user "${username}" already exists`)
    const salt = randomBytes(16).toString('hex')
    const record: UserRecord = {
      username, salt, hash: hashPassword(password, salt),
      isAdmin: records.length === 0 ? true : isAdmin,
      createdAt: Date.now(),
    }
    await this.save([...records, record])
    return record
  }

  /** Constant-time password check; returns the record on match. */
  async verify(username: string, password: string): Promise<UserRecord | undefined> {
    const record = (await this.list()).find(u => u.username === username)
    if (record === undefined) return undefined
    return constantTimeEqualHex(hashPassword(password, record.salt), record.hash) ? record : undefined
  }

  async setPassword(username: string, password: string): Promise<void> {
    if (password.length === 0) throw new Error('password must not be empty')
    const records = await this.list()
    const record = records.find(u => u.username === username)
    if (record === undefined) throw new Error(`unknown user "${username}"`)
    record.salt = randomBytes(16).toString('hex')
    record.hash = hashPassword(password, record.salt)
    await this.save(records)
  }

  async remove(username: string): Promise<void> {
    const records = await this.list()
    const next = records.filter(u => u.username !== username)
    if (next.length === records.length) throw new Error(`unknown user "${username}"`)
    await this.save(next)
  }

  private async save(records: UserRecord[]): Promise<void> {
    await this.credentials.set(this.ref, JSON.stringify(records))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/users.spec.ts`
Expected: PASS (6 tests). Check `tests/memory-credentials.ts` exposes a class with async `resolve/describe/set/unset` (it already backs the login-api specs; extend it only if `set` is missing).

- [ ] **Step 5: Commit**

```bash
git add src/users.ts tests/users.spec.ts tests/memory-credentials.ts
git commit -m "feat: multi-user store with scrypt hashes in credentials"
```

---

### Task 2: Session tokens carry the user

**Files:**
- Modify: `src/session.ts` (whole `SessionStore`)
- Modify: `src/gateway.ts` only if it destructures `Session` (it does not — it calls `store.verify(token)` truthily; confirm with grep)
- Test: `tests/session.spec.ts` (extend)

**Interfaces:**
- Produces: `Session { token, user, isAdmin, createdAt, expiresAt }`; `SessionStore.create(user: string, isAdmin: boolean): Session`; `SessionStore.verify(token): Session | undefined` (was `boolean`).

- [ ] **Step 1: Extend the failing test**

```ts
// append to tests/session.spec.ts describe block
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/session.spec.ts`
Expected: FAIL — `create` takes no arguments / `verify` returns boolean.

- [ ] **Step 3: Implement**

```ts
// src/session.ts — full replacement
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

  /** Remove all expired sessions. */
  cleanup(): void {
    const now = Date.now()
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) this.store.delete(token)
    }
  }
}
```

Then `grep -n "store.verify\|\.create()" src/*.ts tests/*.ts` and update every caller: `gateway.ts` keeps truthiness (`store.verify(token)` as `Session | undefined` — cast or `!== undefined`), other test specs use the new signatures.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (compile errors from stale `create()` calls fixed in this step).

- [ ] **Step 5: Commit**

```bash
git add src/session.ts src/gateway.ts tests/session.spec.ts
git commit -m "feat: session tokens carry username and admin flag"
```

---

### Task 3: Ownership index (`src/ownership.ts`)

**Files:**
- Create: `src/ownership.ts`
- Test: `tests/ownership.spec.ts`

**Interfaces:**
- Produces: `class OwnershipIndex { constructor(filePath: string); record(sessionId: string, username: string): void; lookup(sessionId: string): string | undefined; has(sessionId): boolean; knownUsernames(): Set<string>; flush(): Promise<void> }`. `record` mutates memory immediately and schedules a debounced save (200 ms); `flush` forces the save (tests + shutdown use it). Constructor loads the file if present; unreadable/corrupt file ⇒ start empty (fail-closed).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ownership.spec.ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnershipIndex } from '../src/ownership.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-login-own-')), 'ownership.json')
}

describe('OwnershipIndex', () => {
  it('records and looks up', () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('s1', 'alice')
    expect(idx.lookup('s1')).toBe('alice')
    expect(idx.lookup('s2')).toBeUndefined()
  })

  it('persists through flush and reloads in a new instance', async () => {
    const file = tmpFile()
    const idx = new OwnershipIndex(file)
    idx.record('s1', 'alice')
    await idx.flush()
    const reloaded = new OwnershipIndex(file)
    expect(reloaded.lookup('s1')).toBe('alice')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s1: 'alice' })
  })

  it('re-record overwrites, corrupt file starts empty', async () => {
    const file = tmpFile()
    const idx = new OwnershipIndex(file)
    idx.record('s1', 'alice')
    idx.record('s1', 'bob')
    await idx.flush()
    expect(new OwnershipIndex(file).lookup('s1')).toBe('bob')
    const corrupt = tmpFile()
    require('node:fs').writeFileSync(corrupt, '{not json')
    expect(new OwnershipIndex(corrupt).lookup('x')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run** — `npx vitest run tests/ownership.spec.ts` — expect FAIL (module missing). (If `require` trips ESM lint, inline `writeFileSync(corrupt, '{not json')` with the existing `node:fs` import instead.)

- [ ] **Step 3: Implement**

```ts
// src/ownership.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Debounce window for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 200

/**
 * Sidecar sessionId → username index, one JSON object per data file.
 * In-memory map is authoritative for the running process; the file is a
 * restart survival best-effort. Direct index hits only — lineage resolution
 * lives in api-filter (it needs session summaries).
 */
export class OwnershipIndex {
  private readonly map = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {
    // Fail-closed load: unreadable or corrupt file starts empty — sessions
    // become admin-only until re-attributed, never cross-visible.
    try {
      const raw = readFileSyncSync(filePath)
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed !== null && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') this.map.set(k, v)
        }
      }
    } catch { /* absent or corrupt: start empty */ }
  }

  record(sessionId: string, username: string): void {
    this.map.set(sessionId, username)
    this.scheduleSave()
  }

  lookup(sessionId: string): string | undefined {
    return this.map.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId)
  }

  knownUsernames(): Set<string> {
    return new Set(this.map.values())
  }

  /** Force the pending save; resolves when the file write settled. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.saving
    await this.writeNow()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify(Object.fromEntries(this.map))}\n`, 'utf8')
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}

// Synchronous constructor-time load without top-level await:
import { readFileSync } from 'node:fs'
function readFileSyncSync(path: string): string {
  return readFileSync(path, 'utf8')
}
```

(Note: hoist the `import { readFileSync } from 'node:fs'` to the top of the file and drop the helper wrapper — shown split only to keep the constructor snippet focused.)

- [ ] **Step 4: Run** — `npx vitest run tests/ownership.spec.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ownership.ts tests/ownership.spec.ts
git commit -m "feat: sidecar session ownership index"
```

---

### Task 4: Per-user ApiProxy decorator (`src/api-filter.ts`)

**Files:**
- Create: `src/api-filter.ts`
- Test: `tests/api-filter.spec.ts`

**Interfaces:**
- Consumes: `ApiProxy` (from `@deepseek-ai/dsh-host-apiproxy/api`), `OwnershipIndex`, `UserStore` (admin check only via `AuthUser`).
- Produces:
  - `interface AuthUser { username: string; isAdmin: boolean }`
  - `function createUserProxy(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex): ApiProxy`
  - `function frameVisible(user: AuthUser, ownership: OwnershipIndex, frame: MuxFrame | HostFrame, owned: Set<string>): boolean` — pure frame predicate (used by both the events wrappers and Task 5 tests).
  - `async function ownedSessionIds(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex): Promise<Set<string>>` — direct index hits plus lineage closure over `session.list` summaries (`parentSessionId` walk to fixpoint, recording attributions into the index).

**Semantics (spec §api-filter):** admin sees everything unfiltered. Ordinary user:
- `sessions.list/search` filtered to `ownedSessionIds`; `sessions.create/fork` record ownership on ok responses (`result.value.sessionId`).
- sessionId-addressed `sessions.*` methods, `subagents.prompt/interrupt/history` (payload `agentId`), `goals.*` (payload `sessionId`): resolve the owner by index-or-lineage; not owned ⇒ RPC error `{ ok: false, error: { code: 'forbidden', ... } }` echoing `rpcId`.
- `subagents.list` filtered to owned agent ids.
- `workspace.list` filtered: each view's `sessionIds` reduced to owned, empty ⇒ dropped.
- `events.mux`: async-generator filter dropping frames whose `sessionId` is not owned (`stream/error` always passes).
- `events.host`: session-keyed frames by ownership; `host/workspace-changed` dropped unless it contains an owned session id; `host/workspace-order-changed` / `host/archived-sessions-changed` dropped unless any listed id is owned; `host/remote-event` dropped; `stream/error` passes.
- Forbidden domains for ordinary users: `credentials`, `settings`, `agentPresets`, `llm.discoverModels`, `host` (except `describe`), `downloads` (except the per-session guard in Task 5 for the physical route). Each forbidden method returns the `forbidden` RPC error.

- [ ] **Step 1: Write the failing test**

Build the fixture by wrapping a minimal hand-rolled `ApiProxy` double (no need for the connection fixture): `sessions.list` returns three summaries — `own1` (index hit), `child-of-own` (`parentSessionId: 'own1'`), `alien`; `sessions.create` returns `{ sessionId: 'new-1' }`; `sessions.prompt` echoes; `events.mux` yields frames for `own1` and `alien`.

```ts
// tests/api-filter.spec.ts
import { describe, expect, it } from 'vitest'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createUserProxy, frameVisible, ownedSessionIds } from '../src/api-filter.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { tmpFile } from './helpers.ts'

const alice: { username: string; isAdmin: boolean } = { username: 'alice', isAdmin: false }
const root: { username: string; isAdmin: boolean } = { username: 'root', isAdmin: true }

function fakeApi(over: Partial<ApiProxy> = {}): ApiProxy {
  return {
    sessions: {
      list: async () => ({
        rpcId: RpcId('r'), result: { ok: true, value: { items: [
          { sessionId: 'own1' as never, updatedAt: 1, running: false, blank: false },
          { sessionId: 'child' as never, updatedAt: 2, running: false, blank: false, parentSessionId: 'own1' as never },
          { sessionId: 'alien' as never, updatedAt: 3, running: false, blank: false },
        ] } },
      }),
      create: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'new-1' as never } } }),
      prompt: async (r: RpcRequest<never>) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
    },
    events: {
      mux: async function* () {
        yield { rpcId: RpcId('m1'), payload: { type: 'session/subscribed', sessionId: 'own1', lastSeq: 0 } }
        yield { rpcId: RpcId('m2'), payload: { type: 'session/subscribed', sessionId: 'alien', lastSeq: 0 } }
        yield { rpcId: RpcId('m3'), payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } }
      },
      host: async function* () {},
    },
    credentials: { set: async (r: RpcRequest<never>) => { throw new Error('must not be called') } },
    ...over,
  } as unknown as ApiProxy
}

const req = (payload: unknown): RpcRequest<never> => ({ rpcId: RpcId('t'), payload }) as RpcRequest<never>

describe('createUserProxy', () => {
  it('ordinary list filters to owned + lineage children', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const res = await proxy.sessions.list(req({}))
    const ids = (res.result as { ok: true; value: { items: Array<{ sessionId: string }> } }).value.items.map(i => i.sessionId)
    expect(ids).toEqual(['own1', 'child'])
    expect(idx.lookup('child')).toBe('alice') // lineage attribution recorded
  })

  it('admin sees everything unfiltered', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), root, idx)
    const res = await proxy.sessions.list(req({}))
    const ids = (res.result as { ok: true; value: { items: Array<{ sessionId: string }> } }).value.items.map(i => i.sessionId)
    expect(ids).toEqual(['own1', 'child', 'alien'])
  })

  it('create records ownership; prompt rejects alien session', async () => {
    const idx = new OwnershipIndex(tmpFile())
    const proxy = createUserProxy(fakeApi(), alice, idx)
    await proxy.sessions.create(req({}))
    expect(idx.lookup('new-1')).toBe('alice')
    const ok = await proxy.sessions.prompt(req({ sessionId: 'own1', mode: 'queue', content: [] }))
    expect(ok.result).toMatchObject({ ok: true })
    const denied = await proxy.sessions.prompt(req({ sessionId: 'alien', mode: 'queue', content: [] }))
    expect(denied.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('forbidden domains reject for ordinary users', async () => {
    const proxy = createUserProxy(fakeApi(), alice, new OwnershipIndex(tmpFile()))
    const res = await proxy.credentials.set(req({ ref: 'X', value: 'y' }))
    expect(res.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('mux frames filter to owned sessions; stream/error passes', async () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const proxy = createUserProxy(fakeApi(), alice, idx)
    const frames: string[] = []
    for await (const f of await proxy.events.mux(req({}), new AbortController().signal)) {
      frames.push(f.payload.type === 'session/subscribed' ? f.payload.sessionId : f.payload.type)
    }
    expect(frames).toEqual(['own1', 'stream/error'])
  })

  it('frameVisible host rules', () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('own1', 'alice')
    const owned = new Set(['own1'])
    expect(frameVisible(alice, idx, { type: 'host/session-status', sessionId: 'own1', running: true }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/session-status', sessionId: 'alien', running: true }, owned)).toBe(false)
    expect(frameVisible(alice, idx, { type: 'host/remote-event', event: 'x', args: [] }, owned)).toBe(false)
    expect(frameVisible(root, idx, { type: 'host/remote-event', event: 'x', args: [] }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/workspace-changed', workspace: { workspaceId: 'w', name: 'w', sessionIds: ['own1'] } as never }, owned)).toBe(true)
    expect(frameVisible(alice, idx, { type: 'host/workspace-changed', workspace: { workspaceId: 'w', name: 'w', sessionIds: ['alien'] } as never }, owned)).toBe(false)
  })
})
```

Extract `tmpFile` into `tests/helpers.ts` (move the body from Task 3's spec and import it there too).

- [ ] **Step 2: Run** — `npx vitest run tests/api-filter.spec.ts` — expect FAIL.

- [ ] **Step 3: Implement** (`src/api-filter.ts`)

```ts
import type { ApiProxy, HostFrame, MuxFrame, RpcId, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as makeRpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { OwnershipIndex } from './ownership.ts'

export interface AuthUser { username: string; isAdmin: boolean }

const OWNERSHIP_RPC: RpcId = makeRpcId('dsh-login-ownership')

function forbidden<T>(request: RpcRequest<unknown>): RpcResponse<T> {
  return {
    rpcId: request.rpcId,
    result: { ok: false, error: { code: 'forbidden', message: 'not permitted for this user', details: {} } },
  } as RpcResponse<T>
}

/** Methods ordinary users may call (domain.name). Admin bypasses the list. */
const USER_ALLOWED = new Set([
  'sessions.list', 'sessions.search', 'sessions.create', 'sessions.history', 'sessions.models',
  'sessions.selectModel', 'sessions.rename', 'sessions.fork', 'sessions.prompt', 'sessions.attachment',
  'sessions.updateQueue', 'sessions.cancel',
  'workspace.list', 'workspace.create', 'workspace.rename', 'workspace.delete',
  'workspace.insertBefore', 'workspace.insertSessionBefore', 'workspace.archiveSession',
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'skill.list', 'llm.providers', 'llm.models', 'host.describe',
])

/** Domains whose every method is admin-only. */
const ADMIN_ONLY_DOMAINS = new Set(['credentials', 'settings', 'agentPresets'])

export async function ownedSessionIds(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex): Promise<Set<string>> {
  const owned = new Set<string>()
  for (const [sid, owner] of ownershipEntries(ownership)) {
    if (owner === user.username) owned.add(sid)
  }
  // Lineage closure: a child of an owned session is owned (subagents).
  const res = await api.sessions.list({ rpcId: OWNERSHIP_RPC, payload: {} })
  if (!res.result.ok) return owned
  const byParent = new Map<string, string[]>()
  for (const item of res.result.value.items) {
    if (item.parentSessionId !== undefined) {
      const list = byParent.get(item.parentSessionId) ?? []
      list.push(item.sessionId)
      byParent.set(item.parentSessionId, list)
    }
  }
  let grew = true
  while (grew) {
    grew = false
    for (const sid of [...owned]) {
      for (const child of byParent.get(sid) ?? []) {
        if (!owned.has(child)) {
          owned.add(child)
          ownership.record(child, user.username)
          grew = true
        }
      }
    }
  }
  return owned
}

function ownershipEntries(ownership: OwnershipIndex): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const sid of ownedKeyIterator(ownership)) out.push([sid, ownership.lookup(sid) as string])
  return out
}

// OwnershipIndex iteration shim without exposing the Map:
function* ownedKeyIterator(ownership: OwnershipIndex): Generator<string> {
  for (const user of ownership.knownUsernames()) {
    // no key iteration on the index; callers use lookup per sessionId they hold
    void user
  }
}
```

Stop — the shim above is a design smell. Instead ADD to `OwnershipIndex` (Task 3 file) in this task:

```ts
  /** All recorded [sessionId, username] pairs (snapshot). */
  entries(): Array<[string, string]> {
    return [...this.map.entries()]
  }
```

and implement `ownedSessionIds` with `for (const [sid, owner] of ownership.entries())`.

Continue the implementation:

```ts
export function frameVisible(
  user: AuthUser, ownership: OwnershipIndex,
  frame: MuxFrame | HostFrame, owned: Set<string>,
): boolean {
  if (user.isAdmin) return true
  const f = frame as { type: string; sessionId?: string; workspace?: { sessionIds?: string[] }; workspaceIds?: string[]; archivedSessionIds?: string[] }
  if (f.type === 'stream/error') return true
  if (f.type === 'host/remote-event') return false
  if (f.sessionId !== undefined) return owned.has(f.sessionId)
  if (f.type === 'host/workspace-changed') {
    const ids = f.workspace?.sessionIds ?? []
    return ids.some(id => owned.has(id))
  }
  if (f.type === 'host/workspace-order-changed') {
    return (f.workspaceIds ?? []).some(id => owned.has(id))
  }
  if (f.type === 'host/archived-sessions-changed') {
    return (f.archivedSessionIds ?? []).some(id => owned.has(id))
  }
  return false
}

async function* filterFrames(
  stream: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
  keep: (frame: MuxFrame | HostFrame) => boolean,
): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
  for await (const frame of stream) {
    if (keep(frame.payload)) yield frame
  }
}

/** Session ids addressed by sessionId-keyed method payloads. */
const SESSION_GUARDED = new Set(['history', 'models', 'selectModel', 'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel'])

export function createUserProxy(api: ApiProxy, user: AuthUser, ownership: OwnershipIndex): ApiProxy {
  const guard = async (request: RpcRequest<{ sessionId?: string; agentId?: string }>): Promise<boolean> => {
    if (user.isAdmin) return true
    const sid = request.payload.sessionId ?? request.payload.agentId
    if (sid === undefined) return true
    const direct = ownership.lookup(sid)
    if (direct !== undefined) return direct === user.username
    const owned = await ownedSessionIds(api, user, ownership)
    return owned.has(sid)
  }

  const wrapSessionMethod = (name: string, method: (r: never) => Promise<unknown>) => async (request: never) => {
    if (SESSION_GUARDED.has(name) && !(await guard(request as never))) return forbidden(request as never)
    const response = await method(request)
    return response
  }

  const proxy: ApiProxy = {
    ...api,
    sessions: {
      ...api.sessions,
      list: async (request) => {
        const res = await api.sessions.list(request)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        return { ...res, result: { ok: true, value: { items: res.result.value.items.filter(i => owned.has(i.sessionId as string)) } } }
      },
      search: async (request, signal) => {
        const res = await api.sessions.search(request, signal)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        return { ...res, result: { ok: true, value: { ...res.result.value, items: res.result.value.items.filter(i => owned.has(i.sessionId as string)) } } }
      },
      create: async (request) => {
        const res = await api.sessions.create(request)
        if (res.result.ok) ownership.record(res.result.value.sessionId as string, user.username)
        return res
      },
      fork: async (request) => {
        if (!(await guard(request as never))) return forbidden(request as never)
        const res = await api.sessions.fork(request)
        if (res.result.ok) ownership.record(res.result.value.sessionId as string, user.username)
        return res
      },
      // history/models/selectModel/rename/prompt/attachment/updateQueue/cancel:
      ...Object.fromEntries([...SESSION_GUARDED].filter(n => n !== 'fork' && n !== 'create').map(name => [
        name, wrapSessionMethod(name, (api.sessions as Record<string, (r: never) => Promise<unknown>>)[name]),
      ])),
    },
    subagents: {
      ...api.subagents,
      list: async (request, signal) => {
        const res = await api.subagents.list(request, signal)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        const items = (res.result.value as { items?: Array<{ agentId?: string }> }).items ?? []
        return { ...res, result: { ok: true, value: { ...res.result.value, items: items.filter(i => i.agentId === undefined || owned.has(i.agentId)) } } }
      },
      ...Object.fromEntries(['history', 'prompt', 'interrupt'].map(name => [
        name, wrapSessionMethod(name, (api.subagents as Record<string, (r: never) => Promise<unknown>>)[name]),
      ])),
    },
    workspace: {
      ...api.workspace,
      list: async (request) => {
        const res = await api.workspace.list(request)
        if (user.isAdmin || !res.result.ok) return res
        const owned = await ownedSessionIds(api, user, ownership)
        const value = res.result.value as { workspaces: Array<{ sessionIds: string[] }> }
        const workspaces = value.workspaces
          .map(w => ({ ...w, sessionIds: w.sessionIds.filter(id => owned.has(id)) }))
          .filter(w => w.sessionIds.length > 0)
        return { ...res, result: { ok: true, value: { ...value, workspaces } } }
      },
    },
    goals: {
      ...api.goals,
      ...Object.fromEntries(Object.getOwnPropertyNames(api.goals).map(name => [
        name, wrapSessionMethod(name, (api.goals as Record<string, (r: never) => Promise<unknown>>)[name]),
      ])),
    },
    events: {
      ...api.events,
      mux: (request, signal) => filterWithOwnership(api.events.mux(request, signal), async frame => {
        if (user.isAdmin) return true
        const f = frame as MuxFrame & { sessionId?: string }
        if (f.type === 'stream/error') return true
        return (await ownedSessionIds(api, user, ownership)).has(f.sessionId as string)
      }),
      host: (request, signal) => filterWithOwnership(api.events.host(request, signal), async frame => {
        if (user.isAdmin) return true
        return frameVisible(user, ownership, frame.payload, await ownedSessionIds(api, user, ownership))
      }),
    },
    credentials: domainGuard(api.credentials),
    settings: domainGuard(api.settings),
    agentPresets: domainGuard(api.agentPresets),
    llm: {
      ...api.llm,
      discoverModels: (request: never) => Promise.resolve(forbidden(request)),
    },
    host: {
      ...api.host,
      pickDirectory: methodForbidden,
      listDirectory: methodForbidden,
      createDirectory: methodForbidden,
      openPath: methodForbidden,
    },
  }
  // Admin sees everything unfiltered.
  return user.isAdmin ? { ...api } : proxy

  function methodForbidden(request: never): Promise<never> {
    return Promise.resolve(forbidden(request) as never)
  }
  function domainGuard<T extends object>(domain: T): T {
    if (user.isAdmin) return domain
    return new Proxy(domain, { get() { return methodForbidden } }) as T
  }
  async function* filterWithOwnership(
    stream: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
    keep: (frame: RpcRequest<MuxFrame | HostFrame>) => Promise<boolean>,
  ): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
    for await (const frame of stream) {
      if (await keep(frame)) yield frame
    }
  }
}
```

Notes for the implementer:
- The `Object.fromEntries` spreads are structural shims over the typed domains; cast once per domain (`as ApiProxy['sessions']` etc.) at the seam rather than fighting variance row by row. Keep casts inside `createUserProxy` only.
- `wrapSessionMethod` for `sessions` must also be applied to `history`/`models`/`selectModel`/`rename`/`prompt`/`attachment`/`updateQueue`/`cancel` — the `SESSION_GUARDED` list already contains exactly those names; verify each appears in the final object (add a test asserting `proxy.sessions.prompt` rejects `alien`, which the spec test above covers).
- Cache `ownedSessionIds` per request batch is unnecessary (lists are small); do NOT cache across awaits beyond one call.

- [ ] **Step 4: Run** — `npx vitest run tests/api-filter.spec.ts` — expect PASS. Then run the full suite.

- [ ] **Step 5: Commit**

```bash
git add src/api-filter.ts src/ownership.ts tests/api-filter.spec.ts tests/helpers.ts tests/ownership.spec.ts
git commit -m "feat: per-user ApiProxy decorator with ownership filtering"
```

---

### Task 5: Connection takeover plugin (`src/connection.ts`)

**Files:**
- Create: `src/connection.ts` (host half), `src/connection.client.ts` (browser half)
- Modify: `package.json` (exports), `cordis.patch.yml`
- Test: `tests/connection.spec.ts`

**Interfaces:**
- Consumes: from `@deepseek-ai/dsh-client-connection/src/*` (public export map): `bridge`, `DEFAULT_MAX_REQUEST_BODY_BYTES` (`./src/http-bridge.ts`), `isTrustedApiRequest`, `assertTrustedAuthority` (`./src/api-request-trust.ts`), `WebSocketDownlinks`, `rejectWebSocketUpgrade` (`./src/websocket-downlink.ts`), `API_PATH`, `MUX_EVENTS_PATH`, `HOST_EVENTS_PATH` (`./src/api-path.ts`); `toFetchHandler` from `@deepseek-ai/dsh-host-apiproxy`.
- Consumes: `SessionStore`, `UserStore`, `OwnershipIndex`, `createUserProxy`, `AuthUser`, `extractSessionToken`.
- Produces: Cordis plugin `dsh-login-connection` — `export const name = 'dsh-login-connection'`, `export const inject = ['webServer']`, `export function apply(ctx, config)` where config adds `takeover: { store, users, ownership }` assembled by `src/index.ts` (plain object injection — the plugin is mounted as a child/context of dsh-login, so pass the instances through a factory instead of config: export `createConnectionPlugin(deps)` returning `{ name, inject, apply }`, and `src/index.ts` calls `ctx.plugin(...)` on it inside its own `ctx.effect` scope).

**Route behavior (node half):**
1. `prefix /api` route, same trust fence as upstream (`isTrustedApiRequest(req, trustedHosts)` → 403).
2. `bridge(req, res, sharedFetch, maxRequestBodyBytes)` where `sharedFetch(request: Request)`:
   - resolve session: `extractSessionToken(request.headers.get('cookie'))` → `store.verify(token)`; missing/invalid → `Response 401 'authentication required'`.
   - method path = last `/api/` segment; non-admin user hitting an admin-only method (same predicate as Task 4: `USER_ALLOWED`-complement) → `Response 403`.
   - physical `GET /api/session.export?sessionId=…`: non-admin and not owned (index-or-lineage via the user proxy's helper) → 403; else forward.
   - else `toFetchHandler(createUserProxy(apiProxy, user, ownership)).fetch(request)` — build the handler ONCE per user (small `Map<username, ApiProxy>` cache) rather than per request.
3. WebSocket upgrades on `MUX_EVENTS_PATH` / `HOST_EVENTS_PATH`: trust fence → reject; cookie session → reject; then `new WebSocketDownlinks(createUserProxy(...))` per socket, `handleMux/handleHost`, and track the instance for disposal on socket close and plugin teardown (`close()` all in the disposer).
4. `GET` (non-upgrade) to the two event paths returns the upstream `426` verbatim.

- [ ] **Step 1: Write the failing test** — structural, mirroring `node-half.host.spec.ts` in upstream: fake `webServer` recording routes/upgrades, fake `apiProxy` (double from Task 4's spec), real `SessionStore`/`OwnershipIndex`. Assert: `/api` prefix route exists; a request without cookie bridges to 401; a request with alice's cookie reaches a proxied `session.list` (fake fetch handler sees the wrapped proxy — assert via the fake api recording calls); upgrade without cookie gets the 403 socket rejection; admin cookie passes privileged path.

```ts
// tests/connection.spec.ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createConnectionPlugin } from '../src/connection.ts'
import { SessionStore } from '../src/session.ts'
import { OwnershipIndex } from '../src/ownership.ts'
import { UserStore } from '../src/users.ts'
import { MemoryCredentials } from './memory-credentials.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { fakeHttpServer } from './helpers.ts'

async function setup() {
  const routes: unknown[] = []
  const upgrades: unknown[] = []
  const ctx = new Context()
  ctx.provide('webServer', fakeHttpServer(routes, upgrades))
  const calls: string[] = []
  const apiProxy = { sessions: { list: async () => { calls.push('list'); return { rpcId: 'r', result: { ok: true, value: { items: [] } } } } } }
  ctx.provide('apiProxy', apiProxy)
  const store = new SessionStore(60)
  const alice = store.create('alice', false)
  const users = new UserStore(new MemoryCredentials() as never, credentialRef('DSH_LOGIN_PASSWORD_USERS'))
  const ownership = new OwnershipIndex(tmpFileFromHelpers())
  ctx.plugin(createConnectionPlugin({ store, users, ownership, trustedHosts: [] }))
  await ctx.start()
  return { routes, upgrades, store, alice, calls }
}

it('registers the /api prefix route and rejects anonymous fetches', async () => {
  const { routes } = await setup()
  const route = routes[0] as { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }
  expect(route.kind).toBe('prefix')
  expect(route.path).toBe('/api')
})

it('an authenticated alice reaches the proxied session.list', async () => {
  const { routes, alice, calls } = await setup()
  const route = routes[0] as { handler: (req: unknown, res: unknown) => Promise<void> }
  // bridge test helper: simulate fetch-level by calling the shared fetch the route closes over —
  // the test exposes it through fakeHttpServer's bridge interception (see helpers.ts).
  const fetched = await helperSharedFetch(route, { cookie: `dsh_session=${alice.token}`, url: 'http://localhost/api/session.list', method: 'POST', body: '{"type":"client-request","rpcId":"t","method":"session.list","payload":{}}' })
  expect(fetched.status).toBe(200)
  expect(calls).toEqual(['list'])
})

it('anonymous fetch gets 401', async () => {
  const { routes } = await setup()
  const fetched = await helperSharedFetch(routes[0], { url: 'http://localhost/api/session.list', method: 'POST', body: '{}' })
  expect(fetched.status).toBe(401)
})
```

`helpers.ts` gains `fakeHttpServer` (records `{kind,path,handler}`/upgrades and returns `{register,registerUpgrade,registerFallback}` disposers, modeled on upstream's `fakeHttpServer` in `packages/client/connection/tests/node-half.host.spec.ts` — copy that fixture locally) and `helperSharedFetch`, which reconstructs a WHATWG `Request` from the plain object and invokes the fetch function the route handler closes over (expose it by having `fakeHttpServer` wrap each registered prefix handler's bridge call: simplest is to make the plugin's shared fetch injectable via `createConnectionPlugin({..., fetchForTest})` and assert against it directly).

- [ ] **Step 2: Run** — `npx vitest run tests/connection.spec.ts` — expect FAIL.

- [ ] **Step 3: Implement**

```ts
// src/connection.ts
/** dsh-login-connection — the /api carrier takeover with per-user dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '@deepseek-ai/dsh-client-connection/src/api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from '@deepseek-ai/dsh-client-connection/src/http-bridge.ts'
import { isTrustedApiRequest, assertTrustedAuthority } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from '@deepseek-ai/dsh-client-connection/src/websocket-downlink.ts'
import { extractSessionToken } from './auth.ts'
import { createUserProxy, ownedSessionIds } from './api-filter.ts'
import type { AuthUser } from './api-filter.ts'
import type { OwnershipIndex } from './ownership.ts'
import type { SessionStore } from './session.ts'

export interface TakeoverDeps {
  store: SessionStore
  ownership: OwnershipIndex
  trustedHosts: string[]
  maxRequestBodyBytes?: number
}

export function createConnectionPlugin(deps: TakeoverDeps) {
  return {
    name: 'dsh-login-connection',
    inject: ['webServer'],
    apply(ctx: Context): void {
      for (const entry of deps.trustedHosts) assertTrustedAuthority(entry)
      const maxBytes = deps.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
      const proxyCache = new Map<string, { fetch: typeof fetch; downlinks: ApiProxy }>()

      const userProxy = (api: ApiProxy, user: AuthUser): ApiProxy => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username
        let entry = proxyCache.get(key)
        if (entry === undefined) {
          entry = { fetch: undefined as never, downlinks: createUserProxy(api, user, deps.ownership) }
          entry.fetch = toFetchHandler(entry.downlinks).fetch
          proxyCache.set(key, entry)
        }
        return entry.downlinks
      }
      const userFetch = (api: ApiProxy, user: AuthUser): typeof fetch => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username
        userProxy(api, user)
        return proxyCache.get(key)!.fetch
      }

      const sharedFetch = (api: ApiProxy) => async (request: Request): Promise<Response> => {
        const url = new URL(request.url)
        const token = extractSessionToken(request.headers.get('cookie') ?? undefined)
        const session = token === undefined ? undefined : deps.store.verify(token)
        if (session === undefined) return new Response('authentication required', { status: 401 })
        const user: AuthUser = { username: session.user, isAdmin: session.isAdmin }
        const method = url.pathname.startsWith(`${API_PATH}/`) ? url.pathname.slice(API_PATH.length + 1) : undefined
        // Non-admin methods that Task 4's USER_ALLOWED rejects are rejected at the
        // physical layer too (cheaper than round-tripping an envelope) — the
        // wrapped proxy remains the authority; keep both in sync via isUserAllowed.
        if (!user.isAdmin && method !== undefined && !isUserAllowed(method)) {
          return new Response('forbidden', { status: 403 })
        }
        if (url.pathname === '/api/session.export') {
          const sid = url.searchParams.get('sessionId')
          if (!user.isAdmin && sid !== null) {
            const owned = await ownedSessionIds(api, user, deps.ownership)
            if (!owned.has(sid)) return new Response('forbidden', { status: 403 })
          }
        }
        return userFetch(api, user)(request)
      }

      const route: WebRoute = {
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, deps.trustedHosts)) {
            res.writeHead(403); res.end('forbidden'); return
          }
          const api = ctx.get('apiProxy')
          if (api === undefined) { res.writeHead(404); res.end('not found'); return }
          await bridge(req, res, sharedFetch(api), maxBytes)
        },
      }
      ctx.effect(() => ctx.webServer.register(route), 'dsh-login-connection: /api route')

      const downlinkSet = new Set<WebSocketDownlinks>()
      const registerDownlink = (path: string, kind: 'mux' | 'host') => {
        ctx.effect(() => ctx.webServer.registerUpgrade({
          path,
          handler: (req, socket, head) => {
            if (!isTrustedApiRequest(req, deps.trustedHosts)) { rejectWebSocketUpgrade(socket); return }
            const token = extractSessionToken(req.headers.cookie)
            const session = token === undefined ? undefined : deps.store.verify(token)
            if (session === undefined) { rejectWebSocketUpgrade(socket); return }
            const api = ctx.get('apiProxy')
            if (api === undefined) { rejectWebSocketUpgrade(socket); return }
            const downlinks = new WebSocketDownlinks(userProxy(api, { username: session.user, isAdmin: session.isAdmin }))
            downlinkSet.add(downlinks)
            socket.once('close', () => { void downlinks.close(); downlinkSet.delete(downlinks) })
            if (kind === 'mux') downlinks.handleMux(req, socket, head)
            else downlinks.handleHost(req, socket, head)
          },
        }), `dsh-login-connection: ${path} WebSocket`)
      }
      registerDownlink(MUX_EVENTS_PATH, 'mux')
      registerDownlink(HOST_EVENTS_PATH, 'host')
      ctx.effect(() => () => { for (const d of downlinkSet) void d.close() }, 'dsh-login-connection: downlinks close')
    },
  }
}
```

`isUserAllowed(method)`: export from `src/api-filter.ts` as `export function isUserAllowed(method: string): boolean` returning `USER_ALLOWED.has(method)`; the physical path check uses it. Add one spec test: `isUserAllowed('credentials.set') === false`, `isUserAllowed('session.list') === true`. Note method keys here are `domain.method` with the RPC map's exact keys (`session.list`, `credentials.set`, `agentPreset.list`, …) — align `USER_ALLOWED` naming in Task 4 with `RpcMethodMap` keys (session.*, workspace.*, subagent.* — check `rpc-map.ts` for exact key spellings: `session.list` NOT `sessions.list`). **Important**: open `packages/host/apiproxy/src/api/rpc-map.ts` in the harness checkout and copy the exact key list into `USER_ALLOWED`.

Browser half — `src/connection.client.ts`:

```ts
// Re-export the shipped browser client verbatim: the takeover changes only
// the host-side carrier (auth resolution + per-user dispatch).
export * from '@deepseek-ai/dsh-client-connection/client'
export { default } from '@deepseek-ai/dsh-client-connection/client'
```

(Verify the `./client` export's shape — `Object.keys(import('@deepseek-ai/dsh-client-connection/client'))` — and re-export whichever of `default`/named the loader expects; the dsh-client-modules node half scans `client` export of the row's package.)

`package.json` additions:

```json
"exports": {
  ".": "./src/index.ts",
  "./connection": "./src/connection.ts",
  "./connection-client": "./src/connection.client.ts"
}
```

(match the existing exports block style; keep whatever `"./package.json"` entries already exist).

`cordis.patch.yml`: disable the shipped connection row and insert ours (this file is a patch over the web profile applied after dsh-web-app):

```yaml
# The shipped /api carrier is replaced by dsh-login's identity-aware takeover.
- id: connection
  disabled: true
- insert:
    - id: dsh-login-connection
      name: 'dsh-login/connection'
      # dsh.client row: browser half re-exports the original client verbatim.
      client: dsh-login/connection-client
```

(Read the existing `cordis.patch.yml` first; mirror however the current file disables the `web-runtime` row and how shipped rows declare browser halves — the `client:` key syntax must match the loader's expectation; if the original `connection` row declares no `client` key because the loader uses package exports, then omit it here too and rely on the package's `./connection-client` export ONLY if the loader resolves browser halves by convention — check `packages/client/modules` (the scanner) for how a row's browser half is discovered, and copy that convention exactly.)

- [ ] **Step 4: Run** — `npx vitest run tests/connection.spec.ts` — expect PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/connection.ts src/connection.client.ts src/api-filter.ts package.json cordis.patch.yml tests/connection.spec.ts tests/helpers.ts
git commit -m "feat: identity-aware /api carrier takeover plugin"
```

---

### Task 6: Login/admin API + pages + wiring

**Files:**
- Modify: `src/login-api.ts` (login takes `{username,password}`; setup creates admin; keep logout)
- Create: `src/admin-api.ts`
- Modify: `src/login-page.ts` (username field, admin page)
- Modify: `src/index.ts`, `src/config.ts` (`dataDir` field, default `''` → `join(dshHome, '.dsh-login')`)
- Test: `tests/login-api.spec.ts` (extend), `tests/admin-api.spec.ts` (new), `tests/plugin-entry.spec.ts` (extend)

**Interfaces:**
- Produces: `createAdminRoutes(ctx, deps): WebRoute[]` where `deps = { users: UserStore; store: SessionStore }`. Routes (all JSON, 8 KB body cap like login):
  - `GET /api/auth/me` — any valid session cookie → `{username, isAdmin}`; else 401.
  - `GET /api/auth/admin/users` — admin → `{users: [{username, isAdmin, createdAt}]}`; non-admin 403.
  - `POST /api/auth/admin/users` — admin, `{username, password, isAdmin?}` → 201; duplicate 409.
  - `POST /api/auth/admin/users/password` — admin, `{username, password}` → 200; unknown 404.
  - `POST /api/auth/admin/users/remove` — admin, `{username}` → 200; refuses removing the last admin or an unknown user (409/404).
  - `GET /admin` — admin session cookie → self-contained HTML page (same DSH dark theme as login) listing users with create/remove/change-password forms calling the JSON routes above.
- Login handler now: parse `{username, password}` → `users.verify` → session cookie (`store.create(record.username, record.isAdmin)`); 401 invalid; 500 when store empty (setup mode).
- Setup handler now: only when `users.isEmpty()`; body `{username, password}`; creates the (forced-admin) account.
- `/login` page chooses the setup form when `users.isEmpty()` (replacing the password-credential check).

- [ ] **Step 1: Extend/adding failing tests** — extend `tests/login-api.spec.ts`: login with `{username:'alice',password:'pw'}` sets cookie and returns ok; wrong password 401; body without username 400. New `tests/admin-api.spec.ts`: me endpoint (valid cookie 200 with body, anonymous 401); create user as admin 201, as ordinary 403; remove last admin 409; password change 200 then login with new password works (wire login + admin handlers against one UserStore/MemoryCredentials). Extend `tests/plugin-entry.spec.ts`: with `dataDir` set, apply() registers `/login`, `/api/auth/*`, `/admin`, admin routes, and mounts the connection takeover (fake webServer records a second plugin's `/api` prefix route).

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement.** `src/login-api.ts` login section becomes:

```ts
let parsed: { username?: unknown; password?: unknown }
// … JSON.parse as before …
if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') { /* 400 */ }
const record = await deps.users.verify(parsed.username, parsed.password)
if (record === undefined) { res.writeHead(401); res.end(JSON.stringify({ error: 'invalid credentials' })); return }
const session = store.create(record.username, record.isAdmin)
res.setHeader('Set-Cookie', buildCookieHeader(session.token, config.sessionTtl))
```

Setup section: gate on `await deps.users.isEmpty()`, then `await deps.users.create(parsed.username, parsed.password, true)`; drop `announcePasswordSet` and the credentials-storage helpers (no longer used — verify with grep before deleting; keep them if another caller exists).

`src/admin-api.ts` skeleton (follow login-api's readBody/error style; extract `readBody` into a shared `src/http-json.ts` used by both files):

```ts
export interface AdminDeps { users: UserStore; store: SessionStore }

function requireSession(deps: AdminDeps, req: IncomingMessage): Session | undefined {
  const token = extractSessionToken(req.headers.cookie)
  return token === undefined ? undefined : deps.store.verify(token)
}

export function createAdminRoutes(deps: AdminDeps): WebRoute[] {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const me: WebRoute = { kind: 'exact', path: '/api/auth/me', handler: async (req, res) => {
    const session = requireSession(deps, req)
    if (session === undefined) return json(res, 401, { error: 'authentication required' })
    return json(res, 200, { username: session.user, isAdmin: session.isAdmin })
  } }
  // users / password / remove: requireSession + isAdmin gate (403), then UserStore calls:
  //   create → 201 {ok:true} | 409 {error:'user exists'} | 400 invalid input
  //   password → 200 {ok:true} | 404 unknown user | 400 empty password
  //   remove → refuse when target is the ONLY admin: count admins via users.list() → 409;
  //            else users.remove → 200 | 404
  // adminPage: GET /admin → session?.isAdmin ? renderAdminPage() : 302 /login
  return [me, usersList, userCreate, userPassword, userRemove, adminPage]
}
```

`src/login-page.ts`: `renderLoginPage()` gains a username input (`<input name="username" autocomplete="username" required>` before the password field; the inline JS sends `{username, password}`); `renderSetupPage()` gains the same username field and POSTs `{username, password}` to `/api/auth/setup`; add `renderAdminPage(): string` — same CSS block, a table of users, and three small forms POSTing the admin JSON routes with `fetch`, refreshing on success. No template engine; keep string-template style used by the existing file.

`src/config.ts`: add `dataDir: string` (`z.string().default('')`). `src/index.ts` wiring:

```ts
const users = new UserStore(ctx.credentials, credentialRef(`${config.password}_USERS`))
const dataDir = config.dataDir === '' ? join(resolveDshHome(), '.dsh-login') : config.dataDir
const ownership = new OwnershipIndex(join(dataDir, 'ownership.json'))
// …existing routes… plus:
for (const route of createAdminRoutes({ users, store })) {
  ctx.effect(() => ctx.webServer.register(route), `dsh-login: ${route.path}`)
}
// /login page: const html = (await users.isEmpty()) ? renderSetupPage() : renderLoginPage()
ctx.effect(() => {
  const child = ctx.plugin(createConnectionPlugin({ store, ownership, trustedHosts: config.trustedHosts }))
  return () => { void child.stop?.() }
}, 'dsh-login: connection takeover')
// teardown flush:
ctx.effect(() => () => { void ownership.flush() }, 'dsh-login: ownership flush')
```

`resolveDshHome()` = `process.env.DSH_HOME || join(homedir(), '.dsh')` (reuse the pattern already in `login-api.ts`'s `credentialsStoragePath`; extract to `src/http-json.ts` or a tiny `src/paths.ts`).

The login route's setup check changes from `ctx.credentials.describe(ref)` to `users.isEmpty()`; the old single-password ref remains configured but unused (documented in README).

- [ ] **Step 4: Run** — `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: multi-user login, admin API and pages, index wiring"
```

---

### Task 7: End-to-end isolation test

**Files:**
- Modify: `tests/integration-runner.mjs` / new `tests/integration/multiuser.mjs` following the existing runner pattern

**Interfaces:** Consumes the composed plugin (Task 6 wiring) against a fake webServer + fake apiProxy; drives HTTP-level requests with two session cookies.

**Scenario (assert all):**
1. Empty users → `POST /api/auth/setup {alice}` → admin; login as alice works; `GET /api/auth/me` → admin true.
2. Alice (admin) creates bob via admin route; bob logs in (`me` → isAdmin false).
3. Fake apiProxy returns sessions `s-alice`, `s-bob`, `s-orphan` (list), and records prompts. alice's `session.list` sees all three; bob's sees only `s-bob`.
4. bob `session.create` → new id recorded to bob; alice lists it, bob lists it, a third user carol does not.
5. bob `session.prompt {s-alice}` → envelope error `forbidden`; alice `prompt {s-bob}` → allowed (admin).
6. bob `GET /api/session.export?sessionId=s-alice` → 403; own id → forwards (fake returns 200).
7. mux stream: fake `events.mux` yields frames for `s-alice` and `s-bob`; bob's wrapped stream yields only `s-bob` frames; alice sees both.
8. bob `POST /api/credentials.set` → 403 at the physical layer; alice (admin, loopback host header) passes to the proxy.
9. remove alice (last admin) → 409.

- [ ] **Step 1: Write the scenario test** following the runner's existing bootstrap (look at `tests/integration-runner.mjs` for how it builds the plugin context and fake server; reuse its helpers verbatim).
- [ ] **Step 2: Run** — `npx vitest run tests/integration` or the runner's npm script — fix until green.
- [ ] **Step 3: Commit** — `git commit -m "test: end-to-end multi-user isolation scenario"`

---

### Task 8: Docs & memory updates

**Files:**
- Modify: `README.md`, `README.zh.md` (multi-user section: admin setup, admin page, permission model, takeover note + upstream-follow risk, ownership file location, migration note — old single password no longer logs anyone in)
- Modify: `.claude/rules/architecture.md`, `modules.md`, `api.md`, `gotchas.md`, `changelog.md` to match the new modules/routes/decisions
- Run full suite once more: `npx vitest run`
- Commit: `git commit -m "docs: multi-user gateway documentation"`

## Self-Review (completed during planning)

- Spec coverage: user store (T1), sessions (T2), ownership (T3), api-filter incl. frames (T4), carrier takeover incl. WS + session.export (T5), auth surface/admin (T6), concurrency/e2e (T7), risks/docs (T8). ✔
- Known deviations to verify at implementation time (flagged inline, not placeholders): exact `RpcMethodMap` key spellings for `USER_ALLOWED` (T4/T5); browser-half discovery convention for the new row (T5); `MemoryCredentials.set` existence (T1).
- Type consistency: `AuthUser`, `createUserProxy`, `ownedSessionIds`, `isUserAllowed`, `createConnectionPlugin(deps)` used identically across T4–T6.
