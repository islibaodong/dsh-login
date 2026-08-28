# Memory Changelog

## 2026-08-28 — remote-web-ui compat: mount host routes + trust public host
- Root cause found for the public-FRP 405/403 wall: remote-web-ui registers its
  host routes (`/remote`, `/api/pair/*`) ONLY when `enabled===true`; the earlier
  compat write of `requirePairingForLan:false` alone could not help because
  nothing was mounted. Fix: `RemoteWebUiCompat.apply` now writes
  `{ enabled: true, requirePairingForLan: false }` (enabled:true mounts routes).
- The `/api/pair/*` fence (`routes.ts` `lanFence`) is **Host-header based** —
  a browser at a public FRP host sends `Host: <public>:<port>` which loopback/`lanAddresses`
  don't match, so `/api/pair/status` 403s and the client still fail-closes to `/remote`.
  Fix: new config `remoteWebUiPublicBaseUrl` (string) is threaded through `apply` and
  written as remote-web-ui's `publicBaseUrl` (which its `sync()` hot-applies via
  `service.setPublicBaseUrl`), so the fence trusts the public origin.
- `applyWithRetry` signature now `(compat, enabled, publicBaseUrl?, attempts?, delayMs?)`.
- Tests: `remote-web-ui-compat.spec.ts` 10 → 13 (publicBaseUrl written/omitted/off-only).

## 2026-08-22 — feature: remote-web-ui pairing gate bypass (requirePairingForLan toggle)
- Accommodates `@linxin666/dsh-remote-web-ui` unchanged (the popular community
  plugin whose `/remote` device-pairing gate 401s non-loopback desktop traffic
  from a public FRP host, independently of dsh-login's working /api auth).
- new `src/remote-web-ui-compat.ts`: `RemoteWebUiCompat.apply(enabled)` writes
  `requirePairingForLan: !enabled` into remote-web-ui's
  `settingsNamespace('remote-web-ui')` (live + hot-reloaded by that plugin);
  `ok | skipped (no settings svc) | unregistered (namespace missing)`; plus
  `applyWithRetry` for the boot race where remote-web-ui registers its namespace
  after dsh-login applies. No-op whenever remote-web-ui is not installed.
- new `src/boolean-setting.ts`: shared live+persisted `{enabled}` flag backing
  the runtime toggles; `DefaultWorkspaceSetting` now extends it (back-compat).
- config: `remoteWebUiCompat: boolean` (default **true**). index.ts wires a
  `BooleanSetting`, a deferred boot `applyWithRetry`, passes it into
  `createAdminRoutes`, flushes it on teardown.
- admin route `GET/POST /api/auth/admin/settings/remote-web-ui-compat` returns
  `{enabled}` (+ `applied: ok|skipped|unregistered`); 设置-用户管理 gains a
  switch card (zh/en).
- Build/tests: vitest + tsconfig alias `@deepseek-ai/dsh-settings` → harness
  `packages/settings/settings`; peerDependency added. 185 tests pass.

## 2026-08-21 — README restructure: showcase first, tech later
- Both READMEs rewritten front-to-back: one-liner → side-by-side
  screenshots (images/login.png, images/users.png — new, committed) →
  "problem it solves" in plain language (DSH GUI has no login; exposing
  0.0.0.0 hands everything to the network) → 6-bullet feature list →
  3-step quick start → FAQ (re-login after restart / what ordinary
  users can do / single-password migration). ALL prior technical
  content preserved verbatim under a `# 技术细节` / `# Technical
  details` divider at the bottom (install mechanics + manual install,
  setup flow, request-routing diagram, permission model, data
  locations, carrier takeover & bundle, security notes, fallback
  architecture, tests — count updated 109 → 134, settings-panel suite
  added to the list —, project structure).

## 2026-08-21 — Users table: single-line actions + last-login column
- 设置-用户管理 table: the actions cell (重置密码/禁用-启用/删除) is now a
  regular grid track at the row's end — `flex-wrap: nowrap`, no more
  `grid-column: 1 / -1` second line. `UserRecord.lastLoginAt?` (epoch ms)
  stamped by `touchLastLogin()` on every successful login/setup; the table
  dropped `createdAt` for a compact 最后登录 column (从未登录 placeholder,
  API returns `lastLoginAt: null` for never).
- Layout fix (same day): the first inline-actions attempt used three
  fixed-px tracks (56/150/112) + a nowrap max-content actions track — the
  minimum row width exceeded the panel and the grid overflowed/collapsed.
  Now only 状态+操作 are max-content; 用户名/最后登录 are `minmax(0, …)`
  flexible (ellipsis), the redundant 角色 column is gone (admin badge on
  the name covers it), and `@media (max-width: 620px)` drops the
  last-login column. Spec guards: no px-valued grid tracks, no col.role.
- Alignment fix (same day): header and rows were SEPARATE grids, so the
  max-content tracks (状态/操作) resolved per container — ~30px for the
  header labels vs ~250px for row buttons — and the header landed fully
  offset from the body. Now `.dshlu-table` owns one shared column grid
  and head/rows are `grid-template-columns: subgrid` spanning `1 / -1`
  (identical 14px side padding + 1px border on both, so tracks share the
  same origin). Narrow-viewport rule now retargets `.dshlu-table`.
  Spec guards: subgrid present, cells never carry grid-column spans.
- Tests: admin list (root stamped / bob null → stamped after login), login
  200 stamps / 401 does not, setup stamps; settings-panel spec guards the
  layout invariants in source.

## 2026-08-20 — Fix: UI plugins dead after login
- Root cause: the takeover bridged `/api` straight to `toFetchHandler` and
  never re-provided the `connection` service, so the Typert Remote gateway
  (dsh-api-gateway) never registered its shared `/api` interceptor — every
  installed UI plugin's host RPC (`POST /api/<namespace>/<method>`) failed
  after login, admin included; non-admins additionally lost all
  `host/remote-event` pushes.
- Fix: `connection.ts` instantiates `HostConnectionService` (re-provides
  `connection`) and routes two-segment endpoints through
  `createSharedFetchHandler`; `api-filter.ts` `frameVisible` forwards global
  remote-event signals to ordinary users (cordis/* stays admin-only).
- Tests: typert interceptor dispatch, cookie-gated typert, unclaimed-shape
  404, connection-service presence; frameVisible expectations updated.

## 2026-08-18 — Multi-user gateway (feat/multiuser-isolation)
- Multi-user auth: UserStore (scrypt, `${password}_USERS` credential ref),
  admin bootstrap on first visit, `/admin` page + `/api/auth/admin/*` routes,
  `/api/auth/me`; legacy single password no longer authenticates.
- Identity-aware `/api` carrier takeover: `connection.ts` child plugin
  (prefix route + WS upgrades), `api-filter.ts` per-user proxy with
  allow-list + ownership filtering, `ownership.ts` sessionId→username
  sidecar; `cordis.patch.yml` disables the shipped `web-runtime` and
  `connection` rows; browser half shipped as `dist/client.js`
  (`connection.client.ts`, `scripts/build-client.mjs`).
- Memory files rewritten to match (architecture/modules/api/gotchas).

## 2026-08-18 — Initial analysis
- Full codebase analyzed and memory files written
- 3 modules mapped, 0 endpoints documented, 0 models captured
