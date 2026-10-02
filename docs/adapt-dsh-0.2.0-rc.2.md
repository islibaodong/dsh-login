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

**Superseded in part by §6 (2026-10-02):** upstream still ships no *native*
per-identity filter — but a whole-UI role gate **is** implementable inside
dsh-login itself, because dsh-login owns the index render and the client
module graph (`window.__DSH_BOOT__`) lives in that HTML. See §6.

## 6. 2026-10-02 re-check — no new upstream release; whole-UI role gating found feasible in-plugin

### 6.1 Version re-check (2026-10-02 12:15 local)

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh` dist-tags | `latest` = `next` = **`0.2.0-rc.2`** (`alpha` stays `0.1.7-alpha.2`) |
| GitHub tags | newest = **`dsh-v0.2.0-rc.2`** (all releases are prereleases, so `/releases/latest` 404s — read tags, not that endpoint) |
| Harness checkout `origin/master` | `639ed01539` == tag `dsh-v0.2.0-rc.2` (0 commits ahead; worktree clean apart from untracked agent-skill dirs) |

**No new DSH release since 0.2.0-rc.2 → no compatibility adaptation was
required.** dsh-login `0.2.6` (published 2026-10-02T04:04Z) remains current for
the newest runtime.

### 6.2 Re-verification on the current tree

- Suite **18 files / 216 tests green** against the published 0.2.0-rc.2 builds;
  `npm run verify:imports` exit 0; `npm run build` exit 0 with the
  `dist/client.js` re-stamp **byte-identical** (37134 chars — `git status`
  clean immediately after the build).
- **Local run is on 0.2.0-rc.2**: the `~/.dsh/profiles/web` store carries
  `dsh-base` / `dsh-web-app` / `dsh-client-connection` / `dsh-host-webserver` /
  `dsh-credentials` / `dsh-web-frontend` / `dsh-host-frontend-static` all at
  **`0.2.0-rc.2`**, with `@islibaodong/dsh-login@0.2.6` installed from the
  github channel. (`dsh-client-runtime` is absent from the store — the
  fold-into-`dsh-client-modules` of 2026-08-23 is real; never diff that path.)

### 6.3 Multi-user detection (re-run)

`multi.?user|multiuser|role.?based|\brbac\b` → **0 hits** across `packages/`
and `apps/`. Two near-miss leads resolved as NOT multi-user:

- **`@deepseek-ai/dsh-authorization`** (new-looking name; real path
  `packages/credentials/authorization`, a *nested* workspace — `packages/*/*`)
  is a **credential-acquisition seam**: "plugin-owned flows that obtain a
  credential through a conversation with the human" (device/OAuth-style
  flows). Not account RBAC.
- `packages/identity` remains anonymous telemetry correlation ids.

**Verdict unchanged: still NO native multi-user; dsh-login remains the
multi-user layer.**

### 6.4 Role surface (re-run) — no native per-identity filter

- `packages/client/modules/src` and `packages/client/ui-slots/src`: **0 hits**
  for `isAdmin|isAllowed|role|permission`.
- Careful reading of `role`: `packages/client` has ~250 `role` hits and **every
  one is a DOM `role="…"` accessibility attribute** (`role="dialog"`,
  `role="treeitem"`, ARIA lists in `base.css`) — a false-positive trap for
  future greps.
- `SlotEntryDef` (ui-slots `index.ts:116`) carries **no** visibility /
  condition / permission field, and `SlotScope` is
  `'root' | 'session-maybe' | 'session'` — **session**-bound, not
  **identity**-bound.

### 6.5 NEW — whole-UI role gating IS implementable inside dsh-login

Mechanism **verified in source** (not yet implemented, not boot-verified):

1. **dsh-login renders the index itself.** The gateway's `indexRenderer` calls
   `webServer.renderIndex(html)` (`src/gateway.ts`), and its own comment records
   that `renderIndex` is what emits the module-loader queue facade, the batch
   preloads and **`window.__DSH_BOOT__`**. Upstream confirms the producer:
   `bootInjections(graph)` (`packages/client/modules/src/index.ts:552`) returns
   `{ kind: 'global', name: '__DSH_BOOT__', value: graph }`, and the web-app
   bundle's `cordis.patch.yml` comment says the modules row's node half
   "composes `window.__DSH_BOOT__`". So the **full client module roster passes
   through HTML that dsh-login already holds as a string, per request.**
2. **The page activates exactly that roster.** `ClientEntries.reconcile()`
   (`packages/client/modules/src/client/entries.ts`) walks `manifest.modules`
   creating one Loader entry per row, and **removes** any managed entry whose id
   is absent from `manifest.plugins`.
3. ⇒ **Filtering the graph before serving the index gates which bundles ever
   activate** — per user, per role, with no upstream change. The role data
   already exists: `deriveCapabilities(user)` in `src/capabilities.ts`.

Constraints to honour if this is built:

- Keep the **bootstrap** batch and the `dsh-client-modules` bootstrap entry, or
  the shell fails with "bootstrap facade is missing".
- Keep the graph shape valid: `parseBootManifest` requires string `id/url/rev`
  and throws on duplicate batch URLs.
- Granularity is **per package**: a bundle activates or not. Hiding one
  slot/section *inside* an allowed package is NOT possible this way (that needs
  dsh-login's own client half to wrap the slot registry; it already runs
  `immediately: true`).
- **Presentation only** — the security boundary stays the `/api` bridge
  allow-list (`apiBridgeAuth` + `USER_ALLOWED`) and the remote isolation guard.
- **Dev-mode caveat**: `client-hmr` is "always mounted … idle until a rebuild
  watcher (`pnpm run dev:web`) actually rewrites client bundles", so production
  never re-pushes the graph — but under the dev watcher a `{type:'graph'}`
  frame re-syncs the full roster and would re-add filtered modules. A robust
  gate must also cover that runtime graph channel.

### 6.6 Repo-memory correction (recorded, partially applied)

`.claude/rules/architecture.md`, `modules.md` and `gotchas.md` still describe
the **pre-option-A `/api` takeover**: `src/connection.ts`,
`src/connection.client.ts`, a `/api` prefix route + WS upgrades, "the shipped
`connection` row stays disabled", and `dsh-host-apiproxy`. Those source files do
not exist, those specs are deleted, and `cordis.patch.yml` keeps the
`connection` row **ENABLED** (only `web-runtime` is disabled). Corrected in
place 2026-10-02 where load-bearing; `modules.md` still needs a fuller
re-analysis (it omits `remote-guard.ts`, `api-bridge-auth.ts`, `capabilities.ts`,
`provision.ts`, `hosts.ts`, `boolean-setting.ts`, `workspace-setting.ts`,
`remote-web-ui-compat.ts`). `docs/PROJECT-INDEX.md` is likewise stale (v0.1.0,
single-password era, 2026-08-17).
