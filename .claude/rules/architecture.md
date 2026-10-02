# Architecture

## What this is
Cordis plugin `dsh-login` — multi-user auth gateway for the DSH Web GUI. Takes
over the webserver fallback seat and serves the frontend dist only to
authenticated sessions.
> **2026-10-02 correction (option A):** dsh-login does **NOT** take over the
> `/api` carrier any more. The shipped `connection` row stays **ENABLED** and
> owns `/api` transport + its browser-session auth; dsh-login composes the login
> wall, the `apiBridgeAuth` wall on the shared `/api` bridge
> (`src/api-bridge-auth.ts`) and capability discovery on top of the native
> stack. `src/connection.ts` / `src/connection.client.ts` no longer exist.

## Folder Map
- `src/` — plugin source (15 files, entry `src/index.ts`)
- `scripts/build-client.mjs` — regenerates `dist/client.js` (browser bundle)
- `dist/client.js` — shipped browser client (re-stamped copy of the shipped
  connection client bundle)
- `tests/` — vitest specs + custom runners (`runner.mjs`, `integration-runner.mjs`)
- `docs/superpowers/plans/` — original implementation plan
- `.superpowers/sdd/` — SDD task briefs/reports (historical)
- `cordis.patch.yml` — bundle patch: inserts plugin, disables dsh-web-app
  `web-runtime` row AND the shipped `connection` row

## Entry Points
- `src/index.ts` — Cordis plugin: `name='dsh-login'`, `inject=['webServer','credentials']`, `apply()`
- `src/connection.ts` — `createConnectionPlugin()` child plugin `dsh-login-connection`
  (`inject=['webServer']`), mounted by index.ts so SessionStore/OwnershipIndex
  live in the dsh-login fiber

## Data Flow
1. `apply()` builds SessionStore, UserStore (credential ref `${password}_USERS`),
   OwnershipIndex (`<dshHome>/.dsh-login/ownership.json`), gateway config
2. Registers named routes: `/login`, `/api/auth/setup|login|logout`, `/logout`,
   `/api/auth/me`, `/api/auth/admin/users[|/password|/disable|/remove]`
3. Registers **fallback** handler (gateway): unauthenticated GET → 302 `/login`;
   authenticated → `serveStatic` from frontend dist (`distIndex`)
4. ~~Mounts the connection child plugin: `/api` prefix route + WS upgrades~~ —
   **removed in option A (2026-10-02):** the native `connection` row owns `/api`.
   dsh-login's `/api` presence is now the `apiBridgeAuth` wall
   (`src/api-bridge-auth.ts`, 401 without a session) plus the remote-layer
   isolation guard (`src/remote-guard.ts`, `wrapRemoteGateway` /
   `createRemoteIsolation`). Teardown still flushes the ownership file.
5. On first use (no users) `/login` shows the admin-bootstrap setup form;
   `POST /api/auth/setup` creates the forced-admin account

## Key wiring (gotcha)
- Gateway uses `registerFallback`, NOT prefix `/` — the WebServer prefix matcher
  turns prefix `/` into `//` which matches only exact `/`.
- `takeOverWebRuntime: true` re-provides `webRuntime` service (LAN trust +
  DSH_WEB_URL shell var) because `cordis.patch.yml` disables dsh-web-app's
  `web-runtime` row. Enabling both fallbacks fails the boot.
- **Corrected 2026-10-02:** the shipped `connection` row is **ENABLED** (option
  A) — `cordis.patch.yml` disables only `web-runtime`. The old "connection stays
  disabled / duplicate `/api` prefix registration" note described the
  pre-option-A takeover and is obsolete. This package still ships its own
  `dsh.client` declaration + `dist/client.js` (the settings-panel half).

## External Dependencies (peers)
`@deepseek-ai/cordis`, `dsh-client-connection`, `dsh-credentials`,
`dsh-host-frontend-static`, `dsh-host-webserver`, `dsh-settings`,
`dsh-web-frontend`, `schemastery` (see `package.json` peerDependencies).
Tests resolve `@deepseek-ai/*` at RUNTIME from `node_modules` (there are **no**
vitest aliases — `vitest.config.ts` is bare); only tsconfig `paths` map them to
the harness checkout (`E:/code/deepseek-harness`) for TYPES.
**Corrected 2026-10-02:** the old note that tests/build "additionally resolve
`dsh-host-apiproxy` and `dsh-client-connection` from the harness checkout — see
vitest.config.ts" was wrong on both counts (those specs are deleted, and
vitest.config.ts declares no aliases).

## Deployment
No Dockerfile. Installed as DSH plugin:
`dsh plugin --profile web add github:islibaodong/dsh-login`
