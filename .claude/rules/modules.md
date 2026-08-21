# Module Map

## src/index.ts
- Plugin entry. `apply()`: wires SessionStore, UserStore, OwnershipIndex,
  credentialRef, all routes + fallback + the connection child plugin via
  `ctx.effect` for clean teardown. Optional `provideWebRuntime`. Teardown
  flushes pending ownership writes.

## src/config.ts
- `Config` interface + schemastery schema. Fields: `password` (credential ref
  name, required; namespaces `${password}_USERS`), `distIndex` (default '' =
  auto-resolve), `dataDir` (default '' = `<dshHome>/.dsh-login`), `sessionTtl`
  (default 604800), `enabled`, `takeOverWebRuntime` (default true),
  `trustedHosts`.

## src/users.ts
- `UserStore`: user records (`username/hash/salt/isAdmin/createdAt/lastLoginAt?`
  /`disabled?`) persisted as JSON in the DSH credentials system (ref
  `${password}_USERS`). scrypt hashing (per-user salt, timing-safe compare).
  Methods: list/isEmpty/create (first user is forced admin)/verify
  /touchLastLogin (stamps epoch ms; no-op for unknown users)/setPassword
  /setDisabled/remove. Username pattern `[a-zA-Z0-9_-]{1,32}`.

## src/session.ts
- `SessionStore`: in-memory Map of 32-byte hex tokens with TTL; Session
  carries `user` + `isAdmin`. Lost on restart. Methods:
  create/verify/revoke/cleanup.

## src/ownership.ts
- `OwnershipIndex`: sessionId → username sidecar. In-memory map authoritative;
  debounced (200ms) JSON write to `<dataDir>/ownership.json`. Fail-closed
  load (corrupt/absent → empty). Methods: record/lookup/has/knownUsernames/
  entries/flush.

## src/api-filter.ts
- `USER_ALLOWED` physical allow-list + `isUserAllowed` (exact RpcMethodMap
  keys). `ownedSessionIds` (direct index hits + lineage closure over a
  session.list snapshot). `frameVisible` (mux/host frame predicate).
  `createUserProxy`: per-user ApiProxy decorator — filters session/subagent/
  workspace listings by ownership, guards session-addressed methods (every
  sessionId-bearing payload field must be owned), records ownership on
  create/fork, wraps admin-only domains (`credentials`/`settings`/
  `agentPresets`) wholesale, forbids `llm.discoverModels` + host directory
  dialogs, filters event streams. Admin gets the raw proxy.

## src/connection.ts
- `createConnectionPlugin` → child plugin `dsh-login-connection`. Registers
  the `/api` prefix route (host-trust fence → cookie session (401 without) →
  426 for plain GET on event paths → ownership guard on
  `/api/session.export` → physical 403 for non-allowed methods → cached
  per-user fetch) and WS upgrades for mux/host events (same checks, one
  WebSocketDownlinks per socket over the per-user proxy). `fetchForTest`
  seam for tests.

## src/connection.client.ts
- Browser half: re-exports the shipped `@deepseek-ai/dsh-client-connection`
  client verbatim (protocol unchanged; cookie rides along).

## src/admin-api.ts
- `createAdminRoutes`: GET `/api/auth/me`; GET/POST `/api/auth/admin/users`
  (list / create); POST `/api/auth/admin/users/password`;
  POST `/api/auth/admin/users/disable`;
  POST `/api/auth/admin/users/remove` (refuses the last admin).
  8KB body cap; webserver registers (kind,path) pairs, so GET/POST dispatch
  inside handlers. No `/admin` HTML page — the settings panel owns the UI.

## src/http-json.ts
- `readBody` (8KB default cap), `sendJson`, `resolveDshHome` (`DSH_HOME` env
  else `~/.dsh`).

## src/auth.ts
- `COOKIE_NAME='dsh_session'`; `verifyPassword` (timingSafeEqual),
  `extractSessionToken` (cookie parsing), `buildCookieHeader` /
  `buildClearCookieHeader` (HttpOnly, SameSite=Strict).

## src/gateway.ts
- `createGatewayHandler`: fallback handler. Non-GET/HEAD → 405; no/invalid
  session → 302 `/login`; else `serveStatic` + `applyIndexTaps` on index HTML.

## src/login-api.ts
- POST `/api/auth/login`: JSON `{username,password}` vs UserStore → session
  cookie (401 invalid; 500 while no users exist). POST `/api/auth/logout`:
  revoke + clear cookie. POST `/api/auth/setup`: only while `users.isEmpty()`
  (else 403); creates the forced-admin account and logs it in.

## src/login-page.ts
- `renderLoginPage()` / `renderSetupPage()`: self-contained HTML (inline
  CSS/JS, DSH dark theme).

## src/settings-panel.client.js
- Settings-panel browser half (plain JS, appended verbatim to
  `dist/client.js`): a wrapper factory that materializes the re-stamped
  connection client (`@islibaodong/dsh-login/connection`, same-bundle
  require) and returns one wire-root plugin — `inject: []`, `inner.apply`
  runs synchronously to provide `connection`. NEVER add a hard inject here:
  this fiber is the only `connection` provider (shipped row disabled) and
  `locale` waits on `connection`, so a hard slots/locale wait deadlocks the
  whole boot (the 59-pending-entries failure). Dictionaries + the
  `settings.section` slot entry (用户管理 id `users` admin / 账户 id
  `account` ordinary, picked from `/api/auth/me`, 15s-bounded) register via
  a `ctx.inject(['slots','locale'])` dependency fiber. Table + create card +
  reset/disable/remove dialogs + logout entry; React and Button/Input/Modal/
  RiskConfirmation come from the platform module-table seeds; styles are
  `--dsw-alias-*` theme tokens (auto light/dark), style tag pre-tagged
  data-plugin/data-plugin-css and deduped.

## src/web-runtime.ts
- `resolveLanTrust` (LAN IPv4 literals when bound 0.0.0.0 + extras),
  `resolveDistIndex` (require.resolve dsh-web-frontend dist), `provideWebRuntime`
  (provides webRuntime service, prints `dsh web:` URL, registers DSH_WEB_URL
  shell variable).

## scripts/build-client.mjs
- Regenerates `dist/client.js`: copies the shipped connection client bundle
  (from node_modules or `$DSH_HARNESS_CHECKOUT`), re-stamps the
  `window.__ModuleLoader__.load({ id: ... })` banner to the internal id
  `@islibaodong/dsh-login/connection`, drops the sourceMappingURL comment,
  then appends the settings-panel wrapper registration under the package id.
  Run via `npm run build:client` after upgrading
  `@deepseek-ai/dsh-client-connection` or editing
  `src/settings-panel.client.js`.

## tests/
- `session/auth/login-page/login-api/gateway/plugin-entry/users/ownership/
  api-filter/connection/admin-api/client-bundle/multiuser-e2e.spec.ts`
  (vitest), `memory-credentials.ts` (in-memory credentials stub), `helpers.ts`,
  `runner.mjs` / `integration-runner.mjs` (legacy single-password-era custom
  runners; not extended for multi-user).
