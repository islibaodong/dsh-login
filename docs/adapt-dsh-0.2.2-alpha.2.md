# Adapting dsh-login to DSH 0.2.2-alpha.2 (→ released as 0.3.8)

> Follow-up to [`docs/adapt-dsh-0.2.1-rc.3.md`](adapt-dsh-0.2.1-rc.3.md) (0.3.7). Watch cycle 2026-10-28 (scheduled `0 12 * * *` Asia/Shanghai); released as **0.3.8** (git tag `v0.3.8`). This is the first *code* adaptation since 0.3.6 — two upstream releases landed since the last watch: **0.2.1-rc.4** and **0.2.2-alpha.2**.

## 1. Version detection

| source | value at detection (2026-10-28 12:00 +08) |
|---|---|
| npm `@deepseek-ai/dsh` dist-tags | `next` moved twice since the last watch: `0.2.1-rc.2` → **0.2.1-rc.4** (published 2026-10-26T15:09Z) → **0.2.2-alpha.2** (published 2026-10-27T18:52Z); `alpha` = `0.2.2-alpha.2`; `latest` unchanged at `0.2.1-rc.2` |
| git tags | `dsh-v0.2.1-rc.4` → `504a01a957` (tagged 2026-10-26 16:15 +0800); `dsh-v0.2.2-alpha.2` → `f3803c9697` (release merge PR #7437, tagged 2026-10-28 02:17 +0800) |
| commits between | rc.3 → rc.4: **9**; rc.4 → 0.2.2-alpha.2: **2161** |
| skipped versions | no `0.2.2-alpha.1` exists (neither git tag nor npm) |
| npm publish state | all eleven `@deepseek-ai/dsh-*` plugin-graph packages re-published at both `0.2.1-rc.4` (`next`) and `0.2.2-alpha.2` (`alpha`); vendor `next` dist-tags re-issued on the 0.2.2 line: cordis `4.0.6-alpha.1`, schemastery `3.18.6-alpha.1`, cordis-plugin-include `1.0.11-alpha.1`, cordis-plugin-loader `1.0.7-alpha.1` |
| peer requirements @0.2.2-alpha.2 | verified from published tarballs: cross-package peers pin **exact `0.2.2-alpha.2`**; cordis `~4.0.6-alpha.1`, schemastery `~3.18.6-alpha.1`; `dsh` itself carries no peerDependencies |

rc.4 is a no-op for dsh-login: the 9 commits are four `package.json` version bumps plus UI tooltip, acp-stdout and MCP-diagnostics fixes — zero adapter-surface files. Everything below is about **0.2.2-alpha.2**.

## 2. Compatibility surface (rc.4 → 0.2.2-alpha.2: 176 files, +6221/−521)

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| `packages/host/frontend-static` | **rewritten** by PR #6901 (commit `73931626be`) into a WebResource-API cordis plugin; the `serveStatic` export is **removed** | the gateway's static fallback import broke → new self-hosted [`src/serve-static.ts`](../src/serve-static.ts) (see §3) |
| `packages/host/webserver` | resource routes + in-process `readResource` (same PR); index-inject signature is now `(table: IndexInjection[], peer: PeerScope)`; `renderIndex(html, peer)` composes `collectIndexInjections(peer)` | dsh-login's index-inject listener (`src/index.ts:235`) consumes only the injection table → **compatible unchanged** |
| `/api` wire registry | **146 → 199 methods (+53)** — forge panel (18), liveshare share management (12), session state/observation (6), CUA consent (9), plugin detail/update (4), plus 4 singles | full re-classification, §5 |
| `packages/settings/settings` | 3-line diff: `projectForm(form, plainConfig(entry.fiber.effectiveConfig))` replaces `.config` | internal projection fix — no wire/config-surface change |
| `packages/bundle/web-app` | patch-yml roster changes (removed `tools.mode` env seam + one UI row; added message-quotes / ui-file-drag / deliverable-file-references client rows) | dsh's own bundle, not ours — `cordis.patch.yml` unchanged, and the `web-runtime` row it disables still exists at alpha.2 (grep-verified) |
| `packages/client/modules` (`client/manifest.ts`) | `WireBootGraph`/`parseBootManifest` moved into `client/manifest.ts` (`:27,:93,:223-231`); `index.ts` re-imports | **boot-graph lever intact** — `__DSH_BOOT__` untouched → `uiRoleGate` unaffected |
| new client UI packages (forge panel, liveshare viewer, CUA consent UI) | ride the same boot graph | no permission axis → `ADMIN_ONLY_UI_PLUGINS` unchanged |
| `packages/api/remote-access` | role bindings now exist over the `forgePanel`/`liveshareShares`/`session` resource kinds; per-Peer access snapshots | still authorize-only for **non-owner** peers — see §6 |

## 3. Changes shipped (0.3.8)

The session before this watch (2026-10-27, uncommitted) had already produced a WIP adaptation against the then-unreleased `origin/master`: the `serve-static.ts` fallback, the `gateway.ts` import swap, and a first classification of 16 of the new methods (fixture stamped 162). This watch verified the WIP against the real published alpha.2 (dump: **199 methods**, not 162), completed the remaining 37 classifications, and shipped:

- **`src/serve-static.ts`** (new) — self-hosted node:http `serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex)` replacing the deleted `@deepseek-ai/dsh-host-frontend-static` export. Trust shape preserved: dist-root confinement (path traversal → 403), `ENOENT/EISDIR/ENOTDIR` → 404 (other errors rethrow), index requests go through `authorizeIndex()` + `renderIndex()` so the login wall still gates the SPA. MIME table covers `.html/.js/.css/.png/.svg/.json/.map/.webmanifest/.gz`. The vendored copy stays compatible with rc.3/rc.4 (which still export `serveStatic`) — the fallback is version-agnostic.
- **`src/gateway.ts`** — `import { serveStatic } from './serve-static.ts'` replaces the package import.
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-alpha.2'`; header notes the classification is transcribed from alpha.2's 199-method registry (rc.4 stays at 0.2.1's 146 — a strict subset, so one list serves both lines). **USER_ALLOWED** += `session.{events,observeEvent,observeProjections,observeState,state,wait}` (session-scoped observation), `forgePanel.*` ×18 (session-scoped worktree/change-request panel — first param `sessionId`, resolved and ownership-checked like `terminal.*`; the sign-in probe only reports the session's own checkout), `toolResults.watch` (the session's own tool-result stream), plus the WIP's `actionCards.act` + `pluginRecommendations.describe`. **ADMIN_ONLY_METHODS** += `cuaAccess.*` ×9 (CUA consent + application icons), `pluginManager.listVersions/readBundleDetail/updateBundle`, `pluginMarket.readEntryDetail`, `schedule.deleteInactive`, and the whole `liveshareShares` namespace ×12 (upstream declares it *owner-only*: publishing sessions to external viewers, host relay, owner identity, audit — operator territory in a multi-user deployment; a user-scoped subset would need per-share ownership checks dsh-login doesn't model yet). Buckets **119 / 79 / 1** = 199.
- **`tests/fixtures/wire-surface.json`** — re-dumped from a *built* alpha.2 worktree (`pnpm run typecheck` generates `lib/typert.remote-client.d.ts`; published tarballs don't ship typert files): `dshVersion=0.2.2-alpha.2`, 199 methods.
- **`tests/wire-surface.spec.ts`** — bucket pins 119/79/1; no-checkout branch expects 199; the live-checkout cross-check gained a **generation guard**: strict unclassified/vanished comparison runs only when the live tree's registry size equals the fixture's (the default `../deepseek-harness` dev tree sits at an older generation between watches and must not false-positive).
- **`package.json`** — `version` → `0.3.8`; the eleven `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.1-rc.3` → `^0.2.2-alpha.2`; vendor devDeps aligned to the re-issued alpha vintage (cordis `~4.0.6-alpha.1`, schemastery `~3.18.6-alpha.1`, include `~1.0.11-alpha.1`, loader `~1.0.7-alpha.1`). **peerDependencies extended**: the seven `@deepseek-ai/dsh-*` peers gain an `|| >=0.2.2-alpha.2 <0.3.0-0` branch (semver prerelease tuple rule — the existing `>=0.2.1-alpha.1 <0.3.0-0` branch does not match the `[0,2,2]` tuple); cordis peer gains `|| ~4.0.6-alpha.1`, schemastery peer gains `|| ~3.18.6-alpha.1`.
- **`dist/*`** — rebuilt.
- **Docs** — this file; README / README.zh banner + status + adaptation history + tracking/evaluation updates; `.claude/rules/changelog.md` + `gotchas.md` entries.

## 4. Verification

| step | result |
|---|---|
| alpha.2 build | detached worktree `E:\code\deepseek-harness-wt-022a2` @ `f3803c9697`: `pnpm install` + `pnpm run typecheck` (5 gates) all pass; 36 typert files generated → dump = 199 methods |
| `npm install` (after retarget) | clean (node_modules + lockfile reset first — the old lockfile wedged ERESOLVE against the alpha line); 111 packages, alpha-vintage vendors resolved exactly |
| `vitest run` | **21 files / 267 tests green** against the published alpha.2 builds (incl. the wire-surface disjoint/total/exhaustive checks at 199) |
| `npm run build` | exit 0 (`dist/client.js` 37134 chars) |
| `npm run verify:imports` | all ok (ownership / provision / remote-guard / remote-web-ui-compat / serve-static / session / ui-gate / users / web-runtime / workspace-setting) |

As with every release: the per-user isolation guard composed over the native `typertGateway` ([`docs/compose-guard.md`](compose-guard.md)) and the two-browser isolation sign-off remain **deployment-side acceptance steps** (see [`docs/verify-option-A.md`](verify-option-A.md) §B).

## 5. Wire-surface classification of the +53

| group | methods | bucket | rationale |
|---|---|---|---|
| forge panel | `forgePanel.{branches,cancelWorktree,changeRequestDiff,changeRequestStates,changeRequestText,continueInProject,dismiss,follow,localDiff,localText,markReady,merge,refresh,requestWorktree,restoreWorktree,retryWorktree,stopCreation,track}` (18) | **user** | every method takes `sessionId: SessionId` first — session-scoped, gateway resolves the resource, dsh-login's remote guard ownership-checks it; same trust shape as `terminal.*` (the agent can already run git/shell inside the session's world) |
| session observation | `session.{events,observeEvent,observeProjections,observeState,state,wait}` (6) | **user** | session-scoped reads/streams of the caller's own session |
| tool results | `toolResults.watch` (1) | **user** | session-scoped (`SessionToolResultRequest`) |
| action cards / recommendations | `actionCards.act`, `pluginRecommendations.describe` (2) | **user** | act on the session's own cards; read-only describe |
| CUA consent | `cuaAccess.{applicationIcons,applications,enablePersistentPtc,openSettings,ptcConfiguration,requestPermission,retryApproval,revoke,systemStatus}` (9) | **admin** | computer-use consent + host application inventory — host-side execution territory |
| plugin detail/update | `pluginManager.{listVersions,readBundleDetail,updateBundle}`, `pluginMarket.readEntryDetail` (4) | **admin** | extends the existing plugin-management wall |
| schedule | `schedule.deleteInactive` (1) | **admin** | destructive across schedules |
| liveshare share management | `liveshareShares.{audit,capabilities,create,identity,list,relay,setCapabilities,setRelay,stop,testPublish,testRelay,updatePermissions}` (12) | **admin** | upstream's own header: *"Owner-only Remote surface over the share-management operations"* — external-viewer publishing, host relay wiring, owner identity, audit trails; operator territory |

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-alpha.2.** The recurring `multi.?user|multiuser|role.?based|\brbac\b` grep still yields exactly the one standing hit: `packages/api/remote-access/README.md` — through 2161 commits of backlog, the surface still has no account store, no login, no identity UI. dsh-login remains the account/authn layer.
- **The remote-access substrate grew, but on the same axis.** At alpha.2 it carries role bindings over the new `forgePanel`/`liveshareShares`/`session` resource kinds and per-Peer access snapshots — yet it still only ever gates **non-owner** peers (owner principals are unconditionally allowed). dsh-login users arrive as **owner** principals (browser cookie casts `browserPeer {kind:'owner'}`), so none of it intercepts them; dsh-login's own login wall, `USER_ALLOWED` bridge wall, remote guard and `uiRoleGate` remain the real multi-user boundary.
- **Whole-UI role gating is still not natively implementable.** The client still activates every bundle unconditionally; the new UI packages (forge panel, liveshare viewer, CUA consent) mount through the same boot graph with no permission axis. dsh-login's `uiRoleGate` (since 0.3.0) remains THE answer, and the `__DSH_BOOT__` lever it uses is untouched at alpha.2 (the graph types moved to `client/manifest.ts` — the filter is shape-agnostic and needed no change).

**Conclusion: no new multi-user capability upstream. 0.3.8 is a real adaptation release (static-serving seam + wire re-classification + dependency retarget), but the role model is unchanged — dsh-login remains the multi-user layer.**
