# Adapting dsh-login to DSH 0.2.3-alpha.2 (→ released as 0.3.20)

> Follow-up to [`docs/adapt-dsh-0.2.3-alpha.1.md`](adapt-dsh-0.2.3-alpha.1.md) (0.3.19).
> Watch cycle 2026-11-23 (scheduled `0 12 * * *` Asia/Shanghai); released as
> **0.3.20**.
>
> 0.2.3-alpha.2 is a **vendor-only + Node-floor release**: no remote-decorated
> source changed (the wire registry stays byte-identical at 264), and every seam
> dsh-login mounts is byte-stable. It nevertheless **breaks the login wall's
> entry point**: alpha.1 added a core exact `/` route in
> `packages/client/remote-connection`, which shadows the plugin's index fallback
> and serves a 404 to a logged-in browser. 0.3.20 hooks that route through the
> `webserver/request` waterfall. Still **no native multi-user support** (§5).

## 1. Version detection

| source | value at detection (2026-11-23 12:00 +08) |
|---|---|
| npm dist-tags | `@deepseek-ai/dsh` `alpha` → **0.2.3-alpha.2**, published `2026-11-22T09:57:12.419Z` (17:57 +08, ~18 h before the trigger; the 2026-11-22 12:00 watch had seen alpha.1 at `2026-11-22T03:45:26.697Z`). `next`/`latest` stay `0.2.2-rc.5`. Every inspected `@deepseek-ai/dsh-*` package carries the same `alpha` = 0.2.3-alpha.2. |
| git tags | `dsh-v0.2.3-alpha.2` → `4b399c39a6` (release merge of PR #8961; release commit `267805d20d`, 2026-11-22 15:27 +08); previous newest tag `dsh-v0.2.3-alpha.1` → `d98f5d6851`. |
| commits between | alpha.1 → alpha.2: **5 commits** (release merge, `release(dsh): 0.2.3-alpha.2`, vendor release, Node-floor chore). 488 files changed, overwhelmingly `package.json` version stamps + `pnpm-lock.yaml`. |
| semver fit | `0.2.3-alpha.2` already satisfies the peer union 0.3.19 shipped (`>=0.2.3-alpha.1 <0.3.0-0`), so only the runtime `dependencies` pin and devDeps needed a version bump. The vendor peers did need new comparators (`~4.2.0-alpha.1` cordis, `~3.20.0-alpha.1` schemastery). |
| **bootable on npm** | **yes** — unlike alpha.1 this channel starts. `@deepseek-ai/cordis-plugin-loader@1.2.0-alpha.1` is now published with the exports `dsh-app-boot` imports (`EntryValidationError`, `formatIssues`, `relocate`, `validateOptions`), and `@deepseek-ai/cordis@4.2.0-alpha.1` / `@deepseek-ai/schemastery@3.20.0-alpha.1` exist too. alpha.1 was unbootable for exactly that missing loader. |
| registry | the default mirror (`registry.npmmirror.com`) still lacks the alpha line; installs used `--registry=https://registry.npmjs.org`. |
| dump source | worktree `E:\code\deepseek-harness-wt-023a1` re-checked-out at the tag: `pnpm install --frozen-lockfile --ignore-scripts` → `pnpm exec tsx scripts/generate-typert.ts` → 44 artifacts, then `node scripts/dump-wire-surface.mjs --checkout … --version 0.2.3-alpha.2`. npm tarballs remain an invalid dump source (no `typert.remote-client.d.ts`). |

## 2. What alpha.2 actually changed

- **Vendored framework bump only.** `vendor/*` diffs touch nothing but the
  version field: cordis 4.1.0 → **4.2.0-alpha.1**, schemastery 3.19.0 →
  **3.20.0-alpha.1**, loader 1.1.0 → **1.2.0-alpha.1**, include/hmr/group/
  logger-console/timer/cosmokit → their `*-alpha.1` builds. Three non-`package.json`
  files changed inside `packages/`, all comment-only (`boot/app-boot/src/profile-resolution/resolver.ts`,
  `boot/hmr/src/package-manifest.ts`, `ptc-runtime/ptc-runtime-node/src/imports/vm-modules.ts` —
  reworded `v8-ignore` comments). No remote-decorated logic, hence 264 → 264.
- **Node floor raised to `^24.22.3 || >=26.13.1`** (was `>=24.9.0`), following
  November-2026 undici security fixes; the guide is
  `docs/upgrade-guide/v0.2.3-alpha.1/node-24-22-3/guide.md`. dsh-login no longer
  claims to run the host on 24.9.0: every verification below runs on **Node 24.22.3**
  (nvm install, invoked by absolute path — the machine's global nvm switch was
  left alone).

No plugin source change would have been needed for alpha.2 itself. The break
below is inherited from alpha.1.

## 3. The regression alpha.2 exposed: core now owns `/`

**Symptom (live, npm alpha.2 + packed 0.3.20 tarball):** `GET /` with a valid
`dsh_session` cookie answered **404 / 0 bytes / chunked**, while `/index.html`
and `/login` answered 200. Anonymous `/` no longer redirected to `/login`; it
rendered core's "Connect to this Host" card (401, CSP `default-src 'none'`).
The login wall had stopped covering the entry point.

**Mechanism.** DSH 0.2.3-alpha.1 (commit `5313ad4bfa`, *pair browsers through the
shared root login page*) registers a core route at
`packages/client/remote-connection/src/index.ts:150`:

```ts
ctx.webServer.register({
  kind: 'exact', path: '/', auth: 'anonymous',
  resource: async (request, admitted) => this.readRoot(request, admitted),
})
```

`readRoot` renders the core authentication page when admission is a rejection,
and otherwise delegates to the index resource:
`this.owner.webServer.readResource(new Request(new URL('index.html', request.url), …), admission.peer)`.
`webServer.readResource` documents a **404 when the path reaches the fallback
seat while it is unclaimed or holds a handler** — and dsh-login claims that
fallback seat as a *handler* (`registerGatewayFallback`). So a logged-in browser
got 404, and an anonymous one got core's page instead of the plugin's login wall.
`webServer.register` refuses a duplicate `(kind, path)` pair
(`webserver: duplicate ${kind} route "${path}"`), so the core route cannot be
replaced; `webserver/entry-url` (`{label, url, open}`) cannot express "send users
to `/login`" either, and remote-connection's `tokenLoginUrl` needs the same
pathname `/` plus exactly one non-empty `token` parameter, so it cannot be
leveraged.

**Fix (0.3.20)** — the `webserver/request` waterfall runs **before** named-route
dispatch, so it preempts the core route without a competing registration:

| piece | file |
|---|---|
| `isRootRequest(request) → boolean` (GET/HEAD on pathname `/`, no `token` param) and `createRootRouteListener(gateway) → (request, response, next)` | `src/root-route.ts` (new) |
| `ctx.effect(() => ctx.on('webserver/request', createRootRouteListener(gatewayHandler)), 'dsh-login: root route hook')`, registered right after the gateway fallback effect | `src/index.ts` |
| 4 cases: claim GET/HEAD `/` (with and without a query string), refuse `/index.html`, `/login`, `/settings/workspaces`, `POST /`, `/?token=…`; the listener answers a root request via the gateway and never calls `next()` | `tests/root-route.spec.ts` (new) |

Because `gatewayHandler` is the same handler that owns the login wall, `/` gets
exactly the plugin's semantics: no/stale session → `302 /login`, live session →
the rendered index (with the peer minted inside the handler, since the waterfall
callback has no `admitted` argument). `/?token=…` is deliberately **not** claimed,
so the native `authentication-token` listener still answers it.

## 4. Wire surface: unchanged at 264

`tests/fixtures/wire-surface.json` re-dumped from the tag worktree; the only
diff is `"dshVersion": "0.2.3-alpha.2"`. Buckets stay **146 USER / 117 ADMIN /
1 HOST-INTERNAL = 264**, `src/api-filter.ts:53` (`WIRE_SURFACE_DSH_VERSION`)
points at the new version. Nothing in `dsh-login`'s classification changed.

## 5. Multi-user / role verdict at 0.2.3-alpha.2

A full re-grep of the tag (`git grep -nEi 'multi.?user|multiuser|role.?based|\brbac\b'`
over `packages/` + `apps/`) yields **two hits only**: the
`packages/api/remote-access/README.md:2` blurb about role-based policy decisions
for non-owner Peers, and an NSIS `!insertmacro initMultiUser` line in
`apps/desktop/scripts/windows-directory-installer.mjs:109` (an all-users/per-user
*installer* macro, unrelated to product accounts).

- **No accounts, no identity UI, no gating of owner Peers.** `PrincipalMap`
  (`packages/typert/protocol/src/types.ts:455`) still declares exactly `owner`;
  every shipped provider mints owner Peers; the only production non-owner kind
  remains LiveShare's `share-viewer`
  (`packages/experimental/liveshare/src/host/viewer-principal.ts:17`).
- **Resource RBAC exists for non-owner Peers only.**
  `remoteAccess.registerPolicy<K extends Exclude<keyof PrincipalMap,'owner'>>(kind, policy)`
  (`packages/api/remote-access/src/index.ts:153`), consulted at
  `packages/api/gateway/src/index.ts:610` (events) and `:791` (calls) only when
  `principal.kind !== 'owner'`. A dsh-login user is an owner Peer, so this engine
  never gates them — dsh-login remains the account/authn layer, and its own
  allow-list + dispatch guard is the per-user boundary.
- **The whole-UI role gate remains feasible in-plugin, unchanged in shape.** The
  two seams are still `webserver/index-inject(table, peer)`
  (`packages/host/webserver/src/index.ts:867` `renderIndex(html, peer)`; listener
  registration at `packages/api/remote-access/src/index.ts:139`) and
  `clientModules.graphFor(principal)`
  (`packages/client/modules/src/index.ts:721` / `:739-740` → `syncedConfig.graphFor(composed, principal)`,
  which still only varies config values, with no role concept). `graph.entries`
  and `graph.batches` must be trimmed together; the `webserver/authorize` bail
  sees the request but never a resolved principal, so arbitrary-role gating
  cannot move there. Analysis: [`docs/role-based-ui-gating.md`](role-based-ui-gating.md).

## 6. Verification

| check | result |
|---|---|
| dependency resolution | clean install (`node_modules` + lockfile deleted) against `registry.npmjs.org`; all `@deepseek-ai/dsh-*` at 0.2.3-alpha.2, cordis `~4.2.0-alpha.1`, schemastery `~3.20.0-alpha.1`, include/loader `~1.2.0-alpha.1`; peer unions gained `|| ~4.2.0-alpha.1` / `|| ~3.20.0-alpha.1` |
| `vitest run` (Node 24.22.3) | **24 files / 315 tests green** (23 pre-existing + `tests/root-route.spec.ts`) |
| wire fixture | dumped from the tag worktree: **264 == 264**, only `dshVersion` changed; buckets 146 / 117 / 1 |
| `npm run build` | exit 0; `dist/client.js` rebuilt (stamp only); `dist/index.js` carries the `root route hook` |
| `npm run verify:imports` | exit 0 (15 modules) |
| **live boot on npm 0.2.3-alpha.2** | boots (alpha.1 could not). Scratch `DSH_HOME`, packed 0.3.20 tarball installed into `profiles/web` (`--legacy-peer-deps`), bundles extended with `@islibaodong/dsh-login`; the plugin's admission provider replaces the native token URL (no `?token=` printed) |
| live probes, anonymous | `GET /` → **302 `/login`**; stale/bogus `dsh_session` → 302; `GET /login` → 200; `/api/auth/me` and `/api/auth/capabilities` → 401 `{"error":"authentication required"}` |
| live probes, owner | `POST /api/auth/setup` → 200 `{"ok":true}` + `dsh_session`; `GET /api/auth/me` → `{"username":"owner","isAdmin":true,"usersSidebarVisible":true}`; `GET /` → **200, 48685 bytes**, `text/html`, body carries `__DSH_BOOT__` and `__DSH_SESSION__`; `/index.html` → 200; capabilities → 263 methods / 48 domains / 17 uiPlugins; `GET /?token=bogus` → 401 (passed through to the native token listener) |
| live probes, ordinary user | admin creates `alice` → 201; `POST /api/auth/login` → 200; `/api/auth/me` `{"username":"alice","isAdmin":false}`; `GET /` → 200 (same 48685-byte page); capabilities → **146 methods / 31 domains / 1 uiPlugin**; `/api/auth/admin/users` → **403** |
| known limitation (unchanged) | `/settings` (a client-side SPA path) is not served by the fallback (files only) — pre-existing behaviour, unrelated to this fix |

## 7. Follow-ups

- The plugin now always claims GET/HEAD `/` through the waterfall. If upstream
  later lets a plugin *replace* an exact route idempotently, that is the cleaner
  seat; today a duplicate registration throws, so the waterfall is the only seam.
  Re-check `packages/client/remote-connection`'s root route on every watch cycle —
  it is also where remote pairing/QR login lives, so its `auth` policy or
  `readRoot` delegation contract could change again.
- Node 24.22.3 is now the minimum the *host* claims; dsh-login's own `engines`
  stay conservative, but the README and CI notes now say 24.22.3.
- Still open upstream: no accounts/roles (`PrincipalMap` has one kind), and no
  resolved principal at admission time — both would be needed for native, role-based
  whole-UI gating.
