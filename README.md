# dsh-login

English | [简体中文](./README.zh.md)

Single-password authentication gateway plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

## What it does

When the DSH web server is exposed on `0.0.0.0` or a public network, `dsh-login` requires a password before serving the web GUI. It claims the webserver fallback handler, so every request not matched by a named route (like `/api/*`) goes through the authentication gateway:

- **Unauthenticated requests** -> redirects to `/login`
- **Authenticated requests** -> serves static files from the frontend dist directory

## Quick start

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-login
```

Add to your profile's `cordis.patch.yml`:

```yaml
- id: dsh-login
  name: '@deepseek-ai/dsh-login'
  config:
    password: DSH_LOGIN_PASSWORD   # credential reference name
    distIndex: /path/to/dist/index.html
    sessionTtl: 604800             # 7 days (default)
    enabled: true                 # set false to disable without uninstalling

# IMPORTANT: disable frontend-static because dsh-login takes over the
# fallback seat. Both cannot claim it simultaneously.
- id: frontend-static
  disable: true
```

Start DSH, open the web GUI in your browser, and you'll see the setup page. Enter a password (twice to confirm) -- it's stored automatically in the DSH credentials system. On subsequent visits, the normal login page appears.

No environment variables to set, no config files to edit. The password is set through the browser on first use.

## First-time setup flow

1. **First visit** (no password configured) -> `/login` shows a "Set Password" page
2. User enters a password twice (confirmation) -> `POST /api/auth/setup` stores it via `ctx.credentials.set()`
3. **Subsequent visits** -> `/login` shows the normal login form (password already stored)
4. **Security** -> `/api/auth/setup` returns 403 once a password is set, preventing hijacking

## How it works

```
Request -> WebServer
  ├─ /login (exact)            -> setup page (if no password) OR login page
  ├─ /api/auth/setup (exact)  -> POST: set password on first use (403 if already set)
  ├─ /api/auth/login (exact)  -> POST: verify password, set cookie
  ├─ /api/auth/logout (exact) -> POST: revoke session, clear cookie
  ├─ /api/* (prefix)           -> client-connection (host trust check)
  └─ fallback                  -> dsh-login: auth gateway + static files
                                  ├─ no valid cookie -> 302 /login
                                  └─ valid cookie   -> serveStatic()
```

- **Cookie:** `dsh_session`, HttpOnly, SameSite=Strict, Path=/
- **Session:** 32-byte random token (256-bit), in-memory with TTL expiry
- **Password comparison:** constant-time via `crypto.timingSafeEqual`
- **Password storage:** resolved through the DSH credentials system (`credentialRef`), written to local credential file on first use, never in config files

## Security notes

### Protected by the gateway

| Asset | Protection |
|-------|-----------|
| Page navigation (`/`) | 302 redirect to `/login` if unauthenticated |
| Static assets (`/assets/*.js`, `.css`, etc.) | Same gateway check |
| SPA routes (`/conversations`, `/settings`, etc.) | Same gateway check |

### Not protected by the gateway

| Asset | Existing protection |
|-------|-------------------|
| API requests (`/api/*`) | `isTrustedApiRequest` host trust (loopback or `trustedHosts`) |
| WebSocket (`/api/events.mux`, `/api/events.host`) | `isTrustedApiRequest` host trust |

### Recommendations for public exposure

1. Set `trustedHosts` to only the specific hosts that should access the API.
2. Use a reverse proxy (nginx/caddy) with TLS termination in front of DSH.
3. The gateway cookie is `SameSite=Strict`, protecting against CSRF on the login/logout endpoints.

## Architecture note: fallback vs prefix /

The gateway uses `registerFallback()` (not `register({ kind: 'prefix', path: '/' })`) because the DSH WebServer's prefix matching checks `pathname.startsWith(prefix + '/')`. For prefix `/`, this becomes `//`, which no normal path starts with -- a `prefix /` route only matches the exact path `/`. The fallback handler catches everything no named route claims, which is the correct catch-all behavior for the authentication gateway.

This means `dsh-login` and `frontend-static` cannot coexist: both claim the single fallback seat. Disable `frontend-static` in your composition when using `dsh-login`.

## Running tests

```bash
# Unit + integration tests (requires DSH checkout for package resolution)
node --import tsx tests/runner.mjs              # unit tests (40 tests)
node --import tsx tests/integration-runner.mjs  # integration tests (61 tests)

# Or with vitest (in a non-sandboxed environment):
npx vitest run
```

The `tests/runner.mjs` and `tests/integration-runner.mjs` files are sandbox-compatible test harnesses that bypass esbuild's binary (which is blocked in some sandboxed environments). The `.spec.ts` files are the canonical vitest test definitions.

## Project structure

```
src/
├── index.ts          # Cordis plugin entry: registers routes and fallback
├── config.ts         # schemastery config schema
├── session.ts        # SessionStore: in-memory session + TTL expiry
├── auth.ts           # Password verification + cookie management
├── gateway.ts        # Auth gateway handler (fallback + serveStatic)
├── login-api.ts     # POST /api/auth/login + logout + setup
└── login-page.ts     # Login page + setup page HTML
tests/
├── *.spec.ts         # vitest test definitions
├── runner.mjs        # Sandbox-compatible unit test runner
├── integration-runner.mjs  # Sandbox-compatible integration test runner
└── memory-credentials.ts   # Test-only in-memory credential provider
```

## License

MIT
