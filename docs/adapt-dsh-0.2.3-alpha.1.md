# Adapting dsh-login to DSH 0.2.3-alpha.1 (→ released as 0.3.19)

> Follow-up to [`docs/adapt-dsh-0.2.2-rc.5.md`](adapt-dsh-0.2.2-rc.5.md) (0.3.18).
> Watch cycle 2026-11-22 (scheduled `0 12 * * *` Asia/Shanghai); released as
> **0.3.19**. This is the first release that is **not** a pure re-pin: 0.2.3-alpha.1
> rewrote webserver admission (per-route `auth` rules, a `webserver/authorize`
> bail event, peer-aware handlers) and deleted `connection.browserAuth` /
> `connection.authorizeIndex`, replacing them with a
> `connection.authentication` provider registry. dsh-login's login wall had to
> declare itself anonymous and mint its own per-session Peers. The wire registry
> grows **226 → 264** (+38 / −1). There is still **no native multi-user support**
> at the tag (see §6).

## 1. Version detection

| source | value at detection (2026-11-22 12:00 +08) |
|---|---|
| npm dist-tags | `@deepseek-ai/dsh` `alpha` → **0.2.3-alpha.1**, published `2026-11-22T03:21:42.976Z` (~39 min before the trigger); `next` and `latest` stay `0.2.2-rc.5`. Read with a no-cache packument GET of `registry.npmjs.org`. A plain `npm view` served a stale cached packument that falsely reported the alpha missing — the raw packument showed every inspected package (`dsh`, `dsh-settings`, `dsh-web-frontend`, `dsh-client-modules`) at 0.2.3-alpha.1. |
| git tags | `dsh-v0.2.3-alpha.1` → `d98f5d6851` (release commit `aae91d692e`); previous newest tag `dsh-v0.2.2-rc.5` → `9c2670d3bc`. `origin/master` moved to the alpha.1 tag. |
| commits between | `dsh-v0.2.2-rc.5` → `dsh-v0.2.3-alpha.1`: **2343 commits** |
| semver fit | `0.2.3-alpha.1` does **not** satisfy the previous peer tuple (`>=0.2.2-alpha.2 <0.3.0-0`): a prerelease only matches a comparator whose tuple carries a prerelease on the same base version. Every DSH peer union therefore gained `|| >=0.2.3-alpha.1 <0.3.0-0`; devDeps moved to `^0.2.3-alpha.1`. |
| registry | the default mirror (`registry.npmmirror.com`) does **not** have the alpha (`ETARGET @deepseek-ai/dsh-client-modules@^0.2.3-alpha.1`); the clean install had to use `--registry=https://registry.npmjs.org`. |
| dump source | fresh worktree `E:\code\deepseek-harness-wt-023a1` at the tag, `pnpm install --frozen-lockfile`, `pnpm exec tsx scripts/generate-typert.ts` → 44 Typert artifacts. npm tarballs remain an invalid dump source (they ship only `lib/types`, no `typert.remote-client.d.ts`). |

## 2. The webserver admission rewrite (breaking)

`packages/host/webserver/src/index.ts` at alpha.1:

- Every route kind (`WebRoute`, `WebResourceRoute`, `WebUpgradeRoute`) gained an
  optional `auth?: WebAuthenticationRule` where
  `WebAuthPolicy = 'anonymous' | 'required' | 'deny'` and the rule is either a
  policy or `(request) => policy`. **The default is `'required'`** — a route that
  does not declare itself now requires an admitted Peer.
- Admission returns `WebAdmission = {kind:'allow', peer?: PeerScope} | {kind:'deny', status: 401|403|503}`.
  A new bail event `webserver/authorize(request, policy)` lets one listener decide;
  the built-in fallback is `anonymous → allow`, otherwise `503`.
- `registerFallback` now accepts `WebFallback` (`{handler, resource, auth}`), not
  just a bare handler; a function is normalized to `{handler}` and inherits
  `'required'`.
- Handlers receive the admitted `PeerScope` (optional fourth argument on upgrades);
  `renderIndex(html, peer: PeerScope)` and `collectIndexInjections(peer)` emit
  `webserver/index-inject(table, peer)`.

Consequence for dsh-login: `/login`, `/api/auth/*`, `/logout`, the admin routes
and the index fallback would all have answered **503 before their own cookie wall
ran**, and the fallback could not render the index because it had no peer.

## 3. The connection authentication seam (replacement for browserAuth)

`packages/client/connection`:

- `/api` (prefix) and `/api/remote.mux` (upgrade) are now declared
  `auth: 'required'`; the admitted `PeerScope` is forwarded into
  `connection/request` and into the WS mux. `connection.admit` is **not** called
  on that path any more — identity arrives through webserver admission.
- New service `connection.authentication` (`ConnectionAuthentication`):
  `register(provider): () => Promise<void>` and
  `authenticate(request: ConnectionTrustRequest): PeerAdmission`.
  Providers are consulted in registration order; the first live Peer wins, no
  provider ⇒ `401`, a throwing provider ⇒ `503`.
- `AuthenticationProvider.authenticate(request): PeerScope | undefined` where
  `ConnectionTrustRequest = {headers, signal?, socket?, method?, url?}`.
- `HostConnectionService` installs the `webserver/authorize` listener itself:
  untrusted Host/Origin ⇒ 403, `anonymous` ⇒ allow, otherwise delegate to the
  provider registry. It also exposes `createPeer({principal, interactions?})`.
- `browserAuth` / `authorizeIndex` / `launchToken` are **gone** from the service.
  Browser cookies moved into the standalone `@deepseek-ai/dsh-host-authentication-token`
  plugin, which registers its own provider and `/connect` route (`auth: 'anonymous'`).

## 4. dsh-login adaptation

| seam | before (≤ 0.2.2-rc.5) | after (0.2.3-alpha.1) |
|---|---|---|
| login/setup/logout/admin routes | plain `register(route)` | declare `auth: 'anonymous'` (ignored by older servers) |
| index fallback | bare handler function | probe `webServer.fallback`: a normalized `{handler}` means the object form is supported → re-register `{handler, auth: (request) => live session ? 'required' : 'anonymous'}`; otherwise stay on the bare function |
| `/api` identity | reloaded `GET /?token=` through `connection.authorizeIndex` and replayed `set-cookie` (`mintCoreCookie`) | `connection.authentication.register(provider)` — the provider maps the `dsh_session` cookie to a per-session owner `Peer` (`createPeer({principal:{kind:'owner'}})`, cache 256, tagged with the user so the dispatch shadows still see identity) |
| index render | fake `{principal:{kind:'owner'}}` peer | real admitted `PeerScope` (fake peer kept only on rc.5) |
| old `browserAuth` path | always | capability-gated: skipped when the service carries the `connection.authentication` registry (guarded read — cordis throws on undeclared service properties, so the probe catches and treats that as "absent", which is the rc.5 answer) |

Implementation notes:

- `src/web-auth.ts` (new) owns cookie→Peer mapping, the bounded cache, tagging and
  disposal. It reads `connection` lazily so the plugin still works when the
  connection row loads later.
- The provider seat is `ctx.inject(['connection', 'connection.authentication'], …)`.
  Cordis' tracker throws `cannot get property "connection.authentication" without
  inject` on property access from an under-declared fiber — the callback then dies
  silently and no provider lands in the registry, which surfaces as a blanket 401
  on `/api`.
- The seat's `auth` selector requires a Peer only when the provider seam can mint
  one; on connection-less boots the page stays `anonymous` and the legacy cookie
  wall in the gateway handler still decides.
- `/api` route handlers now receive the admitted peer, so the gateway's render
  seam no longer fabricates an owner.

## 5. Wire-surface delta (226 → 264)

**+38 / −1.** Removed: `forgePanel.branches`. Added:

- `connectorAccounts.cancel/start/watch`, `remoteConnection.cancel/create/decidePairing/loginUrl/pairingRequests/status`,
  `pluginEvents.follow`, `sessionStatus.follow/mark`, `permissionPresets.set`;
- 22 host-scoped `forgePanel.review*` methods (`reviewRefresh`, `reviewPoll`,
  `reviewChangeRequest`, `reviewDescription`, `reviewChecks`, `reviewThreads`,
  `reviewThreadWrite`, `reviewSubmit`, `reviewDiff`, `reviewCommits`, `reviewText`,
  `reviewViewed`, `reviewSetViewed`, `reviewMarkReady`, `reviewMerge`,
  `reviewRerunChecks`, `reviewRequestReviews`, `reviewReviewerCandidates`,
  `reviewUpdateBranch`, `reviewLists`, `reviewCount`, `reviewStage`);
- four session-scoped forge reads: `changesLens`, `extensions`, `revisit`, `worktreeBases`.

Classification (total + disjoint, enforced by `tests/wire-surface.spec.ts`):
**146 USER / 117 ADMIN / 1 HOST-INTERNAL** = 264.

- `forgePanel.review*` takes a URL, not a Session, and runs on host forge credentials
  that can merge any PR → admin-only, like `liveshareShares`.
- `permissionPresets.set` sets the caller's own Session approval policy;
  `sessionStatus.mark/follow` are per-Session read state filtered by
  `ctx.remoteAccess.allows` → user-allowed.
- `pluginEvents.follow` streams the live plugin graph; re-activating an omitted
  bundle there would undo the whole-UI role gate → admin-only.
- `connectorAccounts.*` (host connector credentials) and `remoteConnection.*`
  (host network pairing) → admin-only.

## 6. Multi-user / role verdict at 0.2.3-alpha.1

**No native multi-user accounts.** `PrincipalMap` still ships exactly one entry,
`owner` (`packages/typert/protocol/src/types.ts:455`); every shipped provider
mints owner Peers (`HostConnectionService.browserPeer`, the authentication-token
plugin's single shared browser Peer, desktop, remote-connection). The only
non-owner kind in production is LiveShare's `share-viewer`
(`packages/experimental/liveshare/src/host/viewer-principal.ts:16`).

**Resource RBAC exists, but only for non-owner principals.** A business package
declares a policy per principal kind through
`remoteAccess.registerPolicy(kind, policy)`; the gateway consults
`remoteAccess.decide(...)` only when `principal.kind !== 'owner'`
(`packages/api/gateway/src/index.ts:781-802`), and non-owner Peers can never
answer forwarded Remote events. A dsh-login user is an owner Peer, so this engine
never gates it.

**The UI has no role concept.** The boot manifest differs per Peer only in
config values (`client/modules/src/index.ts:720-722` `graphFor(peer.principal)`);
the bundle route serves one anonymous prefix for every bundle. In-plugin
whole-UI role gating is still feasible and unchanged in shape (see
[`docs/role-based-ui-gating.md`](role-based-ui-gating.md)): the per-peer
`webserver/index-inject` table and `clientModules.graphFor` remain the two
seams, and both must trim `graph.entries` and `graph.batches` consistently.
The new `webserver/authorize` bail event cannot help here — it sees the request,
not a resolved principal. dsh-login remains the account layer.

## 7. Verification

| check | result |
|---|---|
| dependency resolution | clean install after deleting `node_modules`/`package-lock.json`, `--registry=https://registry.npmjs.org`; all `@deepseek-ai/dsh-*` at 0.2.3-alpha.1, vendor (cordis 4.1.0 / schemastery 3.19.0) unchanged |
| `vitest run` | **23 files / 311 tests green** |
| `tests/web-auth.spec.ts` (new) | real HttpServer + real client-connection composition: anonymous `/api` → 401, logged-in `GET /api/does-not-exist` → 404 (bridge, not the webserver fence), `/` → 200 for a live session, 302 for a stale cookie |
| wire fixture | dumped from the tag worktree: **264 == 264**, `dshVersion 0.2.3-alpha.1` |
| `npm run build` | exit 0; `dist/client.js` rebuilt (stamp only) |
| `npm run verify:imports` | exit 0 |
| live boot on **0.2.2-rc.5** (npm `@deepseek-ai/dsh@0.2.2-rc.5` + packed 0.3.19 tarball in `profiles/web`, installed with `--legacy-peer-deps` so the profile keeps the runtime's own `@deepseek-ai` copies) | `GET /` → 302 `/login` anonymous; `/login` → 200; anonymous `/api/*` → 401 `unauthorized`; `POST /api/auth/setup` → 200 + `dsh_session`; `GET /api/auth/me` → 200 `{"username":"root","isAdmin":true}`; `GET /` with the session → 200 **and** `set-cookie: dsh-auth-…` (the legacy `mintCoreCookie` seat is still exercised on rc.5); `GET /api/does-not-exist` with both cookies → 404 `not found` (bridge, not the fence) |
| live boot on **0.2.3-alpha.1** (npm) | **not possible today** — the published alpha cannot start: `@deepseek-ai/dsh-app-boot@0.2.3-alpha.1/lib/index.js` imports `EntryValidationError`, `formatIssues`, `relocate`, `validateOptions` from `@deepseek-ai/cordis-plugin-loader`, but the newest published loader (`1.1.0`) exports none of them (the repo vendors the newer loader at `vendor/loader`; no newer build is on npm). Fails with `SyntaxError: The requested module '@deepseek-ai/cordis-plugin-loader' does not provide an export named 'EntryValidationError'` before any profile loads. The monorepo dev tree is the only runnable 0.2.3-alpha.1 today; alpha.1 coverage therefore rests on the composition test above (real `@deepseek-ai/dsh-http-server` + real `@deepseek-ai/dsh-client-connection` from npm). |

## 8. Follow-ups

- The `webserver/authorize` bail cannot distinguish a principal; if upstream ever
  resolves identities before admission, role-gating should move there.
- `connection.authentication` is alpha.1-only; the capability probe is a
  guarded read of the service property (cordis throws on undeclared service
  properties, the probe treats that as "absent") and keeps rc.5 deployments on
  the legacy cookie path. Do **not** probe `createPeer`: rc.5 already had it,
  and gating on it silently drops rc.5's `dsh-auth` cookie mint, which turns
  every authenticated `/api` call into 401.
- Upstream, for the next alpha: `@deepseek-ai/cordis-plugin-loader` must be
  published with the loader API `dsh-app-boot` imports (`EntryValidationError`,
  `formatIssues`, `relocate`, `validateOptions`). Until then the npm channel of
  the alpha is unbootable and only `pnpm start:web` from the monorepo works.
