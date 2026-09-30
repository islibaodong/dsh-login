# DSH 0.2.0-rc.2 compatibility check (2026-09-29/30, verified 2026-09-30)

Status: **adapted and RELEASED as `@islibaodong/dsh-login@0.2.5`** (npm latest,
2026-09-30T02:55Z; git tag `v0.2.5` + master pushed). First release on the
**0.2.0 tuple line** — unlike the 0.1.7-line rc.1/rc.2 checks, the existing
peer ranges could not admit a 0.2.0 prerelease, so a peer retarget + release
was mandatory (the boot-time compatibility admission would otherwise have
skipped the bundle → fail-open boot without the login wall). Suite **18 files
/ 209 tests green** on real 0.2.0-rc.2 builds at release time (re-verified
2026-09-30 with 211 tests after the guard-forwarding hardening below).
Previous adaptation: `docs/adapt-dsh-0.1.7-rc.2.md`.

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new **`0.2.0-rc.1` + `0.2.0-rc.2`** under the **`next`** dist-tag (rc.2 published 2026-09-29T09:44Z; `alpha` stays 0.1.7-alpha.2; `latest` still stale 0.0.1-rc.1). |
| Harness checkout | tags `dsh-v0.2.0-rc.1` / `dsh-v0.2.0-rc.2` (release merge `639ed01539`, PR #5479, release commit `c1b47e41fc`); **448 commits** since `dsh-v0.1.7-rc.2` (187 between 0.2.0-rc.1 and rc.2); `origin/master` == the release merge. |

## 2. Compatibility surface (448 commits, diffed against `dsh-v0.1.7-rc.2`)

Release themes (PR merges): desktop CLI management (#5288), the new
`packages/telemetry` OTel package, windows-ACL/pwsh robustness fixes, schedule
feature moved into an optional experimental bundle, model search, docs
upgrade-guide structure. **No plugin-API breaking change on this plugin's
surface**:

| Integration point | 0.2.0-rc.2 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver`, `dsh-host-frontend-static`, `dsh-settings`, `dsh-credentials` core, `dsh-client-connection` | **src unchanged** | none — gateway fallback seat, `authorizeIndex`, api-bridge-auth `connection/request` wall, settings error wording all intact |
| `packages/api/gateway` | **additive only**: new `TypertGateway.hasLiveClient()` (required interface member at rc.2, absent at rc.1) + client records carry an `AbortSignal` | **primitive hardening** (§3): the shipped deployment never wraps the gateway so nothing breaks, but `wrapRemoteGateway` now forwards non-dispatch members |
| `packages/bundle/web-app` (row source; NOTE the real path is `packages/bundle/web-app`, not `packages/web-app`) | `web-runtime` + `connection` rows **untouched**; schedule `time-context`/`schedule`/`ui-schedule` rows removed (moved to the optional `dsh-experimental-schedule-bundle`); desktop-gated `desktop-product-telemetry` + `product-analytics` rows added (disabled unless profile `desktop`); new `ui-settings-session-log` settings row | `cordis.patch.yml` applies as-is. The new settings section renders for every user (upstream renders one global section list) but its reads are admin-only domains → ordinary users get the quiet-204/403 grace posture; no allow-list change |
| Wire method face (all api controllers, server-side src) | **zero new/removed methods, zero new namespaces** (session `fork` gains an optional client-side `onCreated` callback — browser client contract, wire-backward-compatible; terminal shell discovery + workspace default-directory are host-internal) | capabilities / quiet-deny / USER_ALLOWED lists unchanged (`account.watchExpiry` from 0.1.7-rc.2 already covered in 0.2.4) |
| `packages/telemetry/otel` (new package) | Cordis service `ctx.otel` (OTLP event/session-log channels) — **no typert controller, no wire namespace** | none |
| Client boot (`packages/client/modules/src`, the former client-runtime home) | src unchanged | RBAC verdict unchanged (§5) |
| `dsh-client-connection` 0.2.0-rc.2 peers | now only `cordis` + `dsh-scope` (`dsh-session`/`dsh-brand` peers dropped) | devDeps keep the three packages (harmless; other trees may need them) |

Path-verification lesson (recorded for future rounds): the historical
"web-app rows" greps must target `packages/bundle/web-app`; `dsh-web-frontend`
lives at `apps/web`; the client runtime was removed as a package on
2026-08-23 (commit `be531688f3`, folded into `dsh-client-modules`) — a
`packages/client/runtime` diff is silently empty and NOT evidence.

## 3. Changes shipped

**In 0.2.5 (published 2026-09-30)**: `peerDependencies` — all six dsh peers
gain `|| >=0.2.0-rc.2 <0.3.0-0` (node-semver tuple rule: a 0.2.0-rc.x
prerelease satisfies no `>=0.1.x` comparator); devDeps → `^0.2.0-rc.2`
(10 pkgs, fresh reinstall after the recurring incremental-ERESOLVE wedge;
cordis 4.0.4 / schemastery 3.18.4 unchanged). `dist/client.js` re-stamp
byte-identical (37134 chars). Runtime boot smoke-verified on the live web
profile (login wall active; the profile `compatibility.json`
`dsh plugin allow-version` exemption becomes unnecessary once 0.2.5 is
installed — revoke after the profile upgrade).

**In-repo (unpublished, rides the next release)**: `src/remote-guard.ts`
`wrapRemoteGateway` now spreads the live gateway and overrides only
`invoke`/`stream`, forwarding every other member — DSH 0.2.0-rc.2 made
`hasLiveClient()` a required `TypertGateway` member (consumers:
`cordis-host-runner/inspect-registry`, `tool-cordis/api-catalog`), and the
old hand-rolled two-method wrapper went structurally incomplete the moment a
deployment composed it. +2 regression tests (forwarding keeps guarding).
Suite **18 files / 211 tests green**; `verify:imports` exit 0; build exit 0.

## 4. Multi-user support detection at 0.2.0-rc.2

`git grep -ilE 'multi.?user|multiuser|role.?based|\brbac\b' dsh-v0.2.0-rc.2
-- packages/ apps/` → **0 hits**. No user/account/auth package
(`packages/identity` = anonymous telemetry correlation ids; `packages/telemetry`
= OTLP log channels). The `account` namespace still manages the ONE
process-wide upstream DeepSeek Platform grant. **Still NO native multi-user;
dsh-login remains the multi-user layer.**

## 5. Role-based whole-UI permission control at 0.2.0-rc.2

Still **infeasible without upstream changes**: `packages/client/modules/src`
(the boot/activation layer, home of the former client-runtime) and
`packages/client/ui-slots/src` are source-identical to 0.1.7-rc.2, with 0
hits for `isAdmin|isAllowed|role|permission` — every bundle still activates
unconditionally, `renderFactorySlot()` still takes no Session identity, and
the web-app bundle's new `ui-settings-session-log` section ships with no
per-identity visibility hook (same global-section-list limitation). The
available levers remain dsh-login's own surfaces (capability advertisement,
`window.__DSH_SESSION__` baseline, `/api/auth/capabilities`, wire guard).
Upstream asks unchanged: `docs/adapt-dsh-0.1.6.md` §6.
