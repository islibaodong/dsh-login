# DSH Login Plugin Design

**Date:** 2026-08-17  
**Status:** Approved (amended 2026-08-17: first-time setup flow)  
**Approach:** B - Authentication Gateway Plugin (no DSH core modifications)

## Amendment: First-Time Setup Flow

The original design required the password to be pre-configured via the
`DSH_LOGIN_PASSWORD` environment variable. The amended behavior removes that
requirement:

1. **Detection:** the `/login` page handler calls `ctx.credentials.describe(ref)`.
   While `configured === false`, `/login` renders the setup page
   (`renderSetupPage()`) instead of the login form.
2. **Setup endpoint:** `POST /api/auth/setup` accepts `{ password: string }`
   and stores it via `ctx.credentials.set(ref, value)`, which the local
   credentials provider persists to its writable file source.
3. **Security gate:** `/api/auth/setup` first re-checks `describe(ref)`; once a
   password exists it answers 403 `{ error: 'password already set' }`, so the
   endpoint cannot be used to hijack an already-configured instance.
4. **Setup page UX:** two inputs (password + confirmation) validated
   client-side (non-empty, match) before the POST; on success it redirects to
   `/`, which then shows the normal login page.

All original sections below remain in force, with this flow added on top.

## Purpose

Protect the DSH Web GUI with single-password authentication when the server is
exposed on `0.0.0.0` or a public network. The plugin registers a `prefix /`
HTTP route that acts as an authentication gateway: unauthenticated requests are
redirected to a login page, authenticated requests are served static files from
the frontend dist directory.

## Background

DSH's `WebServer` service (`ctx.webServer`) provides an HTTP route table with
exact and prefix routes (longest-prefix-wins), a single fallback handler, and
WebSocket upgrade routes. There is no global request middleware. The existing
security layer is `isTrustedApiRequest` in `client-connection`, which checks the
request's host authority (loopback or configured `trustedHosts`) — this is host
trust, not user authentication.

### Key constraint

A `prefix /` route registered by the plugin will match all requests not claimed
by a more specific exact or longer prefix route. The `/api` prefix (registered
by `client-connection`) is longer than `/`, so `/api/*` requests are handled by
`client-connection` and **cannot** be intercepted by the gateway. WebSocket
upgrade routes are in a separate table and are likewise not affected by HTTP
route registration. This means:

- **Protected:** page navigation (`/`), static assets (`/assets/*`), SPA routes.
- **Not protected by the gateway:** API requests (`/api/*`), WebSocket upgrades.
- **Existing protection for API/WebSocket:** `isTrustedApiRequest` host trust.

This tradeoff was explicitly accepted when the user chose Approach B.

## Architecture

```
Request → WebServer
  │
  ├─ exact route match? → call handler
  │   ├─ /login            → dsh-login: login page HTML
  │   ├─ /api/auth/login   → dsh-login: POST verify password, set cookie
  │   └─ /api/auth/logout  → dsh-login: POST revoke session, clear cookie
  │
  ├─ prefix route match (longest-prefix-wins)?
  │   ├─ /api/*            → client-connection (host trust check)
  │   └─ /*                → dsh-login: auth gateway (★ new)
  │                          ├─ no valid cookie → 302 /login
  │                          └─ valid cookie   → serveStatic()
  │
  └─ fallback              → frontend-static (superseded by prefix /)
```

### Route registration order

The plugin registers these routes on `ctx.webServer`:

| Route | Kind | Purpose |
|-------|------|---------|
| `/login` | exact | GET: return login page HTML |
| `/api/auth/login` | exact | POST: verify password, create session, set cookie |
| `/api/auth/logout` | exact | POST: revoke session, clear cookie |
| `/` | prefix | Auth gateway + static file serving |

Because exact routes are checked before prefix routes, `/login` and
`/api/auth/login` match before the `prefix /` gateway. Because the `/api`
prefix (from `client-connection`) is longer than `/`, `/api/*` requests go to
`client-connection`.

### Relationship with frontend-static

When `dsh-login` registers `prefix /`, it takes over all non-API, non-exact
requests. The `frontend-static` fallback handler is no longer reached for these
requests. Users may either:

- Disable `frontend-static` in their composition (recommended, avoids dead
  code), or
- Keep it enabled (harmless — its fallback is simply never called while
  `dsh-login`'s `prefix /` route is active).

The plugin reuses `frontend-static`'s exported `serveStatic()` function for
file serving, preserving identical static-serve semantics (traversal rejection,
SPA fallback, MIME types, index-tap injection).

## Components

### 1. Session Store (`src/session.ts`)

In-memory session token store with automatic TTL expiry.

```ts
interface Session {
  token: string        // 32-byte random, hex-encoded
  createdAt: number   // epoch ms
  expiresAt: number    // epoch ms
}

class SessionStore {
  constructor(ttlSeconds: number)
  create(): Session     // generate token, store, return
  verify(token: string): boolean  // check existence + not expired
  revoke(token: string): void     // delete session
  cleanup(): void      // remove expired sessions (called on each verify)
}
```

- Token: 32 bytes from `crypto.randomBytes`, hex-encoded (64 chars).
- No persistent storage — sessions are lost on restart (acceptable for
  single-password local/edge deployment).
- `cleanup()` runs opportunistically inside `verify()` to avoid a timer
  dependency. The Cordis `timer` service is not used to keep the plugin
  dependency-free.

### 2. Auth (`src/auth.ts`)

Password verification and cookie management.

```ts
// Constant-time password comparison using crypto.timingSafeEqual
function verifyPassword(input: string, expected: string): boolean

// Parse dsh_session token from Cookie header
function extractSessionToken(cookieHeader: string | undefined): string | undefined

// Build Set-Cookie header value
function buildCookieHeader(token: string, ttlSeconds: number): string
function buildClearCookieHeader(): string
```

- Cookie name: `dsh_session`
- Attributes: `HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>`
- Password comparison: `crypto.timingSafeEqual` over equal-length buffers to
  prevent timing attacks.

### 3. Gateway (`src/gateway.ts`)

The `prefix /` route handler — the core of the plugin.

```ts
function createGateway(ctx: Context, config: Config, store: SessionStore): WebRoute['handler']
```

Handler logic:
1. Extract `dsh_session` token from `req.headers.cookie`.
2. `store.verify(token)`:
   - **Invalid/missing:** `res.writeHead(302, { Location: '/login' }); res.end()`
   - **Valid:** proceed to step 3.
3. Call `serveStatic(pathname, res, distRoot, distIndex, renderIndex)` where:
   - `pathname` = decoded URL pathname from `req.url`
   - `distRoot` = `path.dirname(config.distIndex)`
   - `distIndex` = `config.distIndex`
   - `renderIndex` = `async () => ctx.webServer.applyIndexTaps(await readFile(distIndex))`

This reuses `serveStatic` from `@deepseek-ai/dsh-host-frontend-static`, which
handles path traversal rejection, SPA fallback to index.html, MIME types, and
non-GET/HEAD rejection.

### 4. Login Page (`src/login-page.ts`)

Returns self-contained HTML (no external assets).

- Dark theme matching DSH's default dark palette.
- Centered card with password input + submit button.
- Inline JS: `POST /api/auth/login` with `{ password }` JSON body.
  - 200 → `window.location = '/'`
  - 401 → show error message, clear input
- No framework, no dependencies — plain HTML/CSS/JS.

### 5. Login API (`src/login-api.ts`)

Two exact routes for authentication endpoints.

**`POST /api/auth/login`**
1. Read request body (JSON: `{ password: string }`).
2. Resolve expected password from DSH credentials system via `credentialRef`.
3. `verifyPassword(input, expected)`:
   - Match → `store.create()`, `res.setHeader('Set-Cookie', ...)`, `res.writeHead(200)`, `res.end(JSON.stringify({ ok: true }))`
   - No match → `res.writeHead(401)`, `res.end(JSON.stringify({ error: 'invalid credentials' }))`

**`POST /api/auth/logout`**
1. Extract session token from Cookie.
2. If present: `store.revoke(token)`.
3. `res.setHeader('Set-Cookie', buildClearCookieHeader())`, `res.writeHead(200)`, `res.end()`.

### 6. Config (`src/config.ts`)

```ts
interface Config {
  // Credential reference name for the password (e.g. 'DSH_LOGIN_PASSWORD')
  password: string
  // Absolute path to index.html in the frontend dist directory
  distIndex: string
  // Session lifetime in seconds (default: 604800 = 7 days)
  sessionTtl: number
  // Whether the gateway is active (default: true). When false, the plugin
  // registers no routes and frontend-static's fallback serves as usual.
  enabled: boolean
}
```

The `password` field is a credential reference name, resolved at runtime via
`ctx.credentials.resolve(credentialRef(password))` from the DSH credentials
system. The actual password value never appears in configuration files.

### 7. Plugin Entry (`src/index.ts`)

```ts
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-login'
export const inject = ['webServer', 'credentials']

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return
  const store = new SessionStore(config.sessionTtl)
  // Register /login (exact)
  // Register /api/auth/login (exact)
  // Register /api/auth/logout (exact)
  // Register / (prefix) — gateway
}
```

- `inject: ['webServer', 'credentials']` — both are hard dependencies.
- All four route disposers are registered via `ctx.effect()` for clean
  teardown on stop/update/undefine.

## Security Analysis

### Protected by the gateway

| Asset | Protection |
|-------|-----------|
| Page navigation (`/`) | ✓ 302 redirect to `/login` if unauthenticated |
| Static assets (`/assets/*.js`, `.css`, etc.) | ✓ Same gateway check |
| SPA routes (`/conversations`, `/settings`, etc.) | ✓ Same gateway check |

### Not protected by the gateway

| Asset | Existing protection |
|-------|-------------------|
| API requests (`/api/*`) | `isTrustedApiRequest` host trust (loopback or `trustedHosts`) |
| WebSocket (`/api/events.mux`, `/api/events.host`) | `isTrustedApiRequest` host trust |

### Recommendations for public exposure

1. Set `trustedHosts` to only the specific hosts that should access the API.
2. Use a reverse proxy (nginx/caddy) with TLS termination in front of DSH.
3. The gateway cookie is `SameSite=Strict`, protecting against CSRF on the
   login/logout endpoints.

### Threat model

- **Casual snooping:** Unauthenticated users cannot see the UI or any page
  content. ✓
- **Direct API access without UI:** Possible if the attacker knows the API
  format and the host trust check passes. Mitigated by `trustedHosts`. ⚠
- **Session hijacking:** Cookie is `HttpOnly` (no JS access) and
  `SameSite=Strict`. Token is 256-bit random. Acceptable for the threat model. ✓
- **Timing attack on password:** `timingSafeEqual` prevents this. ✓

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Wrong password | 401 + `{ error: 'invalid credentials' }` |
| Expired session | Treated as unauthenticated → 302 `/login` |
| Missing/invalid cookie | Treated as unauthenticated → 302 `/login` |
| `distIndex` file not found at startup | Log warning; gateway serves 500 on index requests |
| `serveStatic` file read error | SPA fallback to index.html (by `serveStatic`) |
| Malformed login JSON body | 400 + `{ error: 'bad request' }` |
| `credentials.resolve()` returns undefined | 500 + `{ error: 'password not configured' }` |

## Testing Strategy

- **Unit tests:** `SessionStore` create/verify/revoke/cleanup/expiry;
  `verifyPassword` timing-safe comparison; `extractSessionToken` cookie parsing;
  `buildCookieHeader` attribute correctness.
- **Integration tests:** Register routes on a test `WebServer`; send requests
  with/without valid cookies; assert redirect, static file serving, login
  flow, logout flow.
- **E2E consideration:** Full browser-based login flow can be tested via the
  DSH web e2e harness, but is out of scope for the initial implementation.

## Composition Example

```yaml
# cordis.patch.yml — user patch layer
- id: dsh-login
  config:
    password: DSH_LOGIN_PASSWORD  # credential ref name
    distIndex: !!js |
      // Typically a workspace-knowledge path expression
      require('path').join(__dirname, 'dist/index.html')
    sessionTtl: 604800
    enabled: true

# Optional: disable frontend-static since dsh-login takes over prefix /
# - id: frontend-static
#   disable: true
```

## Dependencies

| Package | Role |
|---------|------|
| `@deepseek-ai/cordis` | Plugin framework, Context, Service |
| `@deepseek-ai/schemastery` | Config schema |
| `@deepseek-ai/dsh-host-webserver` | WebServer service (route registration) |
| `@deepseek-ai/dsh-host-frontend-static` | `serveStatic()` reuse |
| `@deepseek-ai/dsh-credentials` | `credentialRef()`, password resolution |
| `node:crypto` | `randomBytes`, `timingSafeEqual` |
| `node:fs/promises` | `readFile` for index.html |
| `node:path` | `dirname`, path manipulation |

## Out of Scope

- User management (multi-user, roles) — single password only.
- OAuth / third-party login.
- Persistent sessions across restarts.
- API/WebSocket user-level authentication (requires WebServer middleware —
  see Approach A in the design comparison).
- TLS/HTTPS termination (reverse proxy concern).
