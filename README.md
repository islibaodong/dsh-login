# dsh-login

English | [简体中文](./README.zh.md)

Multi-user authentication gateway plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: user accounts managed inside the GUI settings panel, and per-user conversation isolation on the `/api` carrier.

## What it does

When the DSH web server is exposed on `0.0.0.0` or a public network, `dsh-login` requires a user account before serving the web GUI. It claims the webserver fallback handler, so every request not matched by a named route (like `/api/*`) goes through the authentication gateway:

- **Unauthenticated requests** -> redirects to `/login`
- **Authenticated requests** -> serves static files from the frontend dist directory

## Quick start

```bash
dsh plugin --profile web add github:islibaodong/dsh-login
```

Uninstall (by installed package name):

```bash
dsh plugin --profile web remove @islibaodong/dsh-login
```

That's it. The package declares its `cordis.patch.yml` as a bundle patch, so `add` automatically:

- mounts the `dsh-login` plugin row (config defaults are sensible; `distIndex` resolves the frontend dist automatically),
- disables the `web-runtime` row (where dsh-web-app mounts the frontend-static fallback); dsh-login takes over the fallback seat and re-provides the `webRuntime` service (LAN trust for the `/api` fence + the `DSH_WEB_URL` variable),
- disables the shipped `connection` row (the `/api` carrier); dsh-login mounts its own identity-aware takeover and ships the matching browser bundle `dist/client.js`.

> Why `--profile web`? DSH has no global plugin install: plugins are installed per profile directory (`$DSH_HOME/profiles/<name>`). `web` is the profile that boots the Web GUI; use another profile name if you run a custom one.

Start DSH (`dsh web`), open the GUI in your browser, and you'll see the setup page. Pick a username and password -- that first account becomes the administrator (scrypt-hashed, stored automatically in the DSH credentials system). On subsequent visits, the normal username/password login page appears.

No environment variables to set, no config files to edit. Accounts are created through the browser: the first (admin) account on first use, further accounts by an admin in the GUI settings panel (设置 → 用户管理).

### Manual installation (alternative)

If you prefer managing `cordis.patch.yml` yourself, add these rows to your profile's patch file instead:

```yaml
- insert:
    - id: dsh-login
      name: '@islibaodong/dsh-login'
      config:
        password: DSH_LOGIN_PASSWORD   # credential ref name; namespaces the user store (<name>_USERS)
        distIndex: ''                  # empty resolves the frontend dist automatically
        dataDir: ''                    # empty resolves to <DSH_HOME>/.dsh-login (ownership index)
        sessionTtl: 604800             # 7 days (default)
        enabled: true                 # set false to disable without uninstalling

# IMPORTANT: dsh-login takes over the fallback seat, so the web-runtime row
# (which mounts frontend-static) must be disabled. dsh-login re-provides the
# webRuntime service, so the rest of the composition is unaffected.
- id: web-runtime
  disabled: true

# IMPORTANT: the WebServer rejects duplicate /api prefix registrations, so the
# shipped connection row must stay disabled; dsh-login mounts its own
# identity-aware takeover (and ships the browser bundle dist/client.js).
- id: connection
  disabled: true
```

> Note: new rows must live under `- insert:` — a bare top-level row is treated as an override of an existing row and is a silent no-op for new ids; and the disable key is `disabled` (not `disable`).

## First-time setup flow

1. **First visit** (no users yet) -> `/login` shows a "Create administrator account" page (username + password)
2. User picks credentials -> `POST /api/auth/setup` creates the forced-admin account (scrypt-hashed, stored under the `${password}_USERS` credential ref, default `DSH_LOGIN_PASSWORD_USERS`) and logs it in
3. **Subsequent visits** -> `/login` shows the normal username/password login form
4. **User management** -> admins open 设置 → 用户管理 in the GUI to list (online status), create, disable/enable, remove users and reset passwords (`/api/auth/admin/*` JSON routes; removing the last admin is refused; removal, password change, or disabling revokes that user's live sessions immediately)
5. **Security** -> `/api/auth/setup` returns 403 once any user exists, preventing hijacking

> **Migration note:** the legacy single-password credential (default ref `DSH_LOGIN_PASSWORD`) no longer logs anyone in. It stays configured but is unused for authentication — the `password` config key now only namespaces the user store credential ref (`${password}_USERS`). Upgrading an existing single-password deployment therefore requires the first visit to bootstrap a fresh administrator account.

## How it works

```
Request -> WebServer
  ├─ /login (exact)            -> setup page (if no users) OR login page
  ├─ /api/auth/setup (exact)  -> POST: create admin on first use (403 if users exist)
  ├─ /api/auth/login (exact)  -> POST: verify {username,password}, set cookie
  ├─ /api/auth/logout (exact) -> POST: revoke session, clear cookie
  ├─ /logout (exact)          -> GET: same revocation, redirect to /login
  ├─ /api/auth/me (exact)     -> GET: current session identity
  ├─ /api/auth/admin/* (exact) -> admin JSON API (users, password, disable, remove)
  ├─ /api/* (prefix)          -> dsh-login connection takeover:
  │                             ├─ untrusted host -> 403
  │                             ├─ no valid cookie -> 401
  │                             ├─ GET on event paths -> 426 (upgrade required)
  │                             └─ per-user dispatch through a filtered proxy
  ├─ /api/events.mux + /api/events.host (WS upgrade) -> same trust + cookie checks,
  │                             then ownership-filtered per-user downlinks
  └─ fallback                  -> dsh-login: auth gateway + static files
                                  ├─ no valid cookie -> 302 /login
                                  └─ valid cookie   -> serveStatic()
```

- **Cookie:** `dsh_session`, HttpOnly, SameSite=Strict, Path=/
- **Session:** 32-byte random token (256-bit), in-memory with TTL expiry; sessions carry the username and admin flag and are lost on process restart
- **Password storage:** scrypt hashes (per-user salt) in the DSH credentials system under `${password}_USERS`

## Multi-user permission model

- **Ordinary users are conversation-only.** Through the `/api` takeover they see and act on their **own** sessions plus lineage children (subagents/forks — ownership follows `parentSessionId`), and workspace views are filtered down to owned sessions. Everything else is off limits:
  - physical allow-list: a fixed set of `session.*`, `subagent.*`, `workspace.*`, `goal.*` methods plus `skill.list`, `host.describe`, `llm.providers`/`llm.models` and `respond`; any other wire method is a 403 before it reaches the harness
  - admin-only domains: `credentials.*`, `settings.*`, `agentPresets.*` are forbidden wholesale
  - also forbidden: `llm.discoverModels` and the privileged `host.*` directory dialogs (`pickDirectory`, `listDirectory`, `createDirectory`, `openPath`)
  - the physical `session.export` channel (target in the query string, outside the envelope) is ownership-guarded at the carrier
  - event streams (mux/host WebSocket frames) are filtered by ownership, so other users' traffic never reaches the browser
- **Admin sees and does everything:** unfiltered API access, all sessions/workspaces visible, and the 设置 → 用户管理 settings section.
- **Logout:** the settings panel's 用户管理/账户 section carries a logout entry for every user (POST `/api/auth/logout` → `/login`); `GET /logout` works as a plain link.
- **Admin user management (设置 → 用户管理):** ships inside the GUI settings panel via the browser bundle — no separate page. The user list reports each account's online session count and disabled flag; per-row actions reset passwords, disable/enable accounts (disabled users cannot log in and their live sessions are revoked; the last enabled admin cannot be disabled), and remove users. Ordinary users get an 账户 section with their identity and the logout entry. The panel styles itself entirely through the framework's `--dsw-alias-*` theme tokens, so it follows the app skin (light/dark) automatically.

## Data locations

| Data | Location |
|------|----------|
| User accounts (scrypt hashes) | DSH credentials system, ref `${password}_USERS` (default `DSH_LOGIN_PASSWORD_USERS`) |
| Session→user ownership sidecar | `<DSH_HOME>/.dsh-login/ownership.json` (configurable via `dataDir`; `DSH_HOME` env or `~/.dsh`) |
| Login sessions | In-memory only (re-login after a DSH restart) |

## `/api` carrier takeover & the client bundle

This plugin replaces the shipped `/api` connection row: `cordis.patch.yml` disables it (the WebServer rejects duplicate `/api` prefix registrations, so the shipped row must stay off) and `dsh-login` mounts its own identity-aware carrier (`src/connection.ts`) as a child plugin — same host-trust fence, but every request is resolved from the session cookie and dispatched per user.

The browser half is untouched protocol-wise, but the GUI's wire client must keep coming from this package: the client-modules scanner drops browser halves of disabled rows from the boot graph. dsh-login therefore declares its own `dsh.client` and ships the bundle `dist/client.js` — a re-stamped copy of the shipped connection client (`src/connection.client.ts` re-exports it verbatim) **plus a second module registration**: the settings-panel wrapper (`src/settings-panel.client.js`) that applies the wire client verbatim and registers the 设置 → 用户管理/账户 settings section (styled via the framework's `--dsw-alias-*` theme tokens; stylesheet pre-tagged `data-plugin`/`data-plugin-css` the way the framework's own bundle preset does). The `dsh.client.inject` field follows the ecosystem convention — it lists the PACKAGE ids behind the services the browser half needs (`@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-locale`), not service names; the runtime fiber's exported `inject` stays authoritative. React and the UI primitives resolve through the platform module-table seeds every bundle may require. Regenerate it with:

```bash
npm run build:client   # node scripts/build-client.mjs; uses node_modules or $DSH_HARNESS_CHECKOUT
```

**You must re-run this after upgrading `@deepseek-ai/dsh-client-connection` or editing `src/settings-panel.client.js`**, or the browser bundle goes stale against the new carrier.

## Security notes

### Protected by the gateway

| Asset | Protection |
|-------|-----------|
| Page navigation (`/`) | 302 redirect to `/login` if unauthenticated |
| Static assets (`/assets/*.js`, `.css`, etc.) | Same gateway check |
| SPA routes (`/conversations`, `/settings`, etc.) | Same gateway check |

### Protected by the carrier takeover

| Asset | Protection |
|-------|-----------|
| API requests (`/api/*`) | `isTrustedApiRequest` host trust **and** a valid `dsh_session` cookie (401 without one); non-allowed methods 403 for ordinary users |
| WebSocket (`/api/events.mux`, `/api/events.host`) | Same host-trust + cookie checks on upgrade; frames ownership-filtered per user |

### Recommendations for public exposure

1. Set `trustedHosts` to only the specific hosts that should access the API.
2. Use a reverse proxy (nginx/caddy) with TLS termination in front of DSH.
3. The gateway cookie is `SameSite=Strict`, protecting against CSRF on the login/logout endpoints.

## Architecture note: fallback vs prefix /

The gateway uses `registerFallback()` (not `register({ kind: 'prefix', path: '/' })`) because the DSH WebServer's prefix matching checks `pathname.startsWith(prefix + '/')`. For prefix `/`, this becomes `//`, which no normal path starts with -- a `prefix /` route only matches the exact path `/`. The fallback handler catches everything no named route claims, which is the correct catch-all behavior for the authentication gateway.

The WebServer has a single fallback seat. dsh-web-app's `web-runtime` row mounts frontend-static over it unconditionally, so the `web-runtime` row must be disabled when using `dsh-login`; dsh-login re-provides the `webRuntime` service that row owned (LAN trust, `DSH_WEB_URL`), leaving the rest of the composition intact.

## Running tests

```bash
# Canonical full suite (109 tests; requires the DSH checkout for package
# resolution — set DSH_HARNESS_CHECKOUT or run beside the default path)
npx vitest run
```

The `.spec.ts` files are the canonical vitest definitions, including the multi-user suites (`users`, `ownership`, `api-filter`, `connection`, `admin-api`, `multiuser-e2e`, `client-bundle`). `tests/runner.mjs` and `tests/integration-runner.mjs` are sandbox-compatible harnesses for the original single-password core only; they were not extended for the multi-user feature.

## Project structure

```
src/
├── index.ts          # Cordis plugin entry: registers routes, fallback, ownership + connection child plugin
├── config.ts         # schemastery config schema (password, distIndex, dataDir, sessionTtl, ...)
├── users.ts          # UserStore: user records, scrypt hashing, credentials-backed persistence
├── session.ts        # SessionStore: in-memory sessions (user + admin flag) with TTL expiry
├── ownership.ts      # OwnershipIndex: sessionId → username sidecar (debounced JSON file)
├── api-filter.ts     # per-user ApiProxy decorator: allow-list, ownership guards, frame filtering
├── connection.ts     # dsh-login-connection: /api carrier takeover + WS downlinks (child plugin)
├── connection.client.ts  # browser half: re-exports the shipped connection client verbatim
├── settings-panel.client.js  # settings-panel browser half (plain JS): 用户管理/账户 section, theme-token styled
├── admin-api.ts      # /api/auth/me + /api/auth/admin/* JSON routes (settings-panel backend)
├── auth.ts           # Cookie management + constant-time compare helpers
├── gateway.ts        # Auth gateway handler (fallback + serveStatic)
├── login-api.ts      # POST /api/auth/login + logout + setup
├── login-page.ts     # Login and setup page HTML
├── http-json.ts      # readBody/sendJson helpers + resolveDshHome
└── web-runtime.ts    # webRuntime takeover: LAN trust + DSH_WEB_URL
dist/client.js        # built browser bundle (npm run build:client)
scripts/build-client.mjs  # regenerates dist/client.js: shipped carrier bundle + settings panel
tests/
├── *.spec.ts         # vitest test definitions
└── memory-credentials.ts   # Test-only in-memory credential provider
```

## License

MIT
