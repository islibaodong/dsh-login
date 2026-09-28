# DSH 0.1.7-rc.2 compatibility check (2026-09-28)

Status: **adapted and verified, no release required** — the published
`@islibaodong/dsh-login@0.2.4` already runs on DSH `0.1.7-rc.2` (its peer
ranges admit rc.2 under the node-semver tuple rule, and rc.1's boot-time
compatibility admission passes unchanged), so 0.2.4 stays the current
release. This repo's devDeps were pinned to `^0.1.7-rc.2` and the full
suite verified against the real rc.2 builds: **18 files / 209 tests green**,
`verify:imports` exit 0, `npm run build` exit 0 (`dist/client.js` re-stamp
**byte-identical** at 37134 chars — the connection client did not change).
In-repo (unpublished): admin capability advertisement + quiet-deny gained
`account.watchExpiry` (advertisement-accuracy discipline; §3).
Previous adaptation: `docs/adapt-dsh-0.1.7-rc.1.md`.

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new **`0.1.7-rc.2`** (2026-09-24T14:01–14:19Z) under the **`next`** dist-tag (`alpha` stays at `0.1.7-alpha.2`; `latest` still stale at `0.0.1-rc.1`). Verified on all seven integrated packages (`dsh-host-webserver`, `dsh-client-connection`, `dsh-credentials`, `dsh-host-frontend-static`, `dsh-settings`, `dsh-web-frontend`, `dsh-web-app`) + `dsh-invariants`. |
| Harness checkout (`E:/code/deepseek-harness`) | tag `dsh-v0.1.7-rc.2` (release commit `787b746b80`); **346 commits** since `dsh-v0.1.7-rc.1`; `origin/master` advanced past the tag (post-release pwsh tail-grace fix, PR #5282). |

## 2. Compatibility surface (346 commits, diffed against `dsh-v0.1.7-rc.1`)

The change mass is the account/Platform credential lifecycle (bonus notices,
expiry handling, desktop onboarding) plus i18n translations. Everything the
plugin integrates with is **source-unchanged**:

| Integration point | rc.2 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver`, `dsh-host-frontend-static`, `dsh-settings`, `dsh-credentials` (core), `packages/api/gateway`, `packages/client/connection`, `packages/client/runtime`, `packages/client/ui-slots`, web-app rows | **source unchanged** (README.i18n.yaml translations + package.json version lines only) | **none** — `cordis.patch.yml` (`web-runtime` disable) applies as-is; the gateway fallback seat, `authorizeIndex` handshake, api-bridge-auth `connection/request` wall, and the runtime/ui-slots seam are untouched |
| `packages/api/workspace-controller` | **`workspace.initializeDefault` signature changed**: rc.1 took `{directoryName, title}`; rc.2 takes no request (host derives both). | **none** — the method was never in `USER_ALLOWED` (first-use/host-side operation; ordinary users were already denied it, admins pass), so the arg-shape change cannot affect the guard or the allow-list |
| `packages/api/session-controller` | two new `RemoteErrorDetailsMap` codes (`session/provider-credentials-unavailable`, `session/provider-models-unavailable`); no new wire methods | **none** — the guard never inspects error details |
| `packages/api/account-controller` | **+1 wire method `account.watchExpiry`** (`@Remote({mode:'stream'})` — credential-expiry notice stream, commit `8f180cf45f`); namespace unchanged (`account`) | **advertisement only** (§3) — the whole namespace stays admin-only (`remote-guard` `ADMIN_ONLY_NAMESPACES` + two-segment deny list + absent from `USER_ALLOWED`), so `watchExpiry` is denied for ordinary users by construction |
| `packages/api/remotes` (`src/client/index.ts`, `remote-events.ts`) | client-half stream work | **none** — shipped inside DSH's own web-frontend bundle, not this plugin's `dist/client.js` |
| `packages/credentials/deepseek-account-platform`, `deepseek-account` | provider-auth isolation, bonus notices, expiry handling (host-side) | **none** — host-internal; reinforces the single process-wide Platform grant (one-operator model) |

Dependency checks: rc.2 still vendors cordis 4.0.4 / schemastery 3.18.4
(devDeps unchanged beyond the dsh packages); `dsh-client-connection` rc.2
peers (`dsh-scope`/`dsh-session`/`dsh-brand`) were already exact-pinned
devDeps. npm install hit the known incremental-resolution ERESOLVE wedge →
fresh reinstall (node_modules + lockfile deleted) per the 2026-09-23
runbook, exit 0 (esbuild install-scripts warning again — harmless).

## 3. Changes shipped in-repo (NOT published; 0.2.4 remains current)

- devDeps → `^0.1.7-rc.2` (10 `@deepseek-ai/dsh-*` packages), lockfile
  regenerated; node_modules verified at real `0.1.7-rc.2` builds
  (cordis 4.0.4 / schemastery 3.18.4 unchanged).
- `src/capabilities.ts`: `adminOnlyMethods()` += `account.watchExpiry`
  (advertisement accuracy for the rc.2 expiry-notice stream) and
  `QUIET_DENY_METHODS` += `account.watchExpiry` (read-shaped stream: the
  account page probes at boot; quiet 204 instead of a red wall — the whole
  namespace is admin-only, writes stay loud 403).
- `tests/capabilities.spec.ts`: the 0.1.7 account test now asserts
  `watchExpiry` is admin-advertised, absent from the ordinary surface, and
  quiet-denied. Suite 18 files / 209 tests green against rc.2 builds.
- `dist/index.js(.map)` rebuilt (contains the new advertisement);
  `dist/client.js` re-stamp byte-identical (37134 chars).

peerDependencies: **unchanged** — `>=0.1.7-alpha.2 <0.2.0-0` admits
`0.1.7-rc.2` (same `[0,1,7]` tuple; verified with
`semver.satisfies('0.1.7-rc.2', ..., { includePrerelease: true })`), so both
npm install-time resolution and the rc.1 boot-time compatibility admission
(PR #5061) pass. Operational fail-open note from rc.1 still applies: after
any DSH upgrade, verify the login page actually appears (a future DSH beyond
the peer ranges silently skips the bundle).

## 4. Multi-user support detection at 0.1.7-rc.2

`git grep -ilE 'multi.?user|multiuser|role.?based|\brbac\b' dsh-v0.1.7-rc.2
-- packages/` → **0 hits**. The package listing has no user/account/auth
package: `packages/identity` remains the anonymous per-home telemetry
correlation id (README: "nothing to configure… without identifying the
user"). The rc.2 `account` namespace work (provider-auth isolation, bonus
notices, expiry streams) manages the ONE process-wide upstream DeepSeek
Platform grant — reinforcing the one-operator model. **Still NO native
multi-user; dsh-login remains the multi-user layer.**

## 5. Role-based whole-UI permission control at 0.1.7-rc.2

Still **infeasible without upstream changes** — `packages/client/runtime/src`
and `packages/client/ui-slots/src` are source-identical to rc.1 (0 hits for
`isAdmin|isAllowed|role|permission`): the client runtime still activates
every bundle unconditionally, `renderFactorySlot()` still takes no Session
identity, and there is no per-user slot filter / activation gate / role
concept. rc.1's compatibility-admission machinery (PR #5061) is per-plugin
install-time admission, not per-user visibility. The available levers remain
dsh-login's own surfaces: `deriveCapabilities` per-identity advertisement
(`uiPlugins` visibility), the `window.__DSH_SESSION__` render-time baseline,
`/api/auth/capabilities`, and the wire guard — i.e. plugin self-pruning, not
host-enforced RBAC. Upstream asks unchanged: `docs/adapt-dsh-0.1.6.md` §6.
