# dsh-login

English | [简体中文](./README.zh.md)

Single-password authentication gateway plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

## What it does

When the DSH web server is exposed on `0.0.0.0` or a public network, `dsh-login` requires a password before serving the web GUI. It claims the webserver fallback handler, so every request not matched by a named route (like `/api/*`) goes through the authentication gateway:

- **Unauthenticated requests** -> redirects to `/login`
- **Authenticated requests** -> serves static files from the frontend dist directory

## Quick start

```bash
dsh plugin --profile web add github:islibaodong/dsh-login
```

That's it. The package declares its `cordis.patch.yml` as a bundle patch, so `add` automatically:

- mounts the `dsh-login` plugin row (config defaults are sensible; `distIndex` resolves the frontend dist automatically),
- disables the `web-runtime` row (where dsh-web-app mounts the frontend-static fallback); dsh-login takes over the fallback seat and re-provides the `webRuntime` service (LAN trust for the `/api` fence + the `DSH_WEB_URL` variable).

> Why `--profile web`? DSH has no global plugin install: plugins are installed per profile directory (`$DSH_HOME/profiles/<name>`). `web` is the profile that boots the Web GUI; use another profile name if you run a custom one.

Start DSH (`dsh web`), open the GUI in your browser, and you'll see the setup page. Enter a password (twice to confirm) -- it's stored automatically in the DSH credentials system. On subsequent visits, the normal login page appears.

No environment variables to set, no config files to edit. The password is set through the browser on first use.

### Manual installation (alternative)

If you prefer managing `cordis.patch.yml` yourself, add these rows to your profile's patch file instead:

```yaml
- insert:
    - id: dsh-login
      name: '@deepseek-ai/dsh-login'
      config:
        password: DSH_LOGIN_PASSWORD   # credential reference name
        distIndex: ''                  # empty resolves the frontend dist automatically
        sessionTtl: 604800             # 7 days (default)
        enabled: true                 # set false to disable without uninstalling

# IMPORTANT: dsh-login takes over the fallback seat, so the web-runtime row
# (which mounts frontend-static) must be disabled. dsh-login re-provides the
# webRuntime service, so the rest of the composition is unaffected.
- id: web-runtime
  disabled: true
```

> Note: new rows must live under `- insert:` — a bare top-level row is treated as an override of an existing row and is a silent no-op for new ids; and the disable key is `disabled` (not `disable`).

## First-time setup flow

1. **First visit** (no users yet) -> `/login` shows a "Create administrator account" page (username + password)
2. User picks credentials -> `POST /api/auth/setup` creates the forced-admin account (scrypt-hashed, stored under the `DSH_LOGIN_PASSWORD_USERS` credential ref) and logs it in
3. **Subsequent visits** -> `/login` shows the normal username/password login form
4. **User management** -> admins open `/admin` to list, create, remove users and change passwords (`/api/auth/admin/*` JSON routes; removing the last admin is refused)
5. **Security** -> `/api/auth/setup` returns 403 once any user exists, preventing hijacking

> The `password` config key (default `DSH_LOGIN_PASSWORD`) is no longer used for authentication itself — it namespaces the user store credential ref (`${password}_USERS`).

## How it works

```
Request -> WebServer
  ├─ /login (exact)            -> setup page (if no users) OR login page
  ├─ /api/auth/setup (exact)  -> POST: create admin on first use (403 if users exist)
  ├─ /api/auth/login (exact)  -> POST: verify {username,password}, set cookie
  ├─ /api/auth/logout (exact) -> POST: revoke session, clear cookie
  ├─ /api/auth/me (exact)     -> GET: current session identity
  ├─ /api/auth/admin/* (exact) -> admin JSON API (users, password, remove)
  ├─ /admin (exact)           -> admin management page (302 /login otherwise)
  ├─ /api/* (prefix)           -> dsh-login connection takeover (per-user dispatch)
  └─ fallback                  -> dsh-login: auth gateway + static files
                                  ├─ no valid cookie -> 302 /login
                                  └─ valid cookie   -> serveStatic()
```

- **Cookie:** `dsh_session`, HttpOnly, SameSite=Strict, Path=/
- **Session:** 32-byte random token (256-bit), in-memory with TTL expiry
- **Password storage:** scrypt hashes (per-user salt) in the DSH credentials system under `${password}_USERS`

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

The WebServer has a single fallback seat. dsh-web-app's `web-runtime` row mounts frontend-static over it unconditionally, so the `web-runtime` row must be disabled when using `dsh-login`; dsh-login re-provides the `webRuntime` service that row owned (LAN trust, `DSH_WEB_URL`), leaving the rest of the composition intact.

## Running tests

```bash
# Unit + integration tests (requires DSH checkout for package resolution)
node --import tsx tests/runner.mjs              # unit tests (40 tests)
node --import tsx tests/integration-runner.mjs  # integration tests (67 tests, incl. patch-format regression)

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
