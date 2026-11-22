# Role-based whole-UI gating — evaluation (2026-11-10, re-verified 2026-11-11, 2026-11-14, 2026-11-15, 2026-11-16, 2026-11-19, 2026-11-20, 2026-11-21 and 2026-11-22)

**Status: evaluated, not implemented.** Upstream DSH still exposes no per-role UI
control (no native accounts, no identity UI, no role model), and dsh-login's
gate is binary: **admin** vs **ordinary user**.

## 1. What ships today (verified at dsh-login 0.3.12 / DSH 0.2.2-rc.1)

| Layer | Module | Model |
|-------|--------|-------|
| Page / whole UI | `src/ui-gate.ts` (`applyUiGate` → `filterBootGraph`) | `ADMIN_ONLY_UI_PLUGINS` deny-list applied to `window.__DSH_BOOT__` entries + batches |
| Wire / `/api` | `src/api-filter.ts` (`classifyWireMethod`) | `USER_ALLOWED` (124 of 204) / `ADMIN_ONLY_METHODS` (79) / host-internal |
| Two-segment domains | `src/capabilities.ts` (`ADMIN_ONLY_TWO_SEGMENT_DOMAINS`) | admin-only deny-list |
| Identity | `src/users.ts` (`isAdmin: boolean`), `src/session.ts` | boolean, no role field |
| Discovery | `src/capabilities.ts` (`deriveCapabilities`) | per-identity methods/domains/uiPlugins, echoed by `GET /api/auth/capabilities` |

Enforcement seams: the `/api` bridge wall (`apiBridgeAuth`), the dispatch-seam
guard (`dispatch-guard.ts` — `dispatchRpc`/`openWireStream`, issue #11), and the
page gate (`uiRoleGate`). All three resolve identity to `isAdmin`.

The boot-graph half is already a **pure per-entry JSON transform**: `entries`
rows are kept or dropped by id, batches are re-emitted with the surviving ids,
empty batches disappear, and every unexpected shape fails open (serving the
original HTML). Nothing about it is hard-wired to two roles — only the
`DENIED_IDS` set is a constant.

## 2. What "整个 UI 按角色权限控制" would require

1. **Role storage** — `users.ts` record gains `role: string` (the JSON store is
   `${password}_USERS`); `isAdmin` becomes `role === 'admin'`, kept as a derived
   accessor so every existing seam keeps working during migration; the first
   user is forced admin exactly as today.
2. **Role → UI plugin policy** — `DENIED_IDS` becomes a per-role resolver
   (`uiPolicyFor(role)`), and `applyUiGate(html, role)` selects it. The filter
   itself needs no change (per-entry, per-batch, fail-open).
3. **Role → wire policy** — `classifyWireMethod` already returns one of three
   buckets; a role policy adds a bucket per role (`USER_ALLOWED` subsets) and
   `deriveCapabilities(role)` derives the advertised surface from the same
   policy, so UI and API cannot disagree.
4. **Admin surface** — the settings panel needs a role editor (assign a role per
   user) and `GET /api/auth/capabilities` should echo `role` next to `isAdmin`.
5. **Single policy source** — the three seams must consume one module
   (`rolePolicy.ts`), otherwise a role added at the page gate but not at the
   dispatch seam produces "UI hidden, API open" drift (the exact failure class
   issue #11 fixed in the other direction).

## 3. Feasibility verdict

**Feasible without any upstream change.** The three hard parts already exist:
a per-request boot-graph rewrite, a bucketed wire classifier, and a JSON user
store. Adding a role field and a policy resolver is additive work in
`users.ts` + `ui-gate.ts` + `capabilities.ts` + `api-filter.ts` + the settings
panel bundle, plus tests. Rough effort: **1–2 days**, dominated by tests and the
settings-panel UI rather than by the gate itself.

**Bounds that do not go away:**

- *Per-package granularity only* — hiding one slot/section inside an allowed
  bundle still needs dsh-login's own client half to wrap the slot registry.
- *Presentation-only* — the `/api` allow-list stays the security boundary; a
  role that hides a plugin from the page does not remove the method from a
  hand-crafted call.
- *Dev-mode HMR bypass* — a `pnpm run dev:web` rebuild re-syncs the full roster.
- *Upstream RBAC is not a substitute* — `packages/api/remote-access` authorizes
  **non-owner** peers only; every dsh-login user arrives as an owner principal,
  so its role engine never applies to them.

## 4. Recommendation

Do not implement on speculation: the two-role split already covers the
login-gateway use case, and the `feat/harden-workspace-mutations` branch is
explicitly paused waiting for upstream per-role UI control. Revisit when either
(a) upstream ships a role/principal model that gives dsh-login users a
non-owner identity, or (b) a deployment needs more than admin/ordinary (e.g.
per-team plugin visibility). At that point the change is the five items in §2,
with `rolePolicy.ts` as the one source of truth for all three seams.

Status of (a) as of 2026-11-18, re-checked 2026-11-19: upstream has implemented
an unreleased Peer-based authentication Provider registry
(`connection.authentication`) that lets a plugin supply its own
Peer/principal — the *mechanism* for a non-owner identity now exists in the
backlog, but no role or authorization model sits on top of it, and the seam is
still absent at `dsh-v0.2.2-rc.5`, so (a) is still open (§5, 11-18 and 11-19
entries).

## 5. Re-verification log

**2026-11-11 (scheduled watch)** — re-checked against upstream master tip
`fcc0ad4621` (still 811 commits past the newest tag `dsh-v0.2.2-rc.1`; still no
`dsh-v0.2.2` stable tag, no new release on npm):

| Claim in §2 | Re-verified evidence at the master tip |
|---|---|
| Page gate is a per-request transform | `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`; the graph row `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` at `packages/client/modules/src/index.ts:635`; `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139` |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' origin/master -- packages apps` = 1 hit, `packages/api/remote-access/README.md:2`; that engine "never checks" the owner principal, and every dsh-login user is an owner |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.12: 124 / 79 / 1 of 204 (`src/api-filter.ts`) |
| No upstream RFC pending | upstream repo public, 0 open issues, `pushed_at` 2026-11-04T13:06:39Z; issue search for multi-user / rbac / login+accounts = 0 hits |

One new observation: upstream now renders index pages **per Peer**
(`snapshotFor(peer.principal)`, so a liveshare viewer page opens with that
viewer's grants). That makes the page-render seam peer-aware, which is the shape
a future role model would ride — but dsh-login identities are owner principals,
so it carries no role for them today. Verdict and effort estimate in §3/§4
stand; do not implement until (a) or (b) in §4 fires.

**2026-11-14 (scheduled watch, DSH 0.2.2-rc.3 → dsh-login 0.3.14)** — re-checked
at the rc.3 tag `38a6a5c965`:

| Claim in §2 | Re-verified evidence at the rc.3 tag |
|---|---|
| Page gate is a per-request transform | `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`; the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`; `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139` — **all three at the same lines as 11-11** |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' dsh-v0.2.2-rc.3 -- packages apps` = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline); no account store exists upstream |
| Wire classifier is bucketed | now 140 / 85 / 1 of 226 at dsh-login 0.3.14 (`src/api-filter.ts`) — the +1 (`deepseekChatImport.limits`) is owner-only upstream and lands in USER because every dsh-login user is an owner principal |

New radar item that touches this evaluation: the unreleased master backlog
(`rc.3..origin/master`) contains an in-progress **authentication-provider seam
in the gateway** (`packages/api/gateway` stream-server/client rewrites plus a
new `tests/authentication-provider.host.spec.ts`). If a future release ships a
non-owner principal model on that seam, condition (a)/(b) in §4 could fire with
an upstream-provided principal instead of a dsh-login-declared one — re-read
§3/§4 when the next DSH release carries it. Verdict and effort estimate
unchanged today.

**2026-11-15 (scheduled watch)** — no new DSH release (npm `next` still
0.2.2-rc.3; newest tag still `dsh-v0.2.2-rc.3`; origin/master tip still
`39163dd30f` — byte-identical to the 11-14 state, so the 11-14 table's evidence
carries over; re-confirmed by grep anyway):

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`; the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`; `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139` — re-grepped at the `dsh-v0.2.2-rc.3` tag, same lines as 11-14 |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' 39163dd30f -- packages apps` = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline); backlog past rc.3 still 608 commits, tip unchanged |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.14: 140 / 85 / 1 of 226 (`src/api-filter.ts`); drift radar at the rc.3 checkout = 226 == 226, added [] removed [] |

Verdict and effort estimate in §3/§4 unchanged; the gateway auth-provider radar
(11-14) still stands — tip unchanged, nothing new to re-read.

**2026-11-15 (scheduled watch)** — re-checked after the 11-14 rc.3 adaptation
(dsh-login 0.3.14): **zero upstream movement since the 11-14 watch** —
origin/master tip still `39163dd30f` (2026-11-13 15:37 +0800), backlog still
608 commits past `dsh-v0.2.2-rc.3`, no new tag, every npm peer `next` still
0.2.2-rc.3, `@islibaodong/dsh-login` `latest` still 0.3.14.

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | all three levers confirmed at the same lines as 11-14: `renderIndex(html, peer)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', …)` at `packages/api/remote-access/src/index.ts:139` |
| No upstream role model to reuse | grep at BOTH `origin/master` tip and the rc.3 tag = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline) |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.14: 140 / 85 / 1 of 226 (`src/api-filter.ts`) |

Nothing new to act on. The gateway auth-provider WIP is unchanged (same tip,
no new commits), so §4's condition (a)/(b) has not fired. Verdict and effort
estimate unchanged.

**2026-11-16 (scheduled watch)** — no new DSH release (newest tag still
`dsh-v0.2.2-rc.3`; origin/master tip still `39163dd30f` — zero upstream movement
since the 11-14 watch; every npm peer `next` still 0.2.2-rc.3;
`@islibaodong/dsh-login` `latest` still 0.3.14):

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.3 tag all three levers sit at the same lines as 11-14: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', …)` at `packages/api/remote-access/src/index.ts:139`. NEW tip-level look at `39163dd30f`: the `renderIndex` implementation has moved to `packages/host/webserver/src/index.ts:867` and the inject logic now lives in `packages/host/webserver/src/injections.ts` (`renderIndexInjections`) — unreleased-backlog refactor only, signature and per-request transform shape unchanged, lever intact |
| No upstream role model to reuse | recurring grep at BOTH the master tip and the rc.3 tag = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline) |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.14: 140 / 85 / 1 of 226 (`src/api-filter.ts`); drift radar at the rc.3 checkout = 226 == 226, added [] removed [] |

Nothing new to act on: the gateway auth-provider WIP is unchanged (same tip),
so §4's condition (a)/(b) has not fired. Verdict and effort estimate unchanged.


**2026-11-17 (scheduled watch)** — no new DSH release (newest tag still
`dsh-v0.2.2-rc.3` → `38a6a5c965`; origin/master tip still `39163dd30f`, backlog
still 608 commits; every npm peer `next` still 0.2.2-rc.3;
`@islibaodong/dsh-login` `latest` now 0.3.15). dsh-login 0.3.15 (the 用户管理
main-sidebar rework) is current, released 2026-11-17.

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.3 tag all three levers sit at the same lines as 11-14: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', …)` at `packages/api/remote-access/src/index.ts:139`. Tip-level look at `39163dd30f` still shows the unreleased refactor: `renderIndex` at `packages/host/webserver/src/index.ts:867`, inject logic in `packages/host/webserver/src/injections.ts` (`renderIndexInjections`) — signature/shape unchanged, lever intact |
| No upstream role model to reuse | recurring grep at BOTH the master tip `39163dd30f` and the `dsh-v0.2.2-rc.3` tag = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline) |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.15: 140 / 85 / 1 of 226 (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); drift radar at the rc.3 checkout = 226 == 226, added [] removed [] |

Nothing new to act on: the tip is byte-identical to 11-14/15/16, so the gateway
auth-provider WIP has not moved and §4's condition (a)/(b) has not fired.
Verdict and effort estimate (≈1–2 days) unchanged.

**2026-11-18 (scheduled watch, DSH 0.2.2-rc.4 → dsh-login 0.3.17)** — new release
`dsh-v0.2.2-rc.4` → `3f321d32bf`; origin/master tip moved `39163dd30f` →
`ca33fd6843` (backlog 608 → **1407** commits). dsh-login 0.3.17 is the re-pin onto
rc.4 (226 → 226, buckets 140 / 85 / 1 unchanged — see
[`docs/adapt-dsh-0.2.2-rc.4.md`](adapt-dsh-0.2.2-rc.4.md)).

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.4 tag all three levers sit at the same lines as 11-14: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139`. Tip `ca33fd6843`: `renderIndex` at `packages/host/webserver/src/index.ts:867`, inject logic in `packages/host/webserver/src/injections.ts` — same unreleased refactor, signature/transform shape unchanged, lever intact |
| No upstream role model to reuse | recurring grep at the `dsh-v0.2.2-rc.4` tag AND the new tip `ca33fd6843` = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline). No account store, no role field, no permission matrix |
| Wire classifier is bucketed | at dsh-login 0.3.17: 140 / 85 / 1 of 226 (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); drift radar at the checkout = 226 == 226, added [] removed [] (the rc.3→rc.4 range touches no remote-decorated source) |

**The 11-14 "gateway auth-provider WIP" radar has graduated**: it is now an
*implemented, unreleased* architecture — Peer-based authentication Providers.
`ConnectionAuthentication` sits at `packages/client/connection/src/authentication.ts:14`
as service `connection.authentication`, injected at
`packages/client/connection/src/index.ts:129` and consumed at
`packages/client/connection/src/rpc-host.ts:80`; the rationale note is
`.agents/notes/implemented/architecture/2026-11-07-browser-authentication-providers.md`
(+ `.zh.md` / `.i18n.yaml`), covered by
`packages/api/gateway/tests/authentication-provider.host.spec.ts`. An
`AuthenticationProvider` synchronously returns an **existing live Peer** or
`undefined`; Providers are tried in registration order; the **Host fixes
`peer.principal` at Peer creation**, and the note is explicit that the
**Remote product itself is not implemented** (no role model, no invitation UI).
None of it exists at rc.4 (greps for `connection.authentication` at the tag
return nothing).

Why this matters here, and why §4's condition (a) still has not fired:

- It gives a plugin a way to mint its **own** Peer/principal instead of arriving
  as the default owner Token Peer — the mechanical half of condition (a). What
  it does **not** give is any role/authorization model above the Peer: no
  admin/ordinary split, no per-package visibility rule. So the five items in §2
  are unchanged, and the role store stays dsh-login's.
- It is a **compatibility** item first: when that seam ships, all five
  `webserver/*` events become instance-scoped (the `webServer` service is the
  dispatch subject; `global: true` is the opt-out), and route registration gains
  explicit `anonymous` / `required` / `deny` policy with omission meaning
  `required`. The `webserver/index-inject` listener this plugin mounts is an
  ordinary listener, so it would be filtered by server instance rather than
  broadcasting from the Cordis root — exactly the kind of change that silently
  narrows a UI gate. Re-check it in the first release that carries the seam.

Nothing new to act on today: verdict and effort estimate (≈1–2 days) stand; the
next watch should read the authentication note's integration counterpart
(`2026-11-07-browser-authentication-development.md`) before deciding whether a
Provider-based identity is worth adopting over the current login wall.

**2026-11-19 (scheduled watch, DSH 0.2.2-rc.5 → dsh-login 0.3.18)** — new release
`dsh-v0.2.2-rc.5` → `9c2670d3bc`; origin/master tip moved `ca33fd6843` →
`2e39e70496` (backlog 1407 → **1640** commits). dsh-login 0.3.18 is the re-pin
onto rc.5 (226 → 226, buckets 140 / 85 / 1 unchanged — see
[`docs/adapt-dsh-0.2.2-rc.5.md`](adapt-dsh-0.2.2-rc.5.md)).

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.5 tag all three levers sit at the same lines as 11-18: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139`. The `rc.5..origin/master` backlog (1640 commits) is where the instance-scoping refactor lives; **none of it is in the release** |
| No upstream role model to reuse | recurring grep at the `dsh-v0.2.2-rc.5` tag = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline). No account store, no role field, no permission matrix. `git grep connection.authentication` at the tag returns **nothing** (exit 1) — the auth-Provider registry is still unreleased |
| Wire classifier is bucketed | at dsh-login 0.3.18: 140 / 85 / 1 of 226 (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); drift radar at the checkout = 226 == 226, added [] removed [] (the rc.4→rc.5 range's one behaviour change — route-aware web-search provider selection — touches no remote-decorated source) |

Condition (a) has not fired: the mechanism is still backlog-only, and no role
model sits above the Peer. Verdict and effort estimate (≈1–2 days) unchanged.
The compatibility item from the 11-18 entry — `webserver/index-inject` becoming
instance-scoped — also has **not** shipped; re-check it in the first release
whose tag contains `connection.authentication`. Live evidence that the current
three-lever design still enforces under rc.5 is in the adaptation doc (§4:
owner 225 / user 140, alice 403 on the admin route).

**2026-11-20 (scheduled watch)** — **zero upstream movement since 11-19**: newest tag still
`dsh-v0.2.2-rc.5` → `9c2670d3bc`, origin/master tip still `2e39e70496`, backlog still
1640 commits past rc.5; npm `latest`/`next` both 0.2.2-rc.5 (`latest` promoted from rc.1, a
dist-tag move only). dsh-login 0.3.18 stays current.

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.5 tag all three levers sit at the same lines as 11-19: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139`; the instance-scoping refactor in `injections.ts` is still backlog-only |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' 9c2670d3bc -- packages apps` = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline); `git grep connection.authentication` at the tag returns nothing — no auth-Provider seam, no account store, no role field |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.18: 140 / 85 / 1 of 226 (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); no upstream commits since 11-19, so the 226 == 226 radar stands |

Verdict (feasible) and effort estimate (≈1–2 days) unchanged; §4 condition (a) still has not
fired, and the `webserver/index-inject` instance-scoping compatibility item has not shipped.

**2026-11-21 (scheduled watch)** — **zero upstream movement since 11-20**: newest tag still
`dsh-v0.2.2-rc.5` → `9c2670d3bc`, origin/master tip still `2e39e70496`, backlog still
1640 commits past rc.5; npm `latest`/`next` both 0.2.2-rc.5; GitHub's newest release is still
`dsh-v0.2.2-rc.5`. dsh-login 0.3.18 stays current.

| Claim in §2 | Re-verified evidence |
|---|---|
| Page gate is a per-request transform | at the rc.5 tag all three levers sit at the same lines as 11-20: `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`, the `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` row at `packages/client/modules/src/index.ts:635`, `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139`; the master-tip refactor (`renderIndex` at `packages/host/webserver/src/index.ts:867`, inject rows in `packages/host/webserver/src/injections.ts`) is still unreleased |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' dsh-v0.2.2-rc.5 -- packages apps` = exactly 1 hit, `packages/api/remote-access/README.md:2` (the standing baseline); `git grep connection.authentication` at the tag returns nothing — no auth-Provider seam in the release, no account store, no role field |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.18: 140 / 85 / 1 of 226 (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); live `enumerateWireSurface` = 226 == 226, added [] removed [] (zero upstream commits since 11-18) |

Verdict (feasible) and effort estimate (≈1–2 days) unchanged; §4 condition (a) still has not
fired, and the `webserver/index-inject` instance-scoping compatibility item has not shipped.
Live evidence that the current three-lever design still enforces under rc.5: `/` 302, `/login` 200,
anonymous capabilities 401 on the running GUI (source-link install of 0.3.18).

### 2026-11-22 — re-checked at DSH **0.2.3-alpha.1**

New release: `dsh-v0.2.3-alpha.1` (`d98f5d6851`); dsh-login 0.3.19. The admission architecture
changed (see [`docs/adapt-dsh-0.2.3-alpha.1.md`](adapt-dsh-0.2.3-alpha.1.md) §2–§3), but the
whole-UI gating seams are the same shape:

| Claim in §2 | Re-verified evidence at the alpha.1 tag |
|---|---|
| Page gate is a per-request transform | `renderIndex(html, peer: PeerScope)` still per request (`packages/host/webserver/src/index.ts`); `webserver/index-inject` now emits `(table, peer)` and the table row is still the mutable `__DSH_BOOT__` splice point (`packages/client/modules/src/index.ts:604-639`); `graphFor(peer.principal)` at `client/modules/src/index.ts:720-722` |
| Filtering must be consistent | `packages/client/modules/src/manifest.ts:101-113` still requires every `WebBootEntry` to belong to exactly one `WebBootBatch`; trimming `entries` without matching `batches` still breaks activation |
| HMR re-send survives only one seam | `packages/client/hmr/src/plugin-events.ts:77,97` re-sends `graphFor(follower.principal)`, so an `index-inject`-only splice would be undone on the next rebuild — wrapping `clientModules.graphFor` remains required |
| `webserver/authorize` cannot gate roles | the bail event sees `WebAuthRequest` (headers/method/url/transport) and a policy string, **not** a resolved principal; it can allow/deny traffic, not choose a role's UI |
| No upstream role model to reuse | `PrincipalMap` still declares only `owner` (`packages/typert/protocol/src/types.ts:455`); the new `connection.authentication` registry landed, so a plugin *can* mint Peers with its own principal kind — but every business package must then register a policy for that kind through `remoteAccess.registerPolicy(kind, policy)`, and `/api` exact routes stay owner-only |
| Wire classifier is bucketed | 146 / 117 / 1 of **264** (`src/api-filter.ts`, pinned by `tests/wire-surface.spec.ts`); fixture dumped from the tag worktree, `dshVersion 0.2.3-alpha.1` |

Verdict (feasible, ≈1–2 days) and §4 condition (a) unchanged: implementation still means one shared
role policy feeding the boot-graph filter, the `graphFor` wrapper and the wire allow-list. The
provider registry makes a *custom* non-owner principal kind technically possible for the first time,
but it does not give the browser a role: dsh-login users remain owner Peers, and package-level
filtering stays enforcement-by-omission (bundles are served anonymously).

