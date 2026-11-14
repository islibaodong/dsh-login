# Adapting dsh-login to DSH 0.2.2-rc.3 (→ released as 0.3.14)

> Follow-up to [`docs/adapt-dsh-0.2.2-rc.2.md`](adapt-dsh-0.2.2-rc.2.md) (0.3.13). Watch cycle 2026-11-14 (scheduled `0 12 * * *` Asia/Shanghai); released as **0.3.14** (git tag `v0.3.14`). The quietest release of the 0.2.2 line: **every integration seam dsh-login mounts is byte-stable**, and the wire registry grows by exactly **one method** (`deepseekChatImport.limits`). This is a pure re-pin release.

## 1. Version detection

| source | value at detection (2026-11-14 12:00 +08) |
|---|---|
| npm dist-tags | every `@deepseek-ai/dsh-*` peer's `next` tag moved to **0.2.2-rc.3** (`dsh`, `dsh-brand`, `dsh-client-connection`, `dsh-client-modules`, `dsh-credentials`, `dsh-host-frontend-static`, `dsh-host-webserver`, `dsh-scope`, `dsh-session`, `dsh-settings`, `dsh-web-frontend`); `dsh` `latest` stays on the 0.2.1 line (0.2.2-rc.1); `dsh-web-frontend`/`dsh-host-webserver` `latest` remain legacy placeholders (0.0.1-rc.5 / 0.0.1-rc.1); vendor stable unchanged (cordis `4.1.0`, schemastery `3.19.0`, include `1.1.0`, loader `1.1.0`) — no new vendor cut in this range |
| git tags | `dsh-v0.2.2-rc.3` → `38a6a5c965` ("Merge PR #8397 worktree-release-dsh-0.2.2-rc.3"), commit date 2026-11-13 13:26 +0800; `origin/master` tip moved `e8f7b93a34` → `39163dd30f` |
| commits between | `dsh-v0.2.2-rc.2` → `dsh-v0.2.2-rc.3`: **6 commits, 515 files changed, +10988/−669** — but the plugin-relevant scopes (`packages/api`, `packages/credentials`, `packages/settings`, `packages/host/webserver`, `packages/host/frontend-static`, `packages/client/modules`, `packages/client/connection`) changed **package.json only — zero source changes**. The real code sits in `packages/client/ui-*` (new `ui-directory-picker-browse`/`ui-directory-picker-native`, `ui-primitives` icons, `ui-sidebar` slots +18, `ui-workspace` WorkspacePicker +58 / slots +64) — client-side UI with no plugin-facing seam |
| new wire package | `packages/experimental/deepseek-chat-import/` (feature #8342, 导入 DeepSeek 官网对话导出为会话): exactly **one** `@Remote` method, `limits(signal): DeepseekChatImportLimits` — "Report the limits the browser checks before uploading. Only the owner may import" (`RemoteError('deepseekChatImport/owner-only')` otherwise). The archive upload itself is an HTTP `POST /api/deepseek-chat-import/archive` route, **not** a wire method. The package mounts via the cordis include mechanism (not referenced by `packages/api` / `client/modules` / `web` / `host` at rc.3) |
| local checkout | `E:\code\deepseek-harness` HEAD detached exactly at `38a6a5c965` (the rc.3 tag), node_modules installed, `packages/**/lib` built 2026-11-13 17:00:32 (after tag creation) — the live cross-check and boot ran against this tree |
| local runtime | the packaged desktop install under `D:\soft\dsh` is **gone this run** (directory absent) — the dev-tree checkout at the rc.3 tag is the runtime target; live boot verified against it (§4) |

## 2. Compatibility surface (dsh-v0.2.2-rc.2 → dsh-v0.2.2-rc.3)

All mounted seams are byte-stable:

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| index render seam | **none** — `renderIndex(html, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738` unchanged | login-wall + `uiRoleGate` index rewriting untouched |
| fallback seat | `registerFallback` unchanged | gateway mount untouched |
| `serveStatic` | still not exported | keep self-hosting static assets |
| client boot graph | `__DSH_BOOT__` row unchanged (`packages/client/modules/src/index.ts:635`) | boot-graph filter (`uiRoleGate`) untouched |
| `webserver/index-inject` event | unchanged (`packages/api/remote-access/src/index.ts:139`) | index-injection listener untouched |
| **wire registry / typert** | **the only real change: +1 method.** `deepseekChatImport.limits` joins the registry (new experimental chat-import package, §1) | **wire surface re-pinned 225 → 226** (§5); fixture re-dumped; one USER classification added |
| credentials / settings API | unchanged (package.json-only in both scopes) | no adapter change |
| boot admission | unchanged: `semver.satisfies(..., {includePrerelease: true})`; the `>=0.2.2-alpha.2 <0.3.0-0` peer branches admit rc.3 via the same-tuple rule | published peer ranges admit rc.3 unchanged |
| `dsh-client-connection` | dual node/browser exports unchanged | `dist/client.js` rebuild **byte-identical** |
| vendor | cordis 4.1.0, schemastery 3.19.0, include 1.1.0, loader 1.1.0 — identical to rc.2 | no vendor change |
| master backlog radar (unreleased, `rc.3..origin/master`, 608 commits) | real source drift forming in `packages/api/gateway` (`stream-server.ts`, `client/{journal-stream,remote-stream,stream-client}.ts`, new `tests/authentication-provider.host.spec.ts` — upstream is building an **auth-provider seam into the gateway**), `job-controller` (observe/types/client), `remotes/src/client/index.ts`; `deepseek-chat-import` evolving (mount/conversation/importer) but still exactly 1 `@Remote` | radar-only; the gateway auth-provider work is the one to watch — it may eventually carry non-owner principals natively (see [`docs/role-based-ui-gating.md`](role-based-ui-gating.md)) |

## 3. Changes shipped (0.3.14)

- **`package.json`** — `version` → `0.3.14`; the ten `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-rc.2` → `^0.2.2-rc.3`; vendor devDeps and all peerDependencies unchanged (the `>=0.2.2-alpha.2 <0.3.0-0` DSH branches admit rc.3 via the same-tuple rule).
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-rc.3'`; transcription header rewritten for the 226-method registry; **USER_ALLOWED** += `deepseekChatImport.limits` (rationale in §5); **ADMIN**/**HOST_INTERNAL** blocks unchanged. Buckets move **139/85/1 → 140/85/1** (total 226). The rc.2 comment annotations stay (the registry is a superset; one list serves both lines).
- **`tests/fixtures/wire-surface.json`** — re-dumped from the built rc.3 checkout (`node scripts/dump-wire-surface.mjs --checkout E:/code/deepseek-harness`, which auto-reads `dshVersion`): 226 methods, `dshVersion: 0.2.2-rc.3`.
- **Test re-pins** — `tests/wire-surface.spec.ts` bucket counter 139 → 140 and no-checkout fallback 225 → 226 (the only pins that moved).
- **`dist/*`** — rebuilt: `index.js`/`.map` re-stamp `WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.3"`; `client.js` **byte-identical** (42407 chars, not in the git diff) — expected, since the client bundle only encodes the module-loader banner + settings panel.
- **Docs** — this file; a 2026-11-14 re-verification entry in [`docs/role-based-ui-gating.md`](role-based-ui-gating.md) §5; README / README.zh status + compatibility row; `.claude/rules/changelog.md` entry.

## 4. Verification

| step | result |
|---|---|
| dependency resolution | clean retarget (`npm install`, 25 packages changed, no ERESOLVE) — all `@deepseek-ai/dsh-*` at 0.2.2-rc.3, vendor stable 4.1.0/3.19.0/1.1.0/1.1.0 |
| `vitest run` | **22 files / 298 tests green** against the built rc.3 checkout (incl. the strict live cross-check of the wire fixture against the harness checkout at 226 == 226) |
| `npm run verify:imports` | exit 0 |
| `npm run build` | exit 0; `dist/client.js` byte-identical; `dist/index.js` stamp-only diff |
| **live boot under rc.3** | temp `DSH_HOME` profile (`E:\code\dsh-login\.tmp-home-rc3`), `npm pack` tarball installed into the profile (`npm install <tgz>` → profile `node_modules`), `"@islibaodong/dsh-login"` appended to `dsh.profile.bundles` (BOM-free UTF-8 rewrite), boot `node apps/cli/lib/bin.js web --port 0 --no-open` from the checkout. Note: the default port 3080 is held by the running GUI (EADDRINUSE on first attempt) — `--port 0` (OS-picked) is the dev-tree workaround. Server came up on 127.0.0.1:65138 **with no boot token in the URL** (the login wall owns the entry) |
| live: login wall | `/` → 302 (login page redirect); anonymous `/api/auth/capabilities` → 401 `{"error":"authentication required"}` |
| live: setup + owner | `POST /api/auth/setup` `{username,password}` → 200 `{"ok":true}`; owner login → 200 + cookie; owner `capabilities` = **225 methods** (140 user + 85 admin; host-internal excluded as always) — `deepseekChatImport.limits` **present**, `mcpManager.probe` / `settings.update` / `officeKit.render` / `web.listProviders` all present |
| live: role isolation | created `alice` (non-admin) via `POST /api/auth/admin/users` → 201; alice's `capabilities` = **exactly 140** (the user bucket); admin methods absent (`settings.update`, `credentials.set`, no `mcpManager.*`); `GET /api/auth/admin/users` as alice → 403 `{"error":"admin required"}` |
| cleanup | boot job killed, port 65138 released, temp home + tarball removed; `git status` shows exactly the intended 7 modified files |

Windows-curl gotcha hit during probing: single-quoted JSON bodies lose their inner double quotes when passed through PowerShell → curl.exe native argument parsing (the 400 `{"error":"bad request"}` was a server-side JSON parse failure, not a payload problem). Fix: `--data "@file"` payload files. (Same class as the ENEEDAUTH userconfig lesson from the 0.3.13 publish — each fresh shell re-parses arguments.)

## 5. Wire-surface delta (225 → 226)

**+1 / −0:** `deepseekChatImport.limits`.

Classification rationale (verified by reading `packages/experimental/deepseek-chat-import/src/index.ts` at the rc.3 tag):

- **USER**: `limits` is a read-only probe of upload constraints the browser checks before posting an exported conversation archive. Upstream declares the whole surface **owner-only**; under dsh-login every signed-in browser user is an owner principal, so the read always succeeds — a harmless per-user read with the same trust shape as the schedule/session catalog reads. The archive upload itself is an HTTP POST route (`/api/deepseek-chat-import/archive`), not a wire method, so it stays outside this registry's classification.

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-rc.3.** The recurring `multi.?user|multiuser|role.?based|\brbac\b` grep at the tag yields **exactly 1 hit** — the standing baseline `packages/api/remote-access/README.md:2` (the authorize-only non-owner policy engine that never gates owner principals; every dsh-login user arrives as an owner). No password/user store exists upstream; the browser path is still single-owner.
- **The three levers [`docs/role-based-ui-gating.md`](role-based-ui-gating.md) depends on are intact at the same lines** (`renderIndex` at `webserver/src/index.ts:738`, the `__DSH_BOOT__` row at `client/modules/src/index.ts:635`, the `index-inject` listener at `remote-access/src/index.ts:139`) — see the doc's 2026-11-14 re-verification entry. Evaluation verdict unchanged (≈1–2 days, wait for an upstream role/principal model).
- **Radar note:** the unreleased master backlog shows upstream building an `authentication-provider` seam into the gateway (`tests/authentication-provider.host.spec.ts` is new past rc.3). If that lands with a non-owner principal model, it changes the §3/§4 calculus in the gating evaluation — re-read that doc when the next DSH release carries it.

**Conclusion: no new multi-user capability upstream. 0.3.14 is a pure re-pin release onto the 0.2.2-rc.3 line (+1 method, buckets 140/85/1); every seam dsh-login mounts is byte-stable; the plugin is verified admitted and enforcing under the rc.3 dev-tree runtime.**
