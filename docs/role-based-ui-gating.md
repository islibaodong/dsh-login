# Role-based whole-UI gating — evaluation (2026-11-10)

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
