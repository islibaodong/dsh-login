# Memory Changelog

## 2026-09-17 (later) — PUBLISHED 0.2.1 + login-page redesign ride-along
- **`@islibaodong/dsh-login@0.2.1` is LIVE on npmjs** (`latest = 0.2.1`), git tag
  `v0.2.1` + master pushed to GitHub (the plugin's other install channel). Full
  publish-path record in `docs/adapt-dsh-0.1.6.md` §7.
- Between sessions the adaptation had already been committed (`7d4e4ec`) and the
  **login-page redesign** (entry below) landed on top (`762d3f7`, src/login-page.ts
  ±661, no spec changes — suite still green 17 files / 192 at publish time). Its
  dist was already rebuilt+committed pre-publish; a post-redesign rebuild was
  byte-identical (deterministic esbuild output). The leftover uncommitted
  changelog session-log was committed as `0279a16 chore(release): 0.2.1 —
  rebuild dist (redesigned login page) + session log` — the release commit.
- Publish runbook that worked (npm 11.19, mirror-default machine):
  1. Machine default registry is **npmmirror** (`registry=npmmirror.com` in
     ~/.npmrc) — whoami/login/publish ALL need explicit
     `--registry=https://registry.npmjs.org`. A default `npm login` opens an
     npmmirror login session, which cannot publish.
  2. The stored npmjs token was dead (0.2.0's granular token had been revoked
     as reminded) → fresh **web login** (`--auth-type=web`). Shell caveat:
     piping npm through `Select-Object -First N` stops the pipeline and kills
     the login mid-flow; stream without `First`.
  3. Direct `npm publish` → **EOTP**; npm's browser-auth URL is redacted to
     `***` in captured output AND the debug log — unrecoverable non-TTY.
  4. Working path: `npm stage publish` (stage id
     `1a545a63-427c-482a-9010-2408f129fbc7`; tarball identical to dry-run,
     30 files / 136.6 kB, shasum d0bfb0c7…) → `npm stage approve` in an
     **interactive terminal window** (Start-Process powershell; `pwsh` was not
     on PATH for Start-Process) → npm auto-opens the browser, polls, completes
     after the user's 2FA approval.
  5. Verified `npm view @islibaodong/dsh-login dist-tags` → latest 0.2.1.
- npm login left a FRESH `//registry.npmjs.org/:_authToken` in ~/.npmrc —
  remind user to revoke it on npmjs.com if the machine is shared.
- npmmirror mirrors the published tarball with propagation delay; verify
  against the official registry, not the mirror.

## 2026-09-17 — login page visual redesign (万物皆插件 identity)
- `src/login-page.ts` fully redesigned (frontend-design skill pass), both
  `renderLoginPage` and `renderSetupPage` now share one `renderPage` shell.
- Visual identity: the "everything is a plugin" motif — the page is a plugin
  board (faint 72px grid backdrop + 8–16 JS-placed plugin tiles snapped to the
  grid, some "lit" with a slow breath glow; tiles hidden <420px), and the login
  card IS the dsh-login plugin: a connector tab on the top edge
  (`::before` with two pin dots), a plugin-row header (inline plug SVG +
  `dsh-login` + pkg id + status dot 已加载), and the footer line
  「万物皆插件，这道门也不例外。」. Setup page headline 初始化 DSH.
- Palette (DSH deep-navy): bg `#0f1420`, panel `#151b2c`, inset `#0d1220`,
  line `#262f47`, accent `#6f9bff`, ok `#46d19a`, danger `#ff7a7a`. System
  font stack (no external assets — spec forbids `src="http`/`href="http`/
  `<link`). Copy now zh-CN.
- Motion budget: one orchestrated load (card rise 120ms-delayed + tiles
  staggered in at 45ms), then only the lit tiles' 7s breath;
  `prefers-reduced-motion` disables everything. Focus-visible rings on
  inputs/button; error area keeps `role="alert"`.
- Test compatibility preserved (login-page.spec guards `name="username"`,
  autocomplete attrs, `id="confirm"`, endpoints, no external resources, dark
  background); full suite green **17 files / 192 tests**.
- Local check: node 24 type-strips the TS — a throwaway .mjs importing
  `src/login-page.ts` rendered `preview-login.html` / `preview-setup.html`
  (gitignored `/preview-*.html`), opened in the browser. Artifact preview was
  unavailable (AUTH_TOKEN session, no claude.ai login).

## 2026-09-17 — DSH 0.1.6-alpha.1 compatibility adaptation (0.2.1, unpublished)
- **New DSH release detected**: `@deepseek-ai/dsh-*` `0.1.6-alpha.1` on npm under the
  **`alpha`** dist-tag (`latest` is stale at 0.0.1-rc.x; `next` at 0.1.5-rc.2). Harness
  tag `dsh-v0.1.6-alpha.1` (release commit `ea53423b60`, PR #4171); 800 commits since
  `dsh-v0.1.5-rc.2`. Full analysis in `docs/adapt-dsh-0.1.6.md`.
- **Compatibility surface**: host packages the plugin integrates with are source-unchanged
  (webserver incl. `webserver/index-inject`, frontend-static 6-arg `serveStatic`, settings,
  credentials). New/changed that matters: (1) new `dsh-api-terminal-controller` — typert
  namespace `terminal`, 9 agent-scoped methods (environment/shells/list/create/follow/write/
  resize/rename/close), new web-app rows `terminal-controller` + `ui-sidebar-terminal`;
  (2) new `workspace.unarchiveSession` wire method; (3) web-app cordis rows −`code-runtime`,
  `workflow-worker-thread`→`workflow-ptc`, +`ui-settings-unarchive-sessions`. The rows
  dsh-login patches (`web-runtime` disable, `connection` keep-enabled) are untouched —
  the shipped `cordis.patch.yml` applies to 0.1.6 as-is.
- **Local-env incident**: the 09-14 `npm install` reset node_modules to the lockfile's
  0.1.1-rc.2 builds (the previously hand-advanced bits were lost) — 0.1.1's 5-arg
  `serveStatic` turned the plugin's `authorizeIndex` callback into the `renderIndex` slot
  → 4 failures (gateway static/index specs + one full-composition boot). Fixed by pinning
  devDeps to real `0.1.6-alpha.1` tarballs, which also made the suite exercise the new
  release. `vitest` has NEVER aliased to the harness checkout at runtime — only tsconfig
  `paths` do (types); runtime resolution is node_modules. The old gotcha claiming
  checkout aliases was wrong/stale.
- **Shipped in 0.2.1 (version bumped, NOT published)**: peerDependencies retargeted to
  `>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0` (same tuple convention: 0.1.6
  prereleases/stable included, future 0.1.7-alpha.x excluded); `USER_ALLOWED` +=
  `workspace.unarchiveSession` + the nine `terminal.*` methods (agent-scoped by the
  Gateway = same trust boundary as `session.prompt`; `terminal.list`'s explicit
  `sessionId` is ownership-guarded); `USER_DOMAINS` += `terminal`; +3 tests. Suite green
  **17 files / 192 tests** against published 0.1.6-alpha.1 builds; `verify:imports` exit 0;
  build green. Publish needs the user (`npm stage publish` + npmjs approval — token is
  staging-only).
- **Multi-user detection**: DSH 0.1.6 still has NO native multi-user support (grep
  `multi-user|multiuser` zero hits; `packages/identity` = telemetry correlation ids, not
  accounts; `packages/guard` = loop hygiene; `packages/sandbox` = process-confinement seam
  — a future building block, not multi-user). dsh-login remains the multi-user layer.
- **Role-based whole-UI control**: still infeasible at 0.1.6 — `ui-slots` source-unchanged
  (no per-identity slot filter / activation gate / role concept), client runtime still
  activates all bundles, third-party plugin exact routes still outside any gate. Upstream
  asks recorded in `docs/adapt-dsh-0.1.6.md` §6.
- Memory-file staleness flag: `architecture.md`/`modules.md`/`api.md` still describe the
  pre-option-A `/api` takeover (connection.ts/api-filter createUserProxy era); the
  changelog entries of 2026-09-08/11 + `docs/adapt-dsh-0.1.5.md` are the current truth.

## 2026-09-11 — npm release 0.2.0 (option A adaptation)
- Published `@islibaodong/dsh-login@0.2.0`: the DSH ≥ 0.1.5-alpha.1 option-A adaptation
  (no /api takeover; native connection row; remote-guard isolation seam exported from the
  host bundle) plus the code-review hardening. Version is a **minor** bump per 0.x semver
  convention (carries breaking changes: requires DSH ≥ 0.1.5-alpha.1, `./connection` /
  `./connection-client` exports removed).
- **peerDependencies retargeted** to `>=0.1.5-alpha.1 <0.2.0-0` for all six `@deepseek-ai/dsh-*`
  peers. The old `>=0.1.1-rc.0 <0.2.0-0` branch silently EXCLUDED `0.1.5-alpha.1` (node-semver
  prerelease rule: a prerelease version only satisfies a range containing a comparator with the
  same [major,minor,patch] tuple — PUBLISHING.md §四 pitfall). The new range covers the whole
  0.1.5 line (alpha.1/alpha.2/rc.1/rc.2/stable): tuple [0,1,5] matches the `>=0.1.5-alpha.1`
  comparator; future 0.1.6-alpha.x is (correctly) excluded. The floor is honest: option-A code
  requires the 6-arg serveStatic + string settings namespace + connection.authorizeIndex, none
  of which exist before 0.1.5-alpha.1.
- devDependencies left at `^0.1.1-rc.2` deliberately (published tarball excludes devDeps and the
  lockfile; builds keep `@deepseek-ai/*` external; local node_modules/lockfile already diverged —
  don't churn the verified-green environment). Known wart: a fresh `npm ci` installs 0.1.1-rc.2
  types; vitest resolves the real 0.1.5 sources via checkout aliases.
- `npm pack --dry-run`: 30 files / 121.4 kB (0.1.0 was 23 files / 120.9 kB). LICENSE is in the
  tarball (head-truncated notice output looks like it's missing — it isn't).
- npm toolchain side-effect: `npm pack` created an empty `.env` in the repo root; unstaged and
  gitignored (`/.env`).
- **Published 2026-09-11:** `@islibaodong/dsh-login@0.2.0` LIVE on npmjs (latest = 0.2.0,
  tarball `dsh-login-0.2.0.tgz`). Publish path hit two auth walls of npm's evolving 2FA policy:
  (1) the stale `//registry.npmjs.org/:_authToken` in `~/.npmrc` was dead (whoami E401, publish
  PUT 404 — npmjs returns 404 for an underprivileged publish); (2) after a fresh web `npm login`,
  direct `npm publish` gave E403 `E_STAGE_REQUIRED` — the account's granular token is
  **staging-only** (npm tightening bypass-2FA direct publish; per gh.io/npm-gat-bypass2fa-deprecation),
  so it published via `npm stage publish` → user approved on npmjs.com → 0.2.0 went live.
  Hygiene: temp publish npmrc (in `%TEMP%`), the repos' `.env`, and `npm_recovery_codes.txt`
  (created by `npm login`) were all deleted after publish; `/.env` + `/npm_recovery_codes.txt`
  gitignored. Remind user to revoke the granular token on npmjs.com.

## 2026-09-08 — code-review fixes for the option-A guard (requesting-code-review round)
- External code review of the option-A adaptation returned "with fixes". Applied the
  in-repo-fixable items:
- **(#2) package.json dangling exports:** removed `./connection` and `./connection-client`
  export entries (both pointed to deleted `dist/connection*.js`).
- **(#3) guard ID-scan hardening:** `collectIds()` now recurses arrays and nested
  `{id}/{sessionId}/{workspaceId}/{agentId}` records, not just top-level string fields;
  enabled `sessionIds`/`parentSessionIds`/`childSessionIds`/`agentId` fields. `ownershipGuarded`
  rejects any collected foreign id. 3 new regression tests (array `sessionIds`, array of nested
  `{id}`, nested `agentId`), all pass.
- **(#4 admin) `createRemoteIsolation` admin resolution:** new optional `isAdminSession(sid)`
  short-circuits before the sidecar, so an admin session with no ownership record still resolves
  as admin (admin passes the guard unfiltered). `owns` returns true for an admin. 2 new tests.
- **(#4 activation) guard reachable from the artifact:** `src/index.ts` re-exports
  `wrapRemoteGateway`/`createRemoteIsolation` (+ types), so `dist/index.js` carries them for
  deployment composition. **Reconciled with the architecture:** a runtime `isolateRemote`
  re-provide would be a duplicate-service conflict (docs confirmed); the guard remains a
  composition primitive, not a hot-swap — documented in README + verify-option-A §B.
- **(#7 README/zh resync):** removed the false "isolation working" claim and the stale
  "disables the connection row" manual-install block + `/api takeover` ASCII diagram; test count
  168 → 184; project-structure adds `remote-guard.ts`; EN+ZH both describe the composition
  primitive truthfully. remote-guard.spec now **21 tests**; suite green **17 files / 189 tests**;
  imports exit 0; build exit 0.
- Remaining (genuinely boot-bound): compose the guard over the native `typertGateway` in a real
  deployment + two-browser isolation behavioral sign-off (§B).

## 2026-09-08 — composed seam end-to-end tests (item 3 progress)
- Added 3 integration tests to `remote-guard.spec.ts` composing the whole seam:
  a fake `agents` service → `createRemoteIsolation` → `wrapRemoteGateway` → fake gateway.
  Verifies: a user may read their own session, a foreign session is blocked before reaching
  the gateway, two users are isolated per the active agent, non-admin denied admin namespaces.
  remote-guard.spec now 16 tests; suite green **17 files / 184 tests**; imports exit 0;
  build exit 0.
- `cordis.patch.yml` comment corrected (`/admin` → 设置→用户管理); composition already
  option-A coherent (connection enabled, web-runtime disabled, plugin row present).
- Remaining (genuinely boot-bound): compose the guard over the native `typertGateway` in a
  real deployment + two-browser isolation behavioral sign-off.

## 2026-09-08 — remote-guard glue fix (owns user-scoped) + createRemoteIsolation coverage
- Writing tests for `createRemoteIsolation` exposed a real bug: its `owns` predicate was
  user-independent (`lookup(id) !== undefined`), so user A would "own" user/workspace ids
  belonging to any user who has an ownership record. Fixed: `owns` now scopes to the resolved
  user (`ownership.lookup(id) === user.username`), fail-closed when the caller can't be
  resolved.
- Added 5 `createRemoteIsolation` tests (resolve user from current session id via sidecar;
  user-scoped owns; isAdmin callback; fail-closed on no current session; fail-closed on
  unknown session). Suite now green **17 files / 181 tests**; imports exit 0; build exit 0.
- Remaining: compose the guard over native typertGateway + two-user boot sign-off (§B).

## 2026-09-08 — option A settings-panel client re-home (verified)
- `src/settings-panel.client.js`: standalone `dsh.client` — removed the stale
  `@islibaodong/dsh-login/connection` require and the `connection` provision
  (the native `connection` row owns /api under option A); registers 设置→用户管理/账户
  over `slots`+`locale` only.
- `scripts/build-client.mjs` recreated: `dist/client.js` = a single
  `__ModuleLoader__.load({ id:"@islibaodong/dsh-login", factory })` closure over the panel
  (no connection re-stamp). `package.json` `build` = `build:host && build:client`.
- Removed stale `dist/connection*.js`; `dist/` now only `index.js` + `client.js`.
- Tests updated: `settings-panel.client.spec.ts` (dropped connection-apply assertions),
  `client-bundle.spec.ts` (single-registration option-A shape). Suite green 17/176.
- Remaining isolation gap (also handoff §B): composed guard; needs multi-user web boot.

## 2026-09-08 — CORRECTION: "blocked" was wrong; build + seam are achievable in this session
- Earlier round marked the goal blocked citing (1) "no webServer" and (2) "no TS toolchain".
  Both were **refuted by in-session evidence**: `webServer` is a live injectable service
  (`ctx.get("webServer")` / `inject:["webServer"]`), the harness checkout has
  `node_modules/.bin/tsc` + `pnpm` + built `connection` lib, and this plugin's
  `npm run build:host` **succeeds** (`dist/index.js`, 46.2kb, bundle imports and exports
  `Config/apply/inject/name`). The earlier "no tsc" check ran `npx tsc` from the plugin
  workspace, missing the harness node_modules.
- Live seam characterization: `typertGateway` is injectable with
  `invoke({namespace,method,args})` / `stream`; `InvokeRemoteRequest` carries **no browser-user
  field** — Remote is agent-keyed (Typert Context/agentId). `connection` is NOT a catalogued
  service in this runtime (it's the web-profile transport row).
- New `src/remote-guard.ts` (`wrapRemoteGateway`): typertGateway RBAC wrapper — denies
  admin-only namespaces, denies methods outside the ordinary-user surface
  (`USER_ALLOWED`), denies args addressing a non-owned session/workspace (fail-closed `owns`
  default), admin passthrough. Wired with `resolveUser`/`owns` callbacks. 8 unit tests added;
  suite now **green 17 files / 176 tests**.
- Isolation-in-option-A conclusion: Remote is agent-keyed, so per-user isolation is best
  achieved by construction (each dsh-login user acts inside their own agent subtree recorded in
  the ownership sidecar) + the typertGateway guard. Remaining real deployment glue: the
  agentId→dsh-login-user resolver and owned-set lookup (needs a running multi-session web,
  which this agent session cannot host — no connection/multi-agent). Docs `verify-option-A.md`
  §B updated.

## 2026-09-08 — option A adaptation: host loads + test suite green on 0.1.5
- Continued `docs/adapt-dsh-0.1.5.md` option A. Verifiable state: `scripts/verify-imports.mjs`
  exit 0; **full vitest suite green (16 files / 168 tests)** against the built 0.1.5 harness
  (vitest runs in this workspace).
- `gateway.ts`: login wall (302 /login) restored in the handler; `authorizeIndex` param now
  only forwards to upstream `connection.authorizeIndex` (the 0.1.5 `serveStatic` 6-arg shape).
- Removed obsolete `tests/connection.spec.ts`, `tests/api-filter.spec.ts`,
  `tests/multiuser-e2e.spec.ts` (imported the deleted `dsh-host-apiproxy` takeover); updated
  stale `gateway.spec.ts` (renderIndex always injects boot manifest) and `plugin-entry.spec.ts`
  (no /api takeover → fallback 405).
- Build pipeline reconciled for option A: `build-host.mjs` bundles only `src/index.ts` →
  `dist/index.js`; `build-client.mjs` deleted; `package.json` `build` = `build:host`,
  `vendor/` dropped from files, `dsh-host-apiproxy`/`ws` deps removed.
- Still boot-bound (cannot run in this agent session — no webServer to boot, no TS toolchain):
  per-user isolation seam re-home, settings-panel client re-home + `dist` rebuild, isolation
  tests. Handoff in `docs/verify-option-A.md`.

## 2026-09-08 — analysis: dsh-login incompatible with DSH ≥ 0.1.5-alpha.1 (transport rework)
- Upstream `dsh-v0.1.5-alpha.1` removed the WebSocket-downlink event carrier that
  `src/connection.ts` takes over: commit `dcddaa1a6e` "replace legacy Host event carriers"
  deletes `packages/client/connection/src/websocket-downlink.ts` (`WebSocketDownlinks`,
  `rejectWebSocketUpgrade`), drops `HOST_EVENTS_PATH`/`MUX_EVENTS_PATH` from `api-path.ts`,
  changes `HostConnectionService` ctor to `(ctx, trustedHosts, browserAuth)` and
  `createSharedFetchHandler(channel)` to return a `ConnectionFetchHandler`, and (in a related
  rework) removes the `dsh-host-apiproxy` package (`ApiProxy`, `toFetchHandler`) that the whole
  per-user proxy layer in `api-filter.ts`/`connection.ts` was built on.
- New transport: unary `/api` stays in `dsh-client-connection`; live Remote streams move to a
  **gateway-owned WebSocket mux** (`packages/api/gateway` `TypertGateway` `RemoteStreamMuxServer`)
  fed by `dsh-api-remotes`; `dsh-client-connection` now ships its own **persistent single-session
  `BrowserAuth`** (HMAC cookie + process launch-token index exchange).
- Consequence: shipped dsh-login loads only against DSH `< 0.1.5-alpha.1`. Port is a redesign
  (compose a per-user ownership/authorization layer on the native connection+gateway rather than
  replacing the carrier; decide whether the `connection` row stays disabled; re-filter Remote
  streams at the controller or gateway layer; rebuild `dist/client.js`). Full plan in
  `docs/adapt-dsh-0.1.5.md`.
- Role-based control of third-party UI-plugin slots/sections: **still absent at 0.1.5**
  (`useSections` unchanged, no per-identity slot filter / activation gate).
- Not ported here: this workspace cannot build/verify the security-critical carrier rewrite
  (harness `lib` for apiproxy/connection unbuilt; `connection.ts` can't typecheck). Do not ship
  a blind port. README status + changelog updated to document the incompatibility.

## 2026-08-28 — boundary note: plugin-self-registered `/api/*` exact routes are outside dsh-login
- Regression found that UI plugins (e.g. `@linxin666/dsh-pet`) register their OWN
  exact routes (`/api/pet/pets`, `/api/pet/state`, …) via `webServer.register`
  and serve them with "no session dimension".
- DSH route precedence is **exact beats prefix** and **duplicate exact throws**
  (`packages/host/webserver/src/index.ts` `match()`), and the webserver exposes
  no pre-routing request hook. So dsh-login's `prefix: '/api'` carrier **cannot
  intercept** those plugin routes — they never reach dsh-login's auth layer.
  `/api/pet/pets` returns whatever the plugin serves (200 + public pet-asset
  metadata), not a dsh-login 403/204. Live: `GET /api/pet/pets` as ordinary user
  `test` → 200 with data — the pet plugin's own behavior, not dsh-login's.
- Client-side, plugin fetches fire at client activation (before any slot render);
  `@deepseek-ai/dsh-client-ui-slots` has no capability registration filter; and
  `@deepseek-ai/dsh-client-runtime` activates all bundles with no per-identity
  gate. So for an **unchanged** third-party plugin, dsh-login cannot make it fire
  zero requests.
- dsh-login's OWN client surface is already capability-pruned: the settings panel
  (`settings-panel.client.js`) does `fetchMe()` → renders UsersPanel (admin) or
  AccountPanel (账户) by `me.isAdmin`; ordinary users call only `/api/auth/me`,
  never the admin API. `/api/auth/capabilities` (live, session-authenticated)
  backs any capability-aware client; `window.__DSH_SESSION__` carries a
  conservative ordinary baseline at render.
- Decision (user, Path A): keep capability discovery + the two-segment 204 deny;
  do NOT change harness/webServer; accept that plugin-self-registered `/api/pet/*`
  exact routes are the plugin's own behavior. Committed + deployed + 212 tests.

## 2026-08-28 — two-segment grace: admin-only `/api/<domain>/<member>` probes go quiet (204)
- The capability feature fixed single-segment probes, but two-segment Typert
  endpoints that reach dsh-login's carrier (e.g. `/api/plugin-manager/…`) were
  still 403-ing: `connection.ts` forwarded every two-segment path straight to the
  harness interceptor, bypassing the 204 quiet-denial. Ordinary-user browsers
  kept printing forbidden walls. (Plugin-exact `/api/pet/pets` is a separate
  boundary — see the note above.)
- Fix: `connection.ts` now denies a non-admin request to an admin-only
  **two-segment domain** with the same read-quiet / write-loud shape
  (`isReadProbe(member) || GET/HEAD → 204`, else `403`, gated by `quietDenials`).
- New `capabilities.ts`: `ADMIN_ONLY_TWO_SEGMENT_DOMAINS` (config/secrets,
  pair/update/remote loopback, admin+decoration UI-plugin domains) +
  `isUserDeniedTwoSegment(domain)`. It is a **deny-list by design** to avoid the
  allow-list regression of user-facing two-segment domains (`ssh`, `skill`,
  `settings`, …) — SSH host management (`/api/ssh/*`) is a real ordinary-user
  feature and must keep dispatching. Denying only admin domains strictly
  converts 403→204 with zero user-feature regression.
- Tests: connection.spec.ts (two-segment GET 204 / POST 403 / off→403 / admin
  forwards / allowed-domain two-segment still dispatched 404), capabilities.spec.ts
  (deny-list admits pet/credentials/pair…, never ssh/skill/settings/session/api,
  no overlap with ordinary domain surface). Full suite 212 pass.

## 2026-08-28 — capability discovery + quiet denial of read probes (graceful auth)
- Returning to the plugin's design purpose: an ordinary-user browser session was
  splashing "forbidden" walls + potential retries because installed
  `@linxin666/dsh-client-ui-*` plugins (task-board, plugin-manager, agentPreset,
  doctor, …) probe `/api/*` at startup even when the user has no access. Redesign
  the permission experience from "passively reject with 403" to "the client knows
  the boundary and quiet side." Authorization is NOT loosened — only the shape of a
  denied read.
- new `src/capabilities.ts`: `deriveCapabilities(isAdmin)` (methods from
  USER_ALLOWED + USER_DOMAINS + uiPlugins; admin = full superset incl.
  credentials/settings/agentPresets and admin-only UI plugins),
  `isReadProbe(method)` (read-verb heuristic + `QUIET_DENY_METHODS` set),
  `userAllowedMethods()`.
- new route `GET /api/auth/capabilities` (admin-api.ts): returns per-identity
  `{ username, isAdmin, capabilities }`; session-authenticated (not admin-gated).
- index.ts: `webserver/index-inject` pushes a static non-admin baseline into
  `window.__DSH_SESSION__` (render-time cannot know the identity; clients needing
  the exact identity fetch the live endpoint).
- connection.ts physical layer: for a non-admin, non-allowed single-segment
  method, a **read probe** (read-verb name OR GET/HEAD on a forbidden path OR a
  QUIET_DENY_METHODS verb) answers **204 No Content** when `quietDenials` is on;
  side-effecting writes keep **403**. New config `quietDenials: boolean` (default
  true) wired through TakeoverDeps; off restores plain 403 everywhere.
- Tests: `capabilities.spec.ts` (derive + isReadProbe + parity with allow-list);
  connection.spec.ts (+5: read probe→204, GET probe→204, write→403, quietDenials
  off→403); admin-api.spec.ts (+3 capabilities endpoint: ordinary/admin/anonymous).
  Full suite 205 pass.

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

### Session ended at 18:01

**Git diff:**
```
 .claude/rules/changelog.md |   71 ++++
 .claude/rules/gotchas.md   |   13 +-
 .gitignore                 |    1 +
 README.md                  |    4 +-
 README.zh.md               |    4 +-
 dist/index.js              |   24 +-
 dist/index.js.map          |    4 +-
 package-lock.json          | 1142 +++++++++++++--------------------------------------
 package.json               |   28 +-
 src/api-filter.ts          |   12 +
 src/capabilities.ts        |    4 +
 src/login-page.ts          |  511 +++++++++++++++++------
 tests/capabilities.spec.ts |   23 ++
 tests/remote-guard.spec.ts |   21 +
 14 files changed, 866 insertions(+), 996 deletions(-)
```

**Recent commits:**
```
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
a1db200 chore: ignore tooling config and scratch files
8f5e28f feat(option-a): re-adapt to DSH >= 0.1.5-alpha.1 + code-review hardening
```

### Session ended at 18:05

**Git diff:**
```
 .claude/rules/changelog.md |  101 +++++
 .claude/rules/gotchas.md   |   13 +-
 .gitignore                 |    1 +
 README.md                  |    4 +-
 README.zh.md               |    4 +-
 dist/index.js              |   24 +-
 dist/index.js.map          |    4 +-
 package-lock.json          | 1142 +++++++++++++--------------------------------------
 package.json               |   28 +-
 src/api-filter.ts          |   12 +
 src/capabilities.ts        |    4 +
 src/login-page.ts          |  496 ++++++++++++++++------
 tests/capabilities.spec.ts |   23 ++
 tests/remote-guard.spec.ts |   21 +
 14 files changed, 883 insertions(+), 994 deletions(-)
```

**Recent commits:**
```
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
a1db200 chore: ignore tooling config and scratch files
8f5e28f feat(option-a): re-adapt to DSH >= 0.1.5-alpha.1 + code-review hardening
```

### Session ended at 18:15

**Git diff:**
```
 .claude/rules/changelog.md |  131 ++++++
 .claude/rules/gotchas.md   |   13 +-
 .gitignore                 |    1 +
 README.md                  |    4 +-
 README.zh.md               |    4 +-
 dist/index.js              |   24 +-
 dist/index.js.map          |    4 +-
 package-lock.json          | 1142 +++++++++++++--------------------------------------
 package.json               |   28 +-
 src/api-filter.ts          |   12 +
 src/capabilities.ts        |    4 +
 src/login-page.ts          |  567 +++++++++++++++++++------
 tests/capabilities.spec.ts |   23 ++
 tests/remote-guard.spec.ts |   21 +
 14 files changed, 981 insertions(+), 997 deletions(-)
```

**Recent commits:**
```
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
a1db200 chore: ignore tooling config and scratch files
8f5e28f feat(option-a): re-adapt to DSH >= 0.1.5-alpha.1 + code-review hardening
```

### Session ended at 18:16

**Git diff:**
```
 .claude/rules/changelog.md |  161 ++++++++
 .claude/rules/gotchas.md   |   13 +-
 .gitignore                 |    1 +
 README.md                  |    4 +-
 README.zh.md               |    4 +-
 dist/index.js              |   24 +-
 dist/index.js.map          |    4 +-
 package-lock.json          | 1142 +++++++++++++--------------------------------------
 package.json               |   28 +-
 src/api-filter.ts          |   12 +
 src/capabilities.ts        |    4 +
 src/login-page.ts          |  653 +++++++++++++++++++++++------
 tests/capabilities.spec.ts |   23 ++
 tests/remote-guard.spec.ts |   21 +
 14 files changed, 1097 insertions(+), 997 deletions(-)
```

**Recent commits:**
```
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
a1db200 chore: ignore tooling config and scratch files
8f5e28f feat(option-a): re-adapt to DSH >= 0.1.5-alpha.1 + code-review hardening
```

### Session ended at 18:20

**Git diff:**
```
 .claude/rules/changelog.md |  191 +++++++++
 .claude/rules/gotchas.md   |   13 +-
 .gitignore                 |    1 +
 README.md                  |    4 +-
 README.zh.md               |    4 +-
 dist/index.js              |   24 +-
 dist/index.js.map          |    4 +-
 package-lock.json          | 1142 +++++++++++++--------------------------------------
 package.json               |   28 +-
 src/api-filter.ts          |   12 +
 src/capabilities.ts        |    4 +
 src/login-page.ts          |  661 +++++++++++++++++++++++------
 tests/capabilities.spec.ts |   23 ++
 tests/remote-guard.spec.ts |   21 +
 14 files changed, 1135 insertions(+), 997 deletions(-)
```

**Recent commits:**
```
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
a1db200 chore: ignore tooling config and scratch files
8f5e28f feat(option-a): re-adapt to DSH >= 0.1.5-alpha.1 + code-review hardening
```

### Session ended at 18:23

**Git diff:**
```
 .claude/rules/changelog.md | 2 ++
 1 file changed, 2 insertions(+)
```

**Recent commits:**
```
762d3f7 feat(login-page): 重设计登录界面 —— 分屏布局与插件特色文案
7d4e4ec feat: 适配 DSH 0.1.6-alpha.1（0.2.1，未发布）
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
```

### Session ended at 18:24

**Git diff:**
```
 .claude/rules/changelog.md | 19 +++++++++++++++++++
 1 file changed, 19 insertions(+)
```

**Recent commits:**
```
762d3f7 feat(login-page): 重设计登录界面 —— 分屏布局与插件特色文案
7d4e4ec feat: 适配 DSH 0.1.6-alpha.1（0.2.1，未发布）
5f7b64b docs: sync READMEs with released 0.2.0 state + lockfile deps cleanup
87920be chore: gitignore npm artifacts (env + recovery codes); record 0.2.0 publish
31feecd chore(release): 0.2.0 — retarget peerDependencies to DSH >= 0.1.5-alpha.1
```
