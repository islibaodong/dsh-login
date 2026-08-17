# dsh-login

English | [简体中文](./README.zh.md)

Single-password authentication gateway plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

## What it does

When the DSH web server is exposed on `0.0.0.0` or a public network, `dsh-login` requires a password before serving the web GUI. It claims the webserver fallback handler, so every request not matched by a named route (like `/api/*`) goes through the authentication gateway:

- **Unauthenticated requests** -> redirects to `/login`
- **Authenticated requests** -> serves static files from the frontend dist directory

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

# IMPORTANT: disable frontend-static because dsh-login takes over the
# fallback seat. Both cannot claim it simultaneously.
- id: frontend-static
  disable: true
```

## How it works

```
Request -> WebServer
  ├─ /login (exact)            -> login page HTML
  ├─ /api/auth/login (exact)   -> POST: verify password, set cookie
  ├─ /api/auth/logout (exact)  -> POST: revoke session, clear cookie
  ├─ /api/* (prefix)           -> client-connection (host trust check)
  └─ fallback                  -> dsh-login: auth gateway + static files
                                  ├─ no valid cookie -> 302 /login
                                  └─ valid cookie   -> serveStatic()
```

- **Cookie:** `dsh_session`, HttpOnly, SameSite=Strict, Path=/
- **Session:** 32-byte random token, in-memory with TTL expiry
- **Password:** constant-time comparison via `crypto.timingSafeEqual`
- **Password storage:** resolved through the DSH credentials system (`credentialRef`), never in config files

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
node --import tsx tests/runner.mjs          # unit tests (40 tests)
node --import tsx tests/integration-runner.mjs  # integration tests (39 tests)

# Or with vitest (in a non-sandboxed environment):
npx vitest run
```

The `tests/runner.mjs` and `tests/integration-runner.mjs` files are sandbox-compatible test harnesses that bypass esbuild's binary (which is blocked in some sandboxed environments). The `.spec.ts` files are the canonical vitest test definitions.

## License

MIT
