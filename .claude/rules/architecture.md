# Architecture

## What this is
Cordis plugin `dsh-login` — multi-user auth gateway for the DSH Web GUI. Takes
over the webserver fallback seat and serves the frontend dist only to
authenticated sessions; also takes over the `/api` carrier (prefix route +
WS upgrades) with per-user dispatch and ownership filtering.

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
2. Registers named routes: `/login`, `/api/auth/setup|login|logout`,
   `/api/auth/me`, `/api/auth/admin/users[|/password|/remove]`, `/admin`
3. Registers **fallback** handler (gateway): unauthenticated GET → 302 `/login`;
   authenticated → `serveStatic` from frontend dist (`distIndex`)
4. Mounts the connection child plugin: `/api` prefix route (trust fence →
   cookie auth → per-user filtered dispatch) + WS upgrades on
   `/api/events.mux`, `/api/events.host`; teardown flushes the ownership file
5. On first use (no users) `/login` shows the admin-bootstrap setup form;
   `POST /api/auth/setup` creates the forced-admin account

## Key wiring (gotcha)
- Gateway uses `registerFallback`, NOT prefix `/` — the WebServer prefix matcher
  turns prefix `/` into `//` which matches only exact `/`.
- `takeOverWebRuntime: true` re-provides `webRuntime` service (LAN trust +
  DSH_WEB_URL shell var) because `cordis.patch.yml` disables dsh-web-app's
  `web-runtime` row. Enabling both fallbacks fails the boot.
- The shipped `connection` row stays disabled: the WebServer rejects duplicate
  `/api` prefix registrations, and dsh-login registers its own. The disabled
  row also drops the shipped browser half from the boot graph — covered by
  this package's own `dsh.client` declaration + `dist/client.js`.

## External Dependencies (peers)
`@deepseek-ai/cordis`, `dsh-credentials`, `dsh-host-frontend-static`,
`dsh-host-webserver`, `dsh-invariants`, `schemastery`
(tests/build additionally resolve `dsh-host-apiproxy` and
`dsh-client-connection` from the harness checkout — see vitest.config.ts)

## Deployment
No Dockerfile. Installed as DSH plugin:
`dsh plugin --profile web add github:islibaodong/dsh-login`
