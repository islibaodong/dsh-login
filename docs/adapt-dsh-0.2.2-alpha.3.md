# Adapting dsh-login to DSH 0.2.2-alpha.3 (→ released as 0.3.10)

> Follow-up to [`docs/adapt-dsh-0.2.2-alpha.2.md`](adapt-dsh-0.2.2-alpha.2.md) (0.3.8). Watch cycle 2026-11-04 (scheduled `0 12 * * *` Asia/Shanghai); released as **0.3.10** (git tag `v0.3.10`). The first *code* adaptation since 0.3.8 — DSH **0.2.2-alpha.3** landed after three quiet watches (10-30 through 11-03 saw no release).

## 1. Version detection

| source | value at detection (2026-11-04 12:00 +08) |
|---|---|
| npm `@deepseek-ai/dsh` dist-tags | `alpha` moved `0.2.2-alpha.2` → **0.2.2-alpha.3** (published 2026-11-03T07:48:26Z); `latest` and `next` unchanged at `0.2.1-rc.5`; registry `time.modified` 2026-11-03T07:48:48Z — first registry activity since the 10-29 rc.5 publish window |
| git tags | `dsh-v0.2.2-alpha.3` → `05b1cae8db` ("release(vendor): cordis 4.0.6-alpha.2, cosmokit 1.8.7-alpha.2, group 1.0.6-alpha.2, hmr 1.0.21-alpha.2, include 1.0.11-alpha.2, loader 1.0.7-alpha.2, logger-console 1.0.6-alpha.2, schemastery 3.18.6-alpha.2, timer 1.1.8-alpha.2"), tagged 2026-11-03 14:19:06 +0800 |
| commits between | `ce7073d512` (0.2.2-alpha.2 tip, last seen 10-30) → tag: **111** |
| npm publish state | all peer packages verified published at `0.2.2-alpha.3` (`@deepseek-ai/dsh`, `dsh-host-webserver`, `dsh-client-connection`, `dsh-client-modules`, `dsh-settings`, `dsh-scope`, `dsh-session`, `dsh-credentials`, `dsh-brand`, `dsh-client-ui-settings`); vendor alphas re-issued on the same release commit: cordis `4.0.6-alpha.2`, schemastery `3.18.6-alpha.2`, include `1.0.11-alpha.2`, loader `1.0.7-alpha.2` |

## 2. Compatibility surface (ce7073d512 → 0.2.2-alpha.3: 111 commits)

The release is a **vendor bump + session-projection internals rework**; the adapter surface is quiet:

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| `packages/api/session-controller` | the only `packages/api` source change (~130 src lines): projection-internal rework — `ApiSessionList` keeps a `ProjectionHandle<SessionListMetadata>` (register returns the handle; `summaryFor` reads `metadata.blank`/`lastPromptAt` from it), `cachedSnapshot` renamed `snapshot`, and **`SessionProjectionUpdate` wire shape changed**: was `{sessionId, key, value, seq}` → now `{sessionId, seq, changes: readonly {key, val}[]}` (one update per committed event) | **`@Remote` method names unchanged** (grep at the tag: `list/search/create/selectModel/…/projections` + stream decorators — identical set) → method-wall classification untouched; the frame *payload* shape change rides inside session-scoped streams dsh-login already gates by session ownership, and `frameVisible` dispatches on frame *types*, not projection payload shapes → compatible unchanged |
| other `packages/api` controllers (`settings`, `terminal`, `workspace`, `workspace-files`) | `package.json` bumps only | no impact |
| `/api` wire registry | **199 → 204 methods (+7 net)**: `forgePanel.changeRequestChecks`, `forgePanel.submitReview`, `schedule.create/deliveryLimits/edit/run/view` added; `schedule.update`/`schedule.delete` **folded into `schedule.edit`** | re-classification, §5 — the 11-02 watch had pre-recorded this dev-tree drift |
| vendor | cordis `4.0.6-alpha.2`, schemastery `3.18.6-alpha.2`, include `1.0.11-alpha.2`, loader `1.0.7-alpha.2` (+cosmokit/group/hmr/logger-console/timer alphas) | devDeps retarget; `9a26b453c3` "accept colon-containing entry ids used by generated bundles" only widens loader tolerance |
| `packages/client/{connection,modules,ui-slots}`, `packages/host/{webserver,frontend-static}` | `package.json` bumps only | `dist/client.js` needs only its banner re-stamp (verified byte-identical rebuild); `__DSH_BOOT__` lever intact (`packages/client/modules/src/index.ts:635` `rows.push({kind:'global', name:'__DSH_BOOT__', value: graph})` — line drift from rc.5's `:592` is tree growth) |
| `packages/schedule/schedule` | `@Remote` surface re-shaped: `create`/`edit`/`run`/`view`/`deliveryLimits` added, `update`/`delete` removed; `edit` applies-or-deletes one task in a single call | classification below |
| `packages/experimental/client-ui-forge` | `changeRequestChecks` (read CI checks of a session-bound change request) and `submitReview` (publish a review to the session's code host) added | classification below |

## 3. Changes shipped (0.3.10)

- **`package.json`** — `version` → `0.3.10`; the eleven `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-alpha.2` → `^0.2.2-alpha.3`; vendor devDeps aligned to the re-issued alphas (cordis `~4.0.6-alpha.2`, schemastery `~3.18.6-alpha.2`, include `~1.0.11-alpha.2`, loader `~1.0.7-alpha.2`). **peerDependencies unchanged** — the existing `>=0.2.2-alpha.2 <0.3.0-0` branches match `0.2.2-alpha.3` via the same-prerelease-tuple rule (no new tuple line, unlike the 0.3.8 retarget).
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-alpha.3'`. **USER_ALLOWED**: − `schedule.delete`/`schedule.update` (retired from the wire), + `schedule.create/deliveryLimits/edit/run/view` and `forgePanel.changeRequestChecks`/`forgePanel.submitReview`. Buckets **124 / 79 / 1** = 204.
- **`tests/fixtures/wire-surface.json`** — re-dumped from a *built* alpha.3 worktree: `dshVersion=0.2.2-alpha.3`, 204 methods.
- **`tests/wire-surface.spec.ts`** — bucket pins 124/79/1; no-checkout branch expects 204.
- **`dist/*`** — rebuilt (`client.js` byte-identical at 37134 chars — banner-only re-stamp; `index.js`/`index.js.map` carry the new buckets).
- **Docs** — this file; README / README.zh banner + status + adaptation history + tracking/evaluation updates; `.claude/rules/changelog.md` entry.

## 4. Verification

| step | result |
|---|---|
| alpha.3 build | detached worktree `E:\code\deepseek-harness-wt-022a3` @ `05b1cae8db`: `pnpm install --frozen-lockfile` (57.1s) + `pnpm run typecheck` (5 gates) **all pass** in 191.20s; 36 typert files generated → dump = 204 methods |
| `npm install` (after retarget) | clean (changed 30 packages in 4s); `npm ls` verified — all `@deepseek-ai/dsh-*` at 0.2.2-alpha.3, cordis 4.0.6-alpha.2, include 1.0.11-alpha.2, loader 1.0.7-alpha.2, schemastery 3.18.6-alpha.2 |
| `vitest run` | **21 files / 269 tests green** against the published alpha.3 builds (incl. the wire-surface disjoint/total/exhaustive checks at 204 and the strict live cross-check 204==204) |
| `npm run build` | exit 0 (`dist/client.js` 37134 chars, byte-identical) |
| `npm run verify:imports` | still fails on node v24.20.0 + tsx 4.23.15 (strip-only parameter-property error, 9 src files) — **pre-existing environment issue**, not a regression; unchanged from the 0.3.9 watches |

As with every release: the per-user isolation guard composed over the native `typertGateway` ([`docs/compose-guard.md`](compose-guard.md)) and the two-browser isolation sign-off remain **deployment-side acceptance steps** (see [`docs/verify-option-A.md`](verify-option-A.md) §B).

## 5. Wire-surface classification of the +7 / −2

| group | methods | bucket | rationale |
|---|---|---|---|
| schedule CRUD split | `schedule.create`, `schedule.edit`, `schedule.run`, `schedule.view`, `schedule.deliveryLimits` (5) | **user** | same trust shape as the already-admitted `schedule.list/catalog/history` reads: the caller's own scheduled-runs surface. `edit` is the single-call replacement for the retired `update`+`delete` pair; `run` triggers one due-now delivery of a task; `view` is a point read; `deliveryLimits` returns the host's `newSessionIntervalSeconds` for the recurrence picker. Caveat unchanged from previous watches: upstream has no per-task ownership model (tasks live on a shared host schedule domain — the pre-existing reads already expose that), so these add no new isolation axis |
| forge review surface | `forgePanel.changeRequestChecks`, `forgePanel.submitReview` (2) | **user** | both are session-scoped — first param `session: Session`, binding resolved via `this.bound(session, url)` exactly like the other 18 `forgePanel.*` methods; `changeRequestChecks` is a read of the change request's CI checks, `submitReview` publishes a review (comment/approve/request-changes) to the change request's code host — the same trust shape as the already-admitted `forgePanel.merge`/`markReady` (the session's agent can already run git/shell/push in that checkout) |
| schedule retirement | `schedule.update`, `schedule.delete` (−2) | **removed** | no longer exist on the wire — folded into `schedule.edit`; dead allow-list entries would fail the exhaustive classification check |

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-alpha.3.** The recurring `multi.?user|multiuser|role.?based|\brbac\b` grep still yields exactly the one standing hit: `packages/api/remote-access/README.md`. dsh-login remains the account/authn layer.
- **Whole-UI role gating is still not natively implementable.** The client still activates every bundle unconditionally through `window.__DSH_BOOT__`; the lever dsh-login's `uiRoleGate` rewrites is untouched (`packages/client/modules/src/index.ts:635`). The alpha.3 session-controller changes are projection-internals only. dsh-login's `uiRoleGate` (since 0.3.0) remains THE answer.

**Conclusion: no new multi-user capability upstream. 0.3.10 is a dependency-retarget + wire re-pinning release (124 user / 79 admin-only / 1 host-internal of 204); the role model is unchanged — dsh-login remains the multi-user layer.**
