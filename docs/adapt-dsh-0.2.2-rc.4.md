# Adapting dsh-login to DSH 0.2.2-rc.4 (→ released as 0.3.17)

> Follow-up to [`docs/adapt-dsh-0.2.2-rc.3.md`](adapt-dsh-0.2.2-rc.3.md) (0.3.14).
> Watch cycle 2026-11-18 (scheduled `0 12 * * *` Asia/Shanghai); released as
> **0.3.17**. Smallest real-code delta of the 0.2.2 line: the range touches
> **three source files**, none of them remote-decorated, so the wire registry
> stays at **226 methods** and this is a pure re-pin release. The interesting
> news is on the *unreleased* side: upstream has now implemented a Peer-based
> authentication-Provider seam, which is the first upstream architecture that
> could eventually carry a principal model for dsh-login (see §6).

## 1. Version detection

| source | value at detection (2026-11-18 12:00 +08) |
|---|---|
| npm dist-tags | `@deepseek-ai/dsh` `next` → **0.2.2-rc.4**, published `2026-11-17T17:03:03.170Z` (rc.3 was `2026-11-13T08:05:45.455Z`); `latest` stays `0.2.2-rc.1`, `alpha` `0.2.2-alpha.3`. Read with a no-cache packument GET of `registry.npmjs.org` (§4). `npm view` agreed this run (it has lied before — the packument is the authority) |
| git tags | `dsh-v0.2.2-rc.4` → `3f321d32bfe382212a8ed8785c1d47a5a300aa23` ("Merge PR #8666 worktree-release-dsh-0.2.2-rc.4"); previous newest tag was rc.3 `38a6a5c965`. `origin/master` tip moved `39163dd30f` → `ca33fd6843b205e279c7ccb6cb73a472c78f5760` |
| commits between | `dsh-v0.2.2-rc.3` → `dsh-v0.2.2-rc.4`: **8 commits**, 395 files, +579/−429 — of which `packages/` + `apps/` is 389 files, 504 insertions, 428 deletions |
| real code vs stamps | **only 3 source files changed**, the other 386 are `package.json` version stamps (plus 4 test files and 3 `llm-deepseek` README/i18n docs; the remainder of the 395 is upstream guide docs for the v0.2.2-rc.3 `CONTENT_REFUSED` code and a session fixture) |
| new wire package | none — no new `@Remote`-bearing package in the range |
| local checkout | `E:\code\deepseek-harness` HEAD moved to the rc.4 tag; `packages/**/lib` build artifacts are stale relative to rc.4 but **adequate** for the wire dump, because no remote-decorated source changed (§5) |
| local runtime | live boot ran under a **real npm runtime** (`@deepseek-ai/dsh@0.2.2-rc.4` installed into a scratch dir → `lib/bin.js`), not the dev tree (§4) |

Commits in the range:

```
3f321d32bf Merge pull request #8666 … worktree-release-dsh-0.2.2-rc.4
bc3bddffbd release(dsh): 0.2.2-rc.4
f0f05ba737 fix(liveshare): start the tunnel worker in the Host's Electron Node mode (#8634)
9176a08953 test(liveshare): derive owner credential horizons from the real clock (#8638)
74b0e1d908 Merge pull request #8584 … turtle/add-safety-switch
e68c033493 fix(llm-deepseek): handle refusals without requesting safety review
15762ffc03 feat(llm-deepseek): always request the content safety check
f250e23202 feat(llm-deepseek): add safetyCheck switch for DeepSeek content safety review
```

## 2. Compatibility surface (dsh-v0.2.2-rc.3 → dsh-v0.2.2-rc.4)

Every seam dsh-login mounts is byte-stable:

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| index render seam | **none** — `renderIndex(html: string, peer: PeerScope): string` at `packages/host/webserver/src/index.ts:738` unchanged (at the master tip it sits at `:867`) | login-wall + `uiRoleGate` index rewriting untouched |
| fallback seat | `registerFallback` unchanged | gateway mount untouched |
| `serveStatic` | still not exported | keep self-hosting static assets |
| client boot graph | `__DSH_BOOT__` row unchanged (`packages/client/modules/src/index.ts:635`) | boot-graph filter (`uiRoleGate`) untouched |
| `webserver/index-inject` event | unchanged (`packages/api/remote-access/src/index.ts:139`) | index-injection listener untouched |
| wire registry / typert | **no change**: the `@Remote(` file set is 44 files at both tags with an identical list, and **none** of the 44 changed (`packages/experimental/liveshare/src/host/tunnel-worker.ts`, `packages/llm/llm-deepseek/src/translate.ts`, `packages/llm/llm/src/error.ts` are not remote-decorated) | wire surface stays **226** (§5); only the `dshVersion` stamp moves |
| credentials / settings API | unchanged (package.json-only in both scopes) | no adapter change |
| boot admission | unchanged: `semver.satisfies(..., {includePrerelease: true})`; every `>=0.2.2-alpha.2 <0.3.0-0` peer branch admits rc.4 via the same-tuple rule (checked directly: `0.2.2-rc.4` satisfies those ranges with `includePrerelease: true`; it does **not** satisfy the `~4.x` cordis / `~3.19` schemastery peers, which is correct — those are vendor packages, not DSH packages) | published peer ranges admit rc.4 unchanged |
| `dsh-client-connection` | dual node/browser exports unchanged | `dist/client.js` rebuild **byte-identical** (50396 chars — the size grew in 0.3.16's redesign, not this cycle) |
| vendor | cordis 4.1.0, schemastery 3.19.0, include 1.1.0, loader 1.1.0 — identical to rc.3 | no vendor change |
| master backlog radar (unreleased, `rc.4..origin/master`, **1407 commits** — was 608 past rc.3) | the peer-authentication-Provider architecture landed: `ConnectionAuthentication` service `connection.authentication` at `packages/client/connection/src/authentication.ts:14`, architecture note `.agents/notes/implemented/architecture/2026-11-07-browser-authentication-providers.md` (+ `.zh.md` / `.i18n.yaml`), integration test `packages/api/gateway/tests/authentication-provider.host.spec.ts`; Token and Desktop are now two Providers over one interface; all five `webserver/*` events became instance-scoped (`webServer` as dispatch subject, `global: true` opt-out); WebServer route registration gained explicit `anonymous`/`required`/`deny` policy | radar-only for now (**absent at rc.4** — grepping `connection.authentication` at the tag returns nothing, and neither the note nor the gateway spec exist at the tag). But this is the first upstream seam that can give a plugin its **own principal/Peer**: see §6 and [`docs/role-based-ui-gating.md`](role-based-ui-gating.md) |

## 3. Changes shipped (0.3.17)

- **`package.json`** — `version` → `0.3.17`; the ten `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-rc.3` → `^0.2.2-rc.4`; vendor devDeps and all peerDependencies unchanged.
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-rc.4'`; header comment rewritten to record that the registry is byte-identical to rc.3's because the range touches no remote-decorated source. Buckets stay **140/85/1 = 226** — no method was added or removed, so no classification work and no test-pin moves this cycle.
- **`tests/fixtures/wire-surface.json`** — regenerated (`node scripts/dump-wire-surface.mjs --checkout E:/code/deepseek-harness --version 0.2.2-rc.4`): 226 methods, `dshVersion: "0.2.2-rc.4"`; the only diff is that line.
- **`dist/*`** — rebuilt: `index.js`/`.map` re-stamp `WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.4"`; `client.js` **byte-identical**, not in the git diff.
- **Docs** — this file; a 2026-11-18 re-verification entry in [`docs/role-based-ui-gating.md`](role-based-ui-gating.md) §5; README / README.zh status + compatibility row; `.claude/rules/changelog.md` entry.

## 4. Verification

| step | result |
|---|---|
| dependency resolution | clean retarget (`npm install`, 25 packages changed, no ERESOLVE); all ten `@deepseek-ai/dsh-*` at 0.2.2-rc.4, vendor unchanged |
| `vitest run` | **22 files / 302 tests green**, incl. the strict live cross-check of the wire fixture against the harness checkout at **226 == 226** |
| `npm run build` | exit 0; `dist/client.js` byte-identical; `dist/index.js` stamp-only diff |
| `npm run verify:imports` | exit 0 |
| **live boot under rc.4** | scratch `E:\code\dsh-login\.tmp-rc4` with `npm install @deepseek-ai/dsh@0.2.2-rc.4`, temp `DSH_HOME=E:\code\dsh-login\.tmp-rc4-home`. First boot created `profiles\web\package.json` (bundles `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) on 127.0.0.1:58433 **with** `/?token=…` — i.e. the stock rc.4 entry. Then `npm pack` (islibaodong-dsh-login-0.3.17.tgz), `npm install <tgz>` into `profiles\web` (61 packages), appended `"@islibaodong/dsh-login"` to `dsh.profile.bundles` (BOM-free UTF-8 rewrite), rebooted → **127.0.0.1:58861 with no boot token** (login wall owns the entry) |
| live: login wall | `/` → 302 `/login`; anonymous `GET /api/auth/capabilities` → 401 `{"error":"authentication required"}` |
| live: setup + owner | `POST /api/auth/setup` `{owner, owner-pass-123}` → 200 `{"ok":true}`; owner login → 200; owner `capabilities` = **225 methods** (140 user + 85 admin; host-internal excluded as always), flags `settings.update:true mcpManager.probe:true deepseekChatImport.limits:true terminal.watch:true` |
| live: role isolation | `POST /api/auth/admin/users` `{alice, alice-pass-123}` → 201; alice login → 200; alice `capabilities` = **exactly 140**, `isAdmin:false`, `settings.update:false`, `mcpManager.probe:false`, `deepseekChatImport.limits:true`, `terminal.watch:true`; alice `GET /api/auth/admin/users` → 403 `{"error":"admin required"}` |
| cleanup | boot job killed, `.tmp-rc4` / `.tmp-rc4-home` / tarball removed; `.gitignore` does not cover `.tmp-*`, so the removal is explicit |

Boot-admission note worth keeping: under a *real npm runtime* the entry is `lib/bin.js` of the `@deepseek-ai/dsh` package (the dev-tree checkout booted `apps/cli/lib/bin.js` in earlier cycles), and the profile is created lazily inside `DSH_HOME` on first run. Both paths admit dsh-login identically.

## 5. Wire-surface delta (226 → 226)

**+0 / −0.** This is the first cycle of the 0.2.2 line with a genuinely empty
registry delta, so it is worth stating the evidence rather than the conclusion:

- `@Remote(` appears in **44 files at rc.3 and 44 files at rc.4**, and the two
  lists are identical.
- The intersection of "changed files in the range" and "remote-decorated files"
  is **empty**: the three changed source files are
  `packages/experimental/liveshare/src/host/tunnel-worker.ts` (worker inherits
  `ELECTRON_RUN_AS_NODE` via `workerNodeModeEnv`),
  `packages/llm/llm-deepseek/src/translate.ts` (new `refusal(details)` →
  `LlmError(..., 'CONTENT_REFUSED')`, usage chunk yielded before the throw,
  `stop_reason === 'refusal'`), and `packages/llm/llm/src/error.ts` (+1 line).
- Therefore dumping from the existing (rc.3-rebuilt) `lib/` artifacts reproduces
  the rc.4 registry exactly: live 226 vs fixture 226, `added []`, `removed []`.
  Same precedent as rc.1: a stale build is a valid dump source only when no
  remote-decorated source changed, and that is checked, not assumed.

Buckets therefore stay **140 USER / 85 ADMIN / 1 HOST_INTERNAL**.

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-rc.4.** `git grep -nEi
  "multi.?user|multiuser|role.?based|\brbac\b" dsh-v0.2.2-rc.4 -- packages apps`
  yields **exactly 1 hit**, the standing baseline
  `packages/api/remote-access/README.md:2` — the authorize-only non-owner policy
  engine, which never gates owner principals, and every dsh-login user arrives
  as an owner. The same single hit at the new master tip `ca33fd6843`. No
  password/user store exists upstream; the browser path is still single-owner.
  dsh-login remains the account layer.
- **The three levers the gating evaluation depends on are intact at the same
  lines** (`renderIndex` `webserver/src/index.ts:738`, the `__DSH_BOOT__` row
  `client/modules/src/index.ts:635`, the `index-inject` listener
  `remote-access/src/index.ts:139`). Evaluation verdict and effort estimate
  unchanged — see the doc's 2026-11-18 re-verification entry.
- **Radar, upgraded from "watch" to "shipped upstream, not yet released":** the
  1407-commit backlog past rc.4 now contains the Peer-based authentication
  Providers architecture (note
  `.agents/notes/implemented/architecture/2026-11-07-browser-authentication-providers.md`,
  service `connection.authentication` at
  `packages/client/connection/src/authentication.ts:14`,
  `ctx.inject(['connection.authentication'], …)` at
  `packages/client/connection/src/index.ts:129`,
  `this.authentication = ctx['connection.authentication']` at
  `packages/client/connection/src/rpc-host.ts:80`). An `AuthenticationProvider`
  synchronously returns an existing live Peer or `undefined`, tries Providers in
  registration order, and the Host fixes `peer.principal` at Peer creation. The
  note states the **Remote product itself is not implemented** — no role model,
  no invitation UI. Two consequences for dsh-login when this reaches a release:
  (a) a plugin can supply its own verifier and its own Peer/principal,
  which is the "non-owner identity" condition (a) of the gating doc's §4;
  (b) all five `webserver/*` events become instance-scoped and route
  registration gains `anonymous`/`required`/`deny` policy, so the
  `webserver/index-inject` listener dsh-login mounts must be re-checked for
  service isolation (ordinary listeners are now filtered by `webServer`
  subject; `global: true` opts out) — that is a **compatibility** item for the
  next release, not a role item.

**Conclusion: no new multi-user capability upstream at 0.2.2-rc.4, and no new
wire method — 0.3.17 is a pure re-pin release onto the rc.4 line; every seam
dsh-login mounts is byte-stable and the plugin is verified admitted and
enforcing under a real rc.4 npm runtime, but the 1407-commit unreleased backlog
carries the authentication-Provider architecture that both the next
compatibility check and the role-gating evaluation must read.**
