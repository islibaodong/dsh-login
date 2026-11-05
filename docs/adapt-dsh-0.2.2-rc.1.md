# Adapting dsh-login to DSH 0.2.2-rc.1 (→ released as 0.3.11)

> Follow-up to [`docs/adapt-dsh-0.2.2-alpha.3.md`](adapt-dsh-0.2.2-alpha.3.md) (0.3.10). Watch cycle 2026-11-05 (scheduled `0 12 * * *` Asia/Shanghai); released as **0.3.11** (git tag `v0.3.11`). The quietest *code* adaptation of the 0.2.2 line — rc.1's release range touches **package.json files only**.

## 1. Version detection

| source | value at detection (2026-11-05 12:00 +08) |
|---|---|
| npm dist-tags | every peer package's `next` tag moved to **0.2.2-rc.1**: `@deepseek-ai/dsh`, `dsh-web-frontend`, `dsh-host-webserver`, `dsh-credentials`, `dsh-client-connection`, `dsh-settings`, `dsh-host-frontend-static`, `dsh-brand`, `dsh-scope`, `dsh-session`, `dsh-client-modules`, `dsh-client-locale` — `alpha` stays 0.2.2-alpha.3, `latest` stays the 0.2.1 line (0.0.1-rc.* placeholders / 0.2.1-rc.5) |
| git tags | `dsh-v0.2.2-rc.1` → `66491b05e3` (merge PR #7870), tagged after `8bd073392e` ("Merge pull request #7798 … align master packages with 0.2.2-alpha.3"); tag commit date 2026-11-04 15:50 +0800 |
| commits between | `dsh-v0.2.2-alpha.3` → `dsh-v0.2.2-rc.1`: **2 content commits** — `60d811de43` "release(vendor): cordis 4.1.0, cosmokit 1.9.0, group 1.1.0, hmr 1.1.0, include 1.1.0, loader 1.1.0, logger-console 1.1.0, schemastery 3.19.0, timer 1.2.0" + `2f97f60455` "release(dsh): 0.2.2-rc.1" |
| diff character | **387 files changed, every single one a package.json** — zero `.ts`/`.tsx`/`.css`/`.yml` source changes anywhere in the tree |
| npm publish state | all devDep/peer packages verified published at the rc.1 line (dist-tag check): DSH packages `0.2.2-rc.1`; vendor **stable** re-issue: cordis `4.1.0`, schemastery `3.19.0`, include `1.1.0`, loader `1.1.0` |

## 2. Compatibility surface (dsh-v0.2.2-alpha.3 → dsh-v0.2.2-rc.1)

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| `packages/api` (all controllers) | **none** — no source file changed | method-wall classification untouched; wire registry byte-identical (204 methods, buckets stay 124/79/1) |
| wire registry | unchanged — identical source ⇒ identical `TypertRemoteMap` | **no re-dump needed**; only the version pin moves (`src/api-filter.ts` `WIRE_SURFACE_DSH_VERSION`, `tests/fixtures/wire-surface.json` `dshVersion`) |
| vendor | cordis 4.0.6-alpha.2 → **4.1.0** (stable), schemastery 3.18.6-alpha.2 → **3.19.0** (stable), include/loader → **1.1.0** | devDeps retarget; **peerDependencies gain `~4.1.0` / `~3.19.0` branches** — the existing `^4.0.1-rc.1` / `^3.18.1-rc.1` branches cannot admit the new `[4,1,0]`/`[3,19,0]` tuples under npm's install-time prerelease rule (the same ERESOLVE shape as the 0.1.7 trap) |
| DSH packages (`connection`, `modules`, `credentials`, `host-webserver`, `host-frontend-static`, `settings`, `web-frontend`, `brand`, `scope`, `session`) | `package.json` bumps only (0.2.2-alpha.3 → 0.2.2-rc.1) | devDeps retarget to `^0.2.2-rc.1`; **peers unchanged** — the existing `>=0.2.2-alpha.2 <0.3.0-0` branches admit rc.1 via the same-tuple rule |
| `packages/client/modules` | no source change | `__DSH_BOOT__` lever intact (`packages/client/modules/src/index.ts:635` — grep at the tag); `dist/client.js` rebuild byte-identical (verified by SHA-256) |
| DSH `latest`/`next` promotion semantics | `next` = 0.2.2-rc.1 for all packages — the first **rc** on the 0.2.2 line signals release-candidate status; `alpha` still pinned at alpha.3 | dsh-login follows the versioned line the runtime actually serves; the boot-time admission check uses `includePrerelease: true` so rc.1 satisfies the published peer ranges either way |

## 3. Changes shipped (0.3.11)

- **`package.json`** — `version` → `0.3.11`; the eleven `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-alpha.3` → `^0.2.2-rc.1`; vendor devDeps moved to the stable line (cordis `~4.1.0`, schemastery `~3.19.0`, include `~1.1.0`, loader `~1.1.0`). **peerDependencies**: `@deepseek-ai/cordis` += `|| ~4.1.0`, `@deepseek-ai/schemastery` += `|| ~3.19.0`; all DSH-package branches unchanged.
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-rc.1'`; header notes rc.1 carries the alpha.3 registry byte-identical (package.json-only release range). **Method lists unchanged** — buckets stay **124 / 79 / 1** = 204.
- **`tests/fixtures/wire-surface.json`** — `dshVersion` → `0.2.2-rc.1` (method list untouched; the registry is provably identical: zero non-package.json diffs in the release range).
- **`tests/wire-surface.spec.ts`** — unchanged (pins 124/79/1; no-checkout branch expects 204; live cross-check against the alpha.3-built harness checkout stays 204==204).
- **`dist/*`** — rebuilt: `index.js`/`index.js.map` re-stamp `WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.1"` (single-line diff); `client.js` **byte-identical** (37134 chars, SHA-256 unchanged pre/post build).
- **Docs** — this file; README / README.zh banner + status + adaptation history + tracking/evaluation updates; `.claude/rules/changelog.md` + `.claude/rules/gotchas.md` entries.

## 4. Verification

| step | result |
|---|---|
| dependency resolution | first incremental `npm install` ERESOLVE-wedged on the stale alpha.3 lockfile tree (old `cordis-plugin-group` peer from the alpha.3 `dsh-app-boot` chain) — **clean install fixed it**: `node_modules` + `package-lock.json` deleted, fresh `npm install` resolved 111 packages in 10s; `npm ls`-style verification: all `@deepseek-ai/dsh-*` at 0.2.2-rc.1, cordis 4.1.0, schemastery 3.19.0, include 1.1.0, loader 1.1.0 |
| `vitest run` | **21 files / 269 tests green** against the published rc.1 builds (incl. wire-surface disjoint/total/exhaustive checks at 204 and the strict live cross-check 204==204) |
| `npm run build` | exit 0; `dist/client.js` 37134 chars, SHA-256-verified byte-identical; `dist/index.js` stamp-only diff |
| `npm run verify:imports` | **exit 0** — the pre-existing tsx strip-only failure (recorded since 0.3.9) no longer reproduces on this node/tsx combination |
| multi-user grep at the rc.1 tag | still exactly **1 hit** (`packages/api/remote-access/README.md`) — no native accounts |

As with every release: the per-user isolation guard composed over the native `typertGateway` ([`docs/compose-guard.md`](compose-guard.md)) and the two-browser isolation sign-off remain **deployment-side acceptance steps** (see [`docs/verify-option-A.md`](verify-option-A.md) §B).

## 5. Wire-surface delta

**None.** The alpha.3 → rc.1 range contains zero source changes; the 204-method registry (124 user / 79 admin-only / 1 host-internal) is carried over unchanged. The strict live cross-check against the locally built harness checkout (alpha.3 state, identical surface) passed 204==204.

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-rc.1.** The recurring `multi.?user|multiuser|role.?based|\brbac\b` grep over `packages/ apps/` still yields exactly the one standing hit: `packages/api/remote-access/README.md`. dsh-login remains the account/authn layer.
- **Whole-UI role gating remains dsh-login's territory.** The client still activates every bundle unconditionally through `window.__DSH_BOOT__`; the lever `uiRoleGate` rewrites is untouched (`packages/client/modules/src/index.ts:635`, verified by grep at the rc.1 tag). No new permission axis upstream (remote-access RBAC is still connection-axis only). dsh-login's `uiRoleGate` (since 0.3.0) remains THE answer; per-identity slot/section filtering inside an allowed bundle and a host-side per-user plugin activation gate remain the outstanding upstream asks.

**Conclusion: no new multi-user capability upstream. 0.3.11 is a dependency-retarget release onto the 0.2.2-rc.1 + vendor-stable line (cordis 4.1.0 / schemastery 3.19.0); wire surface and role model unchanged.**
