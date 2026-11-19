# Adapting dsh-login to DSH 0.2.2-rc.5 (→ released as 0.3.18)

> Follow-up to [`docs/adapt-dsh-0.2.2-rc.4.md`](adapt-dsh-0.2.2-rc.4.md) (0.3.17).
> Watch cycle 2026-11-19 (scheduled `0 12 * * *` Asia/Shanghai); released as
> **0.3.18**. The first rc.5-shaped release is a **pure re-pin** for dsh-login:
> the range carries one real behaviour change (route-aware web-search provider
> selection) but touches **no remote-decorated source**, so the wire registry
> stays at **226 methods** and every mounted seam is byte-stable. There is still
> **no native multi-user support** at the tag (see §6).

## 1. Version detection

| source | value at detection (2026-11-19 12:00 +08) |
|---|---|
| npm dist-tags | `@deepseek-ai/dsh` `next` → **0.2.2-rc.5**, published `2026-11-18T13:17:23.604Z` (rc.4 was `2026-11-17T17:03:03.170Z`); `latest` stays `0.2.2-rc.1`, `alpha` `0.2.2-alpha.3`. Read with a no-cache packument GET of `registry.npmjs.org` (§4). |
| git tags | `dsh-v0.2.2-rc.5` → `9c2670d3bce5275e0d1610272958121af87787bb` ("Merge PR #8728 worktree-release-dsh-0.2.2-rc.5"); previous newest tag was rc.4 `3f321d32bf`. `origin/master` tip is unchanged at `2e39e70496aa02986ca6a820c5d497e816b69d7e` (2026-11-18 18:58 +0800). |
| commits between | `dsh-v0.2.2-rc.4` → `dsh-v0.2.2-rc.5`: **5 commits**, 433 files, +917/−594 — of which `packages/` + `apps/` is 413 files, +759/−529 |
| real code vs stamps | the range is mostly `package.json` version stamps. Real files: the web-search routing change (`packages/web/web/src/index.ts`, `types.ts`, `tool-web/src/search.ts`, `web-search-deepseek/src/{provider,types}.ts`, `ui-settings-web-search` client + locales), the base bundle patch that stops pinning `searchProvider`, tests/e2e overlays, and `tool-cordis/src/api-catalog.ts` (doc strings only) |
| new wire package | none — no new `@Remote`-bearing package in the range |
| local checkout | `E:\code\deepseek-harness` stayed detached at the **rc.3** tag (`38a6a5c965…`); its `packages/**/lib` artifacts are stale relative to rc.5 but **adequate** for the wire dump, because no remote-decorated source changed (§5) |
| local runtime | live boot ran under a **real npm runtime** (`@deepseek-ai/dsh@0.2.2-rc.5` installed into a scratch dir → `lib/bin.js`), not the dev tree (§4) |

Commits in the range:

```
9c2670d3bc Merge pull request #8728 from deepseek-harness/worktree-release-dsh-0.2.2-rc.5
9bf478edde release(dsh): 0.2.2-rc.5
f47a0a2b52 Merge pull request #8707 from deepseek-harness/feat/web-search-deepseek-model-default
6368d91027 Merge pull request #8595 from deepseek-harness/worktree/release-0.2.2-liveshare-test-clock
0f0cd323c4 test(liveshare): derive owner credential horizons from the real clock
```

## 2. Compatibility surface (dsh-v0.2.2-rc.4 → dsh-v0.2.2-rc.5)

Every seam dsh-login mounts is byte-stable:

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| index render seam | **none** — `renderIndex(html: string, peer: PeerScope): string` at `packages/host/webserver/src/index.ts:738` unchanged | login-wall + `uiRoleGate` index rewriting untouched |
| fallback seat | `registerFallback` unchanged | gateway mount untouched |
| `serveStatic` | still not exported | keep self-hosting static assets |
| client boot graph | `__DSH_BOOT__` row unchanged (`packages/client/modules/src/index.ts:635`) | boot-graph filter (`uiRoleGate`) untouched |
| `webserver/index-inject` event | unchanged (`packages/api/remote-access/src/index.ts:139`) | index-injection listener untouched |
| wire registry / typert | **no change**: the `@Remote(` file set is 44 files at both tags with an identical list, and **none** of them changed | wire surface stays **226** (§5); only the `dshVersion` stamp moves |
| credentials / settings API | unchanged (package.json-only in both scopes) | no adapter change |
| boot admission | unchanged: `semver.satisfies(..., {includePrerelease: true})`; every `>=0.2.2-alpha.2 <0.3.0-0` peer branch admits rc.5 via the same-tuple rule (checked directly: `0.2.2-rc.5` satisfies those ranges with `includePrerelease: true`) | published peer ranges admit rc.5 unchanged |
| `dsh-client-connection` | dual node/browser exports unchanged | `dist/client.js` rebuild **byte-identical** (50396 chars) |
| vendor | cordis 4.1.0, schemastery 3.19.0, include 1.1.0, loader 1.1.0 — identical to rc.4 | no vendor change |
| functional delta (no plugin impact) | per-model route web-search default: `deepseek-official` / `deepseek-account` routes use the legacy Messages search provider, other routes use `deepseek-search-api`; `packages/bundle/base/cordis.patch.yml` no longer pins `searchProvider` on the `web` row, and `ui-settings-web-search` explains the route-aware default | dsh-login does not proxy or classify web-search methods; `web.listProviders` is unchanged and still user-visible |
| master backlog radar (unreleased, `rc.5..origin/master`, **1640 commits**) | still no `connection.authentication` at the tag (`git grep connection.authentication` → no output, exit 1); the Peer-based authentication-Provider architecture remains implemented-but-unreleased | radar-only; the `webserver/index-inject` instance-scoping compatibility item has **not** shipped yet — see §6 |

## 3. Changes shipped (0.3.18)

- **`package.json`** — `version` → `0.3.18`; the ten `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-rc.4` → `^0.2.2-rc.5`; vendor devDeps and all peerDependencies unchanged.
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-rc.5'`; header comment rewritten to record that the registry is byte-identical to rc.4's because the range touches no remote-decorated source. Buckets stay **140/85/1 = 226** — no method was added or removed, so no classification work and no test-pin moves this cycle.
- **`tests/fixtures/wire-surface.json`** — regenerated: 226 methods, `dshVersion: "0.2.2-rc.5"`; the only diff is that line.
- **`dist/*`** — rebuilt: `index.js`/`.map` re-stamp `WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.5"`; `client.js` **byte-identical**, not in the git diff.
- **Docs** — this file; a 2026-11-19 re-verification entry in [`docs/role-based-ui-gating.md`](role-based-ui-gating.md) §5; README / README.zh status + compatibility row; `.claude/rules/changelog.md` entry.

## 4. Verification

| step | result |
|---|---|
| dependency resolution | clean retarget (`npm install`, `package-lock.json` regenerated, no ERESOLVE); all `@deepseek-ai/dsh-*` at 0.2.2-rc.5, vendor unchanged |
| `vitest run` | **22 files / 302 tests green**, incl. the strict live cross-check of the wire fixture against the harness checkout at **226 == 226** |
| `npm run build` | exit 0; `dist/client.js` byte-identical; `dist/index.js` stamp-only diff |
| `npm run verify:imports` | exit 0 |
| **live boot under rc.5** | scratch `E:\code\dsh-login\.tmp-rc5` with `npm install @deepseek-ai/dsh@0.2.2-rc.5`, temp `DSH_HOME=E:\code\dsh-login\.tmp-rc5-home`. First boot on a fixed port failed with `listen EACCES: permission denied 127.0.0.1:58901` (Windows excluded range) but still created `profiles\web\package.json`; the retry used `--port 0` and booted on **127.0.0.1:56812 with no boot token** (login wall owns the entry). Then `npm pack` (islibaodong-dsh-login-0.3.18.tgz, 38 files), `npm install <tgz>` into `profiles\web`, appended `"@islibaodong/dsh-login"` to `dsh.profile.bundles` (BOM-free UTF-8 rewrite), rebooted |
| live: login wall | `/` → 302 `/login`; anonymous `GET /api/auth/capabilities` → 401 `{"error":"authentication required"}` |
| live: setup + owner | `POST /api/auth/setup` `{owner, owner-pass-123}` → 200 `{"ok":true}`; owner login → 200; owner `capabilities` = **225 methods** (140 user + 85 admin; host-internal excluded as always), `isAdmin:true` |
| live: role isolation | `POST /api/auth/admin/users` `{alice, alice-pass-123, isAdmin:false}` → 201; alice login → 200; alice `capabilities` = **exactly 140**, `isAdmin:false`; alice `GET /api/auth/admin/users` → 403; owner same route → 200 |
| live: boot payload | authenticated `GET /` returns the injected index (45 KB) with the `__DSH_BOOT__` graph — the render seam and boot-graph filter still apply under rc.5 |
| cleanup | boot process killed; tarball and cookie/scratch files removed; `.tmp-rc5` / `.tmp-rc5-home` stay local (`.gitignore` covers `/.tmp-*`) |

Boot-admission note worth keeping: a fixed high port can land in a Windows
excluded range and fail with `EACCES` even though the profile was created; use
`--port 0` for scratch boots and read the printed URL.

## 5. Wire-surface delta (226 → 226)

**+0 / −0.** Evidence, not just conclusion:

- `@Remote(` appears in **44 files at rc.4 and 44 files at rc.5**, and the two lists are identical.
- The intersection of "changed files in the range" and "remote-decorated files" is **empty**. The changed `packages/extensions/tool-cordis/src/api-catalog.ts` is a documentation catalogue (`SERVICE_API` / `TYPE_API` strings) — its diff only updates the `web` service description for route-aware provider selection and adds `llmProvider?: string` to the `WebSearchRequest` doc declaration; no decorator, no method key, no signature the registry reads.
- Therefore dumping from the existing (rc.3-rebuilt) `lib/` artifacts reproduces the rc.5 registry exactly: live 226 vs fixture 226, `added []`, `removed []`. A stale build is a valid dump source only when no remote-decorated source changed, and that is checked, not assumed.
- Trying to dump from an npm tarball install is still **wrong**: `@deepseek-ai/dsh@0.2.2-rc.4` into a scratch dir ships 39 `typert.remote-client.d.ts` files and yields **224** methods, two short of the registry. Always dump from a checkout build.

Buckets therefore stay **140 USER / 85 ADMIN / 1 HOST_INTERNAL**.

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-rc.5.** `git grep -nEi "multi.?user|multiuser|role.?based|\brbac\b" dsh-v0.2.2-rc.5 -- packages apps` yields **exactly 1 hit**, the standing baseline `packages/api/remote-access/README.md:2` — the authorize-only non-owner policy engine, which never gates owner principals, and every dsh-login user arrives as an owner. No password/user store exists upstream; the browser path is still single-owner. dsh-login remains the account layer.
- **The three levers the gating evaluation depends on are intact at the same lines** (`renderIndex` `webserver/src/index.ts:738`, the `__DSH_BOOT__` row `client/modules/src/index.ts:635`, the `index-inject` listener `remote-access/src/index.ts:139`). Evaluation verdict and effort estimate unchanged — see the doc's 2026-11-19 re-verification entry.
- **Radar unchanged:** the 1640-commit backlog past rc.5 still has the Peer-based authentication-Provider architecture implemented but unreleased; at the tag `connection.authentication` does not exist. The two consequences recorded in the rc.4 doc still stand — (a) a plugin could eventually supply its own Peer/principal (condition (a) of the gating doc's §4), and (b) the `webserver/*` instance-scoping change is a **compatibility** item for whichever release ships it.

**Conclusion: no new multi-user capability upstream at 0.2.2-rc.5, and no wire-method change — 0.3.18 is a pure re-pin release onto the rc.5 line; the one functional upstream change (route-aware web-search selection) does not touch any dsh-login seam, and the plugin is verified admitted and enforcing under a real rc.5 npm runtime (owner 225 / user 140, admin route 403 for the user).**
