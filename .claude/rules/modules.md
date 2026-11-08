# Module Map

## src/index.ts
- Plugin entry. `apply()`: wires SessionStore, UserStore, OwnershipIndex,
  credentialRef, all routes + fallback + the connection child plugin via
  `ctx.effect` for clean teardown. Optional `provideWebRuntime`. When
  `config.apiBridgeAuth` is on, ALSO installs the dispatch-seam guard
  (`ctx.inject(['connection','typertGateway'], fork => fork.effect(...))`):
  `installAdmitShadow(fork.connection)` + `installDispatchShadows` on
  `typertGateway`. Teardown flushes pending ownership writes.

## src/dispatch-guard.ts (issue #11)
- Streaming-method isolation at the dispatch seam (the bridge wall only sees
  HTTP POST; streams ride `/api/remote.mux` whose upgrade has no per-request
  hook, and every dsh-login browser shares upstream's owner-principal
  `browserPeer`). Three own-property shadows, all feature-detected +
  uninstallable:
  - `installAdmitShadow(connection, deps, warn)`: shadows `admit(request)` —
    browser-path (`browserPeer`) admissions REQUIRE a live dsh-login session
    (401 otherwise; closes the "WS upgrade skips the wall" gap) and return a
    TAGGED wrapper peer (`Object.create(peer)` + non-enumerable symbol,
    cached per `peer.id|token` so `$events` result identity checks hold);
    v2/CLI peers untouched unless a dsh-login session rides along.
  - `installDispatchShadows(gateway, deps, warn)`: shadows
    `dispatchRpc(endpoint,payload,signal,peer)` + `openWireStream(...)` —
    untagged peers pass (CLI/SDK/owner), admins pass, `$events`(+`/result`)
    pass, non-`ns/method` shapes pass; tagged non-admins get
    `classifyWireMethod` gating (deny = the wall's forbidden envelope /
    forbidden stream error; unknown = fail closed + warn once) and every
    `GUARDED_ID_FIELDS` id in `payload.args` must be owned (ownership index);
    `workspace/follow` streams are wrapped in
    `filterWorkspaceFollowFrames` (upstream-mirroring delivered-set filter:
    baseline/replace narrowing, upsert/remove/order bookkeeping + replace
    resyncs, archived/pinned narrowing, unknown frames dropped; owned set
    re-probed per frame).
  - `peerUser(peer)` / `userFromRequest(request, store)` exported for reuse.

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
  keys). Surface unchanged since alpha.3 (rc.1 added none): `terminal.attach`
  (bidirectional stream; the removed
  `terminal.follow`/`terminal.write`/`terminal.resize` are gone) and
  `remoteAccess.follow` (native remote-access snapshot stream; gateway always
  allows it, it answers with only the caller's own grants; kept on the list so
  the client mount stays silent — both the bridge wall and the dispatch-seam guard
(dispatch-guard.ts, issue #11) sit on the same `connection/request` / admit+dispatch
path and only act on wire-method traffic, never on the plugin's own routes.
**dispatch-guard.ts (issue #11, 2026-11-08):** streaming methods (`workspace.follow`,
`session.follow`, …) ride the `/api/remote.mux` WebSocket which the bridge wall never
sees. The guard shadows `connection.admit(request)` (browser-path admissions require a
live dsh-login session — closes the WS-upgrade wall gap — and tag the peer with the
dsh-login user via `Object.create(peer)` + non-enumerable symbol wrapper, cached per
`peer.id|token`) and `gateway.dispatchRpc`/`openWireStream` (tagged non-admin peers are
checked against `classifyWireMethod` + `GUARDED_ID_FIELDS` ids against the ownership
index; `workspace.follow` streams are filtered frame-by-frame mirroring upstream's
per-principal follow filter). Untagged peers (launch-token CLI/SDK, host-internal)
pass untouched. Gated on `config.apiBridgeAuth`; installed via
`ctx.inject(['connection','typertGateway'], fork => fork.effect(...))`. Residuals
(disclosed in issue #11): `$events` broadcast frames unfiltered; `terminal.attach`
and `job.follow` are id-free; `/api/file` has no per-user check. NOTE:
`glue.ts`/`docs/compose-guard.md` option B (`wrapRemoteGateway`) only swaps the
gateway's public `invoke`/`stream` — browser traffic flows through internal
`dispatchRpc`/`openWireStream`, so deployment-side composition never covered real
browser calls; the dispatch seam is the effective hook.
  consult this list). `ownedSessionIds` (direct index hits + lineage closure
  over a session.list snapshot). `frameVisible` (mux/host frame predicate).
  `createUserProxy`: per-user ApiProxy decorator (STALE — option A removed the
  user proxy layer; kept here until this section is rewritten) — filters session/subagent/
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
  session → 302 `/login`; else `serveStatic` + `webServer.renderIndex(html,
  { principal: { kind: 'owner' } })` (PR #12: DSH 0.2.2 index-inject listeners
  read `peer.principal`; owner snapshot is just `{type:'baseline',owner:true}`
  — roles stay plugin-gated). Falls back to `applyIndexTaps` on old DSH.

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
  `resolveDistIndex` (require.resolve dsh-web-frontend dist), `advertisedUrl`
  (feature-detects `webServer.getOrigin()` (alpha.3+) in try/catch, falls back
  to `http://<urlHost(host)>:<port>`; `''` when webServer absent),
  `provideWebRuntime` (provides webRuntime service AND `webApp`
  `{getAdvertisedUrl}` — the alpha.3 `harness-dev-context` web-app row injects
  `webApp` and the disabled web-runtime row was its sole upstream provider;
  prints `dsh web:` URL, registers DSH_WEB_URL shell variable).

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
  api-filter/connection/admin-api/client-bundle/multiuser-e2e/web-runtime
  .spec.ts`
  (vitest), `memory-credentials.ts` (in-memory credentials stub), `helpers.ts`,
  `runner.mjs` / `integration-runner.mjs` (legacy single-password-era custom
  runners; not extended for multi-user). `web-runtime.spec.ts` unit-tests the
  `webApp` provide with a fake ctx that mirrors cordis semantics (provide()
  must ALSO set ctx[name] — services are read as properties, not only via
  get()); `plugin-entry.spec.ts` asserts the real-composition
  `ctx.webApp.getAdvertisedUrl()` on a booted alpha.3 HttpServer.
