# DSH Login Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DSH plugin package (`dsh-login`) that protects the Web GUI with single-password authentication using a `prefix /` HTTP route gateway.

**Architecture:** The plugin registers on `ctx.webServer`: three exact routes (`/login`, `/api/auth/login`, `/api/auth/logout`) and one `prefix /` route. The gateway handler checks a `dsh_session` cookie; unauthenticated requests redirect to `/login`, authenticated requests are served static files by reusing `serveStatic()` from `@deepseek-ai/dsh-host-frontend-static`. Sessions are in-memory with TTL expiry. Password is resolved from the DSH credentials system via `credentialRef`.

**Tech Stack:** TypeScript, Node.js (`node:crypto`, `node:fs/promises`, `node:http`, `node:path`), `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-dsh-login-plugin-design.md`

## Global Constraints

- **Language:** TypeScript, strict mode, `module: esnext`, `moduleResolution: bundler`, `target: es2024` — matching DSH's `tsconfig.base.json`.
- **Runtime:** Node.js. Uses `node:crypto` (`randomBytes`, `timingSafeEqual`), `node:fs/promises` (`readFile`), `node:path` (`dirname`), `node:http` types only.
- **Package type:** `"type": "module"` — all imports use `.ts` extensions internally (the DSH `tsconfig.base.json` has `allowImportingTsExtensions: true`).
- **No bundler:** Tests run through `tsx` via vitest. Source is `.ts`, imports use `.ts` extensions. The package exports `./src/*` for composition-level resolution, matching DSH's `frontend-static` pattern.
- **Peer dependencies:** `@deepseek-ai/cordis`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-host-frontend-static`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-credentials-local` (for testing), `@deepseek-ai/dsh-invariants`, `@deepseek-ai/schemastery` — all `workspace:^` when in DSH monorepo, or version-pinned when standalone.
- **Cookie name:** `dsh_session` — hardcoded constant.
- **Session token:** 32 bytes `crypto.randomBytes`, hex-encoded (64 chars).
- **Cookie attributes:** `HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>`.
- **Plugin name:** `dsh-login` (Cordis stable name).
- **Inject:** `['webServer', 'credentials']` — both are hard dependencies.
- **Test pattern:** Vitest, test files at `tests/*.spec.ts`, following the DSH convention. The DSH vitest config includes `packages/*/*/tests/**/*.spec.ts`, but since this is a standalone project, it uses its own `vitest.config.ts`.
- **TDD:** Every task writes the failing test first, then the minimal implementation.

---

## File Structure

```
E:\code\dsh-login\
├── package.json                  # @deepseek-ai/dsh-login package definition
├── tsconfig.json                 # TypeScript project config
├── vitest.config.ts              # Vitest test runner config
├── src/
│   ├── index.ts                  # Cordis plugin entry: exports name, inject, Config, apply
│   ├── config.ts                 # Config interface + schemastery schema
│   ├── session.ts                # SessionStore: in-memory token store with TTL
│   ├── auth.ts                   # verifyPassword, extractSessionToken, cookie headers
│   ├── gateway.ts                # createGateway: the prefix / route handler
│   ├── login-page.ts             # renderLoginPage: returns self-contained HTML
│   └── login-api.ts              # createLoginHandler, createLogoutHandler: exact route handlers
├── tests/
│   ├── memory-credentials.ts     # Test-only in-memory CredentialProvider (reuse from DSH pattern)
│   ├── session.spec.ts           # SessionStore unit tests
│   ├── auth.spec.ts              # verifyPassword, extractSessionToken, cookie header tests
│   ├── login-page.spec.ts        # renderLoginPage HTML structure tests
│   ├── gateway.spec.ts           # Gateway integration: redirect when unauthenticated, serve when authenticated
│   └── login-api.spec.ts        # Login/logout endpoint integration tests
├── docs/
│   └── superpowers/
│       ├── specs/                # (already exists) design spec
│       └── plans/                # (already exists) this plan
├── cordis.patch.yml              # Composition example for users
└── README.md                     # User-facing documentation
```

**Responsibility boundaries:**
- `session.ts` — only session lifecycle (create/verify/revoke/cleanup). No HTTP, no crypto beyond `randomBytes`.
- `auth.ts` — only password comparison and cookie string construction/parsing. No HTTP response writing.
- `gateway.ts` — only the `prefix /` handler: cookie check → redirect or `serveStatic`. No login logic.
- `login-api.ts` — only the login/logout endpoint handlers: body parsing → credential resolution → session create/revoke → response writing.
- `login-page.ts` — only HTML generation. No logic, no I/O.
- `config.ts` — only the schema and interface. No runtime logic.
- `index.ts` — only wiring: instantiate store, create handlers, register routes, return disposers.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: a runnable `pnpm install && pnpm test` project skeleton with zero tests passing (vitest exits 0 with "no tests found" or fails on import — either is acceptable for this step; we just need the toolchain configured).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@deepseek-ai/dsh-login",
  "description": "Single-password authentication gateway plugin for the DSH Web GUI",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "default": "./src/index.ts"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=0.1.0",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.0",
    "@deepseek-ai/dsh-host-frontend-static": ">=0.1.0",
    "@deepseek-ai/dsh-credentials": ">=0.1.0",
    "@deepseek-ai/dsh-invariants": ">=0.1.0",
    "@deepseek-ai/schemastery": ">=0.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": ">=0.1.0",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.0",
    "@deepseek-ai/dsh-host-frontend-static": ">=0.1.0",
    "@deepseek-ai/dsh-credentials": ">=0.1.0",
    "@deepseek-ai/dsh-credentials-local": ">=0.1.0",
    "@deepseek-ai/dsh-invariants": ">=0.1.0",
    "@deepseek-ai/schemastery": ">=0.1.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Tests import .ts source files directly through tsx; first resolution
    // after a cold cache is slow on some hosts.
    testTimeout: 60_000,
  },
  resolve: {
    // Let DSH workspace packages resolve through their installed locations.
    // When running inside the DSH monorepo, pnpm symlinks make these resolve
    // to source; when standalone, they resolve to node_modules lib.
    alias: {},
  },
})
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
lib/
*.tsbuildinfo
coverage/
```

- [ ] **Step 5: Initialize git and make first commit**

Run:
```bash
cd E:\code\dsh-login
git init
git add package.json tsconfig.json vitest.config.ts .gitignore docs/
git commit -m "chore: scaffold dsh-login plugin project"
```

Expected: commit succeeds.

---

## Task 2: Session Store (`src/session.ts`)

**Files:**
- Create: `src/session.ts`
- Test: `tests/session.spec.ts`

**Interfaces:**
- Produces: `SessionStore` class with:
  - `constructor(ttlSeconds: number)`
  - `create(): { token: string; createdAt: number; expiresAt: number }`
  - `verify(token: string): boolean`
  - `revoke(token: string): void`
  - `cleanup(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/session.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.spec.ts`
Expected: FAIL — `Cannot find module '../src/session.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/session.ts`:

```ts
import { randomBytes } from 'node:crypto'

/** One created session with its token and expiry timestamps. */
export interface Session {
  token: string
  createdAt: number
  expiresAt: number
}

/**
 * In-memory session token store with automatic TTL expiry. Sessions are lost
 * on process restart — acceptable for single-password local/edge deployment.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session.spec.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.spec.ts
git commit -m "feat: add SessionStore with TTL-based in-memory session management"
```

---

## Task 3: Auth Utilities (`src/auth.ts`)

**Files:**
- Create: `src/auth.ts`
- Test: `tests/auth.spec.ts`

**Interfaces:**
- Produces:
  - `COOKIE_NAME` constant: `'dsh_session'`
  - `verifyPassword(input: string, expected: string): boolean`
  - `extractSessionToken(cookieHeader: string | undefined): string | undefined`
  - `buildCookieHeader(token: string, ttlSeconds: number): string`
  - `buildClearCookieHeader(): string`

- [ ] **Step 1: Write the failing test**

Create `tests/auth.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  COOKIE_NAME,
  verifyPassword,
  extractSessionToken,
  buildCookieHeader,
  buildClearCookieHeader,
} from '../src/auth.ts'

describe('verifyPassword', () => {
  it('returns true for matching strings', () => {
    expect(verifyPassword('s3cret', 's3cret')).toBe(true)
  })

  it('returns false for non-matching strings', () => {
    expect(verifyPassword('s3cret', 'wrong')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(verifyPassword('', 's3cret')).toBe(false)
  })

  it('returns false for different-length strings', () => {
    expect(verifyPassword('short', 'longerpassword')).toBe(false)
  })
})

describe('extractSessionToken', () => {
  it('extracts the dsh_session token from a cookie header', () => {
    const header = 'dsh_session=abc123; other=val'
    expect(extractSessionToken(header)).toBe('abc123')
  })

  it('returns undefined when the cookie header is missing', () => {
    expect(extractSessionToken(undefined)).toBeUndefined()
  })

  it('returns undefined when dsh_session is not present', () => {
    expect(extractSessionToken('other=val')).toBeUndefined()
  })

  it('handles the cookie being the only value', () => {
    expect(extractSessionToken('dsh_session=token123')).toBe('token123')
  })

  it('handles the cookie being the last value', () => {
    expect(extractSessionToken('other=val; dsh_session=lasttoken')).toBe('lasttoken')
  })

  it('returns undefined for a malformed cookie header', () => {
    expect(extractSessionToken('garbage')).toBeUndefined()
  })
})

describe('buildCookieHeader', () => {
  it('builds a Set-Cookie value with all required attributes', () => {
    const header = buildCookieHeader('mytoken', 3600)
    expect(header).toBe('dsh_session=mytoken; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600')
  })

  it('uses the provided TTL in Max-Age', () => {
    const header = buildCookieHeader('tok', 604800)
    expect(header).toContain('Max-Age=604800')
  })
})

describe('buildClearCookieHeader', () => {
  it('builds a Set-Cookie that expires immediately', () => {
    const header = buildClearCookieHeader()
    expect(header).toBe('dsh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  })
})

describe('COOKIE_NAME', () => {
  it('is the string dsh_session', () => {
    expect(COOKIE_NAME).toBe('dsh_session')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth.spec.ts`
Expected: FAIL — `Cannot find module '../src/auth.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/auth.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'

/** The HTTP cookie name carrying the session token. */
export const COOKIE_NAME = 'dsh_session'

/**
 * Constant-time password comparison. Returns false for empty input or
 * different-length strings without touching the timing of the comparison.
 */
export function verifyPassword(input: string, expected: string): boolean {
  if (input.length === 0 || input.length !== expected.length) return false
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  return timingSafeEqual(a, b)
}

/**
 * Parse the session token from a Cookie header value.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function extractSessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1)
    }
  }
  return undefined
}

/** Build a Set-Cookie header value that sets the session token. */
export function buildCookieHeader(token: string, ttlSeconds: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(ttlSeconds)}`
}

/** Build a Set-Cookie header value that clears the session token. */
export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth.spec.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts tests/auth.spec.ts
git commit -m "feat: add auth utilities for password verification and cookie management"
```

---

## Task 4: Login Page (`src/login-page.ts`)

**Files:**
- Create: `src/login-page.ts`
- Test: `tests/login-page.spec.ts`

**Interfaces:**
- Produces: `renderLoginPage(): string` — returns a complete HTML document as a string.

- [ ] **Step 1: Write the failing test**

Create `tests/login-page.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderLoginPage } from '../src/login-page.ts'

describe('renderLoginPage', () => {
  const html = renderLoginPage()

  it('returns a complete HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains a password input field', () => {
    expect(html).toContain('type="password"')
    expect(html).toContain('id="password"')
  })

  it('contains a submit button', () => {
    expect(html).toContain('type="submit"')
  })

  it('contains the login endpoint URL in inline JS', () => {
    expect(html).toContain('/api/auth/login')
  })

  it('redirects to root on success', () => {
    expect(html).toContain("window.location")
    expect(html).toContain("'/'")
  })

  it('shows an error message on 401', () => {
    expect(html).toContain('401')
    expect(html).toLowerCase()
  })

  it('is self-contained with no external resources', () => {
    expect(html).not.toContain('src="http')
    expect(html).not.toContain('href="http')
    expect(html).not.toContain('<link')
  })

  it('uses a dark background color', () => {
    expect(html).toContain('background')
    expect(html).toMatch(/dark|#1|#0|#2[0-9a-f]/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/login-page.spec.ts`
Expected: FAIL — `Cannot find module '../src/login-page.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/login-page.ts`:

```ts
/**
 * Render the self-contained login page HTML. No external assets — the page
 * is a single HTML document with inline CSS and JS, matching the DSH dark
 * theme. The inline JS POSTs to /api/auth/login and redirects to / on
 * success, or shows an error message on failure.
 */
export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #16213e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      max-width: 90vw;
    }
    .card h1 {
      font-size: 1.5rem;
      margin-bottom: 24px;
      text-align: center;
      color: #e0e0e0;
    }
    .card input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      margin-bottom: 16px;
      outline: none;
    }
    .card input[type="password"]:focus {
      border-color: #4a4a6a;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #4a6fa5;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card button[type="submit"]:hover {
      background: #5a7fb5;
    }
    .card button[type="submit"]:disabled {
      background: #3a3a5a;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.875rem;
      text-align: center;
      margin-bottom: 16px;
      min-height: 1.25rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <input type="password" id="password" placeholder="Password" autocomplete="current-password" autofocus>
      <button type="submit" id="submit">Login</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const input = document.getElementById('password');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = 'Invalid password';
          input.value = '';
          input.focus();
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else if (res.status === 500) {
          error.textContent = 'Server error — password not configured';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Login';
      }
    });
  </script>
</body>
</html>`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/login-page.spec.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/login-page.ts tests/login-page.spec.ts
git commit -m "feat: add self-contained dark-themed login page HTML"
```

---

## Task 5: Config Schema (`src/config.ts`)

**Files:**
- Create: `src/config.ts`

**Interfaces:**
- Produces: `Config` interface and `Config` schemastery schema.
- Consumes: `@deepseek-ai/schemastery` for schema definition.

- [ ] **Step 1: Create the config module**

This task has no separate test file — the schema is exercised in the integration tests of Task 7 (plugin entry). The schema is a pure data definition with no runtime logic to unit-test independently.

Create `src/config.ts`:

```ts
import z from '@deepseek-ai/schemastery'

/** Plugin configuration for the dsh-login authentication gateway. */
export interface Config {
  /** Credential reference name for the password (e.g. 'DSH_LOGIN_PASSWORD'). */
  password: string
  /** Absolute path to index.html in the frontend dist directory. */
  distIndex: string
  /** Session lifetime in seconds (default: 604800 = 7 days). */
  sessionTtl: number
  /** Whether the gateway is active (default: true). When false, the plugin
   * registers no routes and frontend-static's fallback serves as usual. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  password: z.string().required(),
  distIndex: z.string().required(),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
})
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: no errors (or only errors from missing peer dependency types if they aren't installed yet — in that case, proceed to Task 6 and run the full typecheck after the plugin entry is complete).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config schema for dsh-login plugin"
```

---

## Task 6: Gateway Handler (`src/gateway.ts`)

**Files:**
- Create: `src/gateway.ts`
- Create: `tests/memory-credentials.ts` (test helper)
- Test: `tests/gateway.spec.ts`

**Interfaces:**
- Consumes:
  - `SessionStore` from `./session.ts` (Task 2)
  - `extractSessionToken`, `COOKIE_NAME` from `./auth.ts` (Task 3)
  - `serveStatic` from `@deepseek-ai/dsh-host-frontend-static`
  - `WebRoute` type from `@deepseek-ai/dsh-host-webserver`
  - `Context` from `@deepseek-ai/cordis`
  - `Config` from `./config.ts` (Task 5)
- Produces: `createGateway(ctx, config, store): WebRoute['handler']`

- [ ] **Step 1: Create test helper `tests/memory-credentials.ts`**

This is a minimal in-memory CredentialProvider for tests, following the DSH `credentials` package's test pattern. It allows tests to seed a password value without needing the real credentials-local provider or environment variables.

Create `tests/memory-credentials.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** In-memory credentials provider for tests: seeds values from a record. */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) return Promise.reject(new Error('empty value'))
    this.store.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/gateway.spec.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from './memory-credentials.ts'
import { SessionStore } from '../src/session.ts'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootServer(): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gateway-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-webserver', HttpServer]])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return { ctx: context, port: context.webServer.port }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: await response.text(), headers: response.headers }
}

const config: Config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '/nonexistent/index.html',
  sessionTtl: 3600,
  enabled: true,
}

describe('gateway handler', () => {
  it('redirects unauthenticated requests to /login', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const store = new SessionStore(3600)
    const handler = createGateway(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/', handler }), 'gateway')
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves static files when authenticated', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>shell</body></html>')
    const store = new SessionStore(3600)
    const session = store.create()
    const cfg = { ...config, distIndex }
    const handler = createGateway(ctx, cfg, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/', handler }), 'gateway')
    const res = await request(port, '/', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it('redirects to /login when cookie is invalid', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const store = new SessionStore(3600)
    const handler = createGateway(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/', handler }), 'gateway')
    const res = await request(port, '/', {
      headers: { Cookie: 'dsh_session=invalidtoken' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves SPA fallback (index.html) for unknown paths when authenticated', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootServer()
    const dist = join(root!, 'dist')
    await mkdir(dist, { recursive: true })
    const distIndex = join(dist, 'index.html')
    await writeFile(distIndex, '<html><body>spa-fallback</body></html>')
    const store = new SessionStore(3600)
    const session = store.create()
    const cfg = { ...config, distIndex }
    const handler = createGateway(ctx, cfg, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/', handler }), 'gateway')
    const res = await request(port, '/some/spa/route', {
      headers: { Cookie: `dsh_session=${session.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('spa-fallback')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/gateway.spec.ts`
Expected: FAIL — `Cannot find module '../src/gateway.ts'`

- [ ] **Step 4: Write minimal implementation**

Create `src/gateway.ts`:

```ts
import type { ServerResponse, IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import { extractSessionToken } from './auth.ts'
import type { Config } from './config.ts'

/**
 * Create the prefix / gateway handler. Unauthenticated requests are
 * redirected to /login; authenticated requests are served static files
 * via the frontend-static serveStatic function.
 */
export function createGateway(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  const distRoot = dirname(config.distIndex)
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.applyIndexTaps(await readFile(config.distIndex, 'utf8'))

  return async (req: IncomingMessage, res: ServerResponse) => {
    const token = extractSessionToken(req.headers.cookie)
    if (token === undefined || !store.verify(token)) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    store.cleanup()
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, config.distIndex, renderIndex)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/gateway.spec.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/gateway.ts tests/gateway.spec.ts tests/memory-credentials.ts
git commit -m "feat: add authentication gateway handler with static file serving"
```

---

## Task 7: Login API Handlers (`src/login-api.ts`)

**Files:**
- Create: `src/login-api.ts`
- Test: `tests/login-api.spec.ts`

**Interfaces:**
- Consumes:
  - `SessionStore` from `./session.ts` (Task 2)
  - `verifyPassword`, `buildCookieHeader`, `buildClearCookieHeader`, `extractSessionToken`, `COOKIE_NAME` from `./auth.ts` (Task 3)
  - `credentialRef` from `@deepseek-ai/dsh-credentials`
  - `Context` from `@deepseek-ai/cordis`
  - `WebRoute` type from `@deepseek-ai/dsh-host-webserver`
  - `Config` from `./config.ts` (Task 5)
- Produces:
  - `createLoginHandler(ctx, config, store): WebRoute['handler']`
  - `createLogoutHandler(ctx, config, store): WebRoute['handler']`

- [ ] **Step 1: Write the failing test**

Create `tests/login-api.spec.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from './memory-credentials.ts'
import { SessionStore } from '../src/session.ts'
import { createLoginHandler, createLogoutHandler } from '../src/login-api.ts'
import type { Config } from '../src/config.ts'
import { buildCookieHeader, COOKIE_NAME, extractSessionToken } from '../src/auth.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const config: Config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '/nonexistent/index.html',
  sessionTtl: 3600,
  enabled: true,
}

async function bootWithCreds(seed: Record<string, string> = {}): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-login-api-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-webserver', HttpServer]])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  await context.plugin(MemoryCredentials, seed)
  return { ctx: context, port: context.webServer.port }
}

async function postJson(port: number, path: string, body: unknown, cookie?: string): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie !== undefined) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let json: unknown = null
  const text = await res.text()
  if (text.length > 0) {
    try { json = JSON.parse(text) } catch { /* not JSON */ }
  }
  return { status: res.status, json, headers: res.headers }
}

describe('POST /api/auth/login', () => {
  it('returns 200 with Set-Cookie on correct password', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 's3cret' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie!).toContain('dsh_session=')
    expect(setCookie!).toContain('HttpOnly')
    expect(setCookie!).toContain('Max-Age=3600')
  })

  it('returns 401 on wrong password', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'invalid credentials' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 500 when password is not configured', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({})
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { password: 'anything' })
    expect(res.status).toBe(500)
    expect(res.json).toEqual({ error: 'password not configured' })
  })

  it('returns 400 on malformed JSON body', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when password field is missing', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler }), 'login')
    const res = await postJson(port, '/api/auth/login', { notpassword: 'x' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    // First login to get a session
    const loginHandler = createLoginHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/login', handler: loginHandler }), 'login')
    const loginRes = await postJson(port, '/api/auth/login', { password: 's3cret' })
    const setCookie = loginRes.headers.get('set-cookie')!
    const token = extractSessionToken(setCookie.split(';')[0])!

    // Now logout with that cookie
    const logoutHandler = createLogoutHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler: logoutHandler }), 'logout')
    const res = await postJson(port, '/api/auth/logout', {}, `${COOKIE_NAME}=${token}`)
    expect(res.status).toBe(200)
    const clearCookie = res.headers.get('set-cookie')
    expect(clearCookie).not.toBeNull()
    expect(clearCookie!).toContain('Max-Age=0')
    // Session is revoked
    expect(store.verify(token)).toBe(false)
  })

  it('returns 200 even without a session cookie', { timeout: 60_000 }, async () => {
    const { ctx, port } = await bootWithCreds({ DSH_LOGIN_PASSWORD: 's3cret' })
    const store = new SessionStore(3600)
    const handler = createLogoutHandler(ctx, config, store)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/auth/logout', handler }), 'logout')
    const res = await postJson(port, '/api/auth/logout', {})
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/login-api.spec.ts`
Expected: FAIL — `Cannot find module '../src/login-api.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/login-api.ts`:

```ts
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import {
  verifyPassword,
  buildCookieHeader,
  buildClearCookieHeader,
  extractSessionToken,
} from './auth.ts'
import type { Config } from './config.ts'

/** Maximum bytes to read from the login request body. */
const MAX_BODY_BYTES = 8192

/** Read the request body as a string, capped at MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.concat(chunks).length > MAX_BODY_BYTES) {
      throw new Error('body too large')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Create the POST /api/auth/login handler. Reads a JSON body, resolves the
 * expected password from the credentials system, verifies it, and on match
 * creates a session and sets the cookie.
 */
export function createLoginHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let body: string
    try {
      body = await readBody(req)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    let parsed: { password?: unknown }
    try {
      parsed = JSON.parse(body) as { password?: unknown }
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    if (typeof parsed.password !== 'string') {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    const resolved = await ctx.credentials.resolve(credentialRef(config.password))
    if (resolved === undefined) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'password not configured' }))
      return
    }
    if (!verifyPassword(parsed.password, resolved.value)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'invalid credentials' }))
      return
    }
    const session = store.create()
    res.setHeader('Set-Cookie', buildCookieHeader(session.token, config.sessionTtl))
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  }
}

/**
 * Create the POST /api/auth/logout handler. Revokes the session (if present)
 * and clears the cookie.
 */
export function createLogoutHandler(
  _ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const token = extractSessionToken(req.headers.cookie)
    if (token !== undefined) store.revoke(token)
    res.setHeader('Set-Cookie', buildClearCookieHeader())
    res.writeHead(200)
    res.end()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/login-api.spec.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/login-api.ts tests/login-api.spec.ts
git commit -m "feat: add login and logout API endpoint handlers"
```

---

## Task 8: Plugin Entry Point (`src/index.ts`)

**Files:**
- Create: `src/index.ts`
- Test: `tests/plugin-entry.spec.ts`

**Interfaces:**
- Consumes: All previous tasks.
- Produces: `name`, `inject`, `Config`, `apply` — the Cordis plugin entry point.

- [ ] **Step 1: Write the failing test**

Create `tests/plugin-entry.spec.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { MemoryCredentials } from './memory-credentials.ts'
import * as DshLogin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(seed: Record<string, string> = {}): Promise<{ ctx: Context; port: number; distIndex: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-entry-'))
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
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    "- id: login",
    "  name: '@deepseek-ai/dsh-login'",
    '  config:',
    '    password: DSH_LOGIN_PASSWORD',
    `    distIndex: '${distIndex}'`,
    '    sessionTtl: 3600',
    '    enabled: true',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
    ['@deepseek-ai/dsh-login', DshLogin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  await context.plugin(MemoryCredentials, seed)
  return { ctx: context, port: context.webServer.port, distIndex }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function login(port: number, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const setCookie = res.headers.get('set-cookie')!
  return setCookie.split(';')[0]
}

describe('dsh-login plugin (full composition)', () => {
  it('protects the root with a redirect to /login when unauthenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('serves the login page at /login', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('password')
    expect(res.body).toContain('/api/auth/login')
  })

  it('completes the full login -> access -> logout flow', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })

    // Before login: redirected
    const before = await request(port, '/')
    expect(before.status).toBe(302)

    // Login
    const cookie = await login(port, 's3cret')
    expect(cookie).toContain('dsh_session=')

    // After login: can access
    const after = await request(port, '/', { headers: { Cookie: cookie } })
    expect(after.status).toBe(200)
    expect(after.body).toContain('shell')

    // Logout
    const logoutRes = await fetch(`http://127.0.0.1:${String(port)}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    })
    expect(logoutRes.status).toBe(200)

    // After logout: redirected again
    const afterLogout = await request(port, '/', { headers: { Cookie: cookie } })
    expect(afterLogout.status).toBe(302)
  })

  it('serves static assets when authenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition({ DSH_LOGIN_PASSWORD: 's3cret' })
    const cookie = await login(port, 's3cret')
    const res = await request(port, '/index.html', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it('does not register routes when enabled: false', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-disabled-'))
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
      '- id: frontend',
      "  name: '@deepseek-ai/dsh-host-frontend-static'",
      '  config:',
      `    distIndex: '${distIndex}'`,
      "- id: login",
      "  name: '@deepseek-ai/dsh-login'",
      '  config:',
      '    password: DSH_LOGIN_PASSWORD',
      `    distIndex: '${distIndex}'`,
      '    enabled: false',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
      ['@deepseek-ai/dsh-login', DshLogin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const port = context.webServer.port
    // frontend-static's fallback serves the shell directly (no redirect)
    const res = await request(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugin-entry.spec.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/index.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'
import { Config as ConfigSchema } from './config.ts'
import { SessionStore } from './session.ts'
import { createGateway } from './gateway.ts'
import { createLoginHandler, createLogoutHandler } from './login-api.ts'
import { renderLoginPage } from './login-page.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-login'

/** Hard dependencies: the web server and credentials services. */
export const inject = ['webServer', 'credentials']

export { ConfigSchema as Config }

/**
 * Register the authentication gateway, login page, and login/logout API
 * routes on the web server. All route disposers are owned by the plugin
 * fiber via ctx.effect for clean teardown on stop/update/undefine.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const store = new SessionStore(config.sessionTtl)

  const loginPageRoute: WebRoute = {
    kind: 'exact',
    path: '/login',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderLoginPage())
    },
  }

  const loginApiRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/login',
    handler: createLoginHandler(ctx, config, store),
  }

  const logoutApiRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/logout',
    handler: createLogoutHandler(ctx, config, store),
  }

  const gatewayRoute: WebRoute = {
    kind: 'prefix',
    path: '/',
    handler: createGateway(ctx, config, store),
  }

  ctx.effect(() => ctx.webServer.register(loginPageRoute), 'dsh-login: /login')
  ctx.effect(() => ctx.webServer.register(loginApiRoute), 'dsh-login: /api/auth/login')
  ctx.effect(() => ctx.webServer.register(logoutApiRoute), 'dsh-login: /api/auth/logout')
  ctx.effect(() => ctx.webServer.register(gatewayRoute), 'dsh-login: / gateway')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugin-entry.spec.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/plugin-entry.spec.ts
git commit -m "feat: add dsh-login plugin entry point with full route registration"
```

---

## Task 9: Full Test Suite + Type Check

**Files:**
- No new files — verify all tests pass together and types are clean.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests across all spec files pass (session, auth, login-page, gateway, login-api, plugin-entry).

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: no errors. If peer dependency type resolution fails (because the packages are only available via the DSH monorepo), verify the tests pass — the runtime is the source of truth and tests run through tsx which resolves the installed packages.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: verify full suite passes and types are clean"
```

If no fixes needed, skip this step.

---

## Task 10: Composition Example + README

**Files:**
- Create: `cordis.patch.yml`
- Create: `README.md`

- [ ] **Step 1: Create `cordis.patch.yml`**

```yaml
# User patch layer for dsh-login. Apply after the dsh-web-app bundle:
#
#   dsh web --patch cordis.patch.yml
#
# Or copy these rows into your profile's cordis.patch.yml.
#
# Prerequisite: set the DSH_LOGIN_PASSWORD environment variable (or file
# credential) to your desired login password.
#
#   export DSH_LOGIN_PASSWORD='your-password-here'

- id: dsh-login
  name: '@deepseek-ai/dsh-login'
  config:
    password: DSH_LOGIN_PASSWORD
    distIndex: !!js |
      require('path').join(
        require('path').dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),
        'dist',
        'index.html'
      )
    sessionTtl: 604800
    enabled: true

# Optional: disable frontend-static since dsh-login's prefix / takes over
# its fallback seat. Leaving it enabled is harmless (the fallback is never
# reached while dsh-login is active), but disabling avoids dead code.
# - id: frontend-static
#   disable: true
```

- [ ] **Step 2: Create `README.md`**

```markdown
# dsh-login

Single-password authentication gateway plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

## What it does

When the DSH web server is exposed on `0.0.0.0` or a public network, `dsh-login` requires a password before serving the web GUI. It registers a `prefix /` HTTP route that:

- **Unauthenticated requests** → redirects to `/login`
- **Authenticated requests** → serves static files from the frontend dist directory

## Installation

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-login
```

## Configuration

Set your password as an environment variable:

```bash
export DSH_LOGIN_PASSWORD='your-password'
```

Add the plugin to your profile's `cordis.patch.yml`:

```yaml
- id: dsh-login
  name: '@deepseek-ai/dsh-login'
  config:
    password: DSH_LOGIN_PASSWORD   # credential reference name
    distIndex: /path/to/dist/index.html
    sessionTtl: 604800             # 7 days (default)
    enabled: true                 # set false to disable without uninstalling
```

## How it works

```
Request → WebServer
  ├─ /login (exact)           → login page HTML
  ├─ /api/auth/login (exact)  → POST: verify password, set cookie
  ├─ /api/auth/logout (exact) → POST: revoke session, clear cookie
  └─ / (prefix)               → auth gateway + static files
```

- **Cookie:** `dsh_session`, HttpOnly, SameSite=Strict, Path=/
- **Session:** 32-byte random token, in-memory with TTL expiry
- **Password:** constant-time comparison via `crypto.timingSafeEqual`

## Security notes

- **Protected:** page navigation, static assets, SPA routes
- **Not protected by this plugin:** API requests (`/api/*`) and WebSocket — these rely on DSH's existing `isTrustedApiRequest` host trust check
- For public exposure, use a reverse proxy (nginx/caddy) with TLS and configure `trustedHosts`

## License

MIT
```

- [ ] **Step 3: Commit**

```bash
git add cordis.patch.yml README.md
git commit -m "docs: add composition example and README"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Session Store (`src/session.ts`) | Task 2 |
| Auth (`src/auth.ts`) | Task 3 |
| Login Page (`src/login-page.ts`) | Task 4 |
| Config (`src/config.ts`) | Task 5 |
| Gateway (`src/gateway.ts`) | Task 6 |
| Login API (`src/login-api.ts`) | Task 7 |
| Plugin Entry (`src/index.ts`) | Task 8 |
| Composition Example | Task 10 |
| Error handling (wrong password → 401, missing password → 500, malformed body → 400) | Task 7 |
| HMR safety (ctx.effect disposers) | Task 8 |
| `enabled: false` no-op | Task 8 |
| Full login → access → logout flow | Task 8 |

All spec sections covered. ✓

**2. Placeholder scan:** No TBD, TODO, or "implement later". All code blocks are complete. ✓

**3. Type consistency:**
- `SessionStore.create()` returns `Session` with `token`, `createdAt`, `expiresAt` — consistent across Tasks 2, 6, 7.
- `createGateway(ctx, config, store)` signature consistent between Task 6 and Task 8.
- `createLoginHandler(ctx, config, store)` and `createLogoutHandler(ctx, config, store)` consistent between Task 7 and Task 8.
- `Config` interface fields (`password`, `distIndex`, `sessionTtl`, `enabled`) consistent across Tasks 5, 6, 7, 8.
- `COOKIE_NAME = 'dsh_session'` consistent across Tasks 3, 6, 7.
- `WebRoute` type used consistently. ✓

No issues found. Plan is complete.
