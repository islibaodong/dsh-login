# Adapting dsh-login to DSH 0.2.2-rc.2 (→ released as 0.3.13)

> Follow-up to [`docs/adapt-dsh-0.2.2-rc.1.md`](adapt-dsh-0.2.2-rc.1.md) (0.3.11). Watch cycle 2026-11-13 (scheduled `0 12 * * *` Asia/Shanghai); released as **0.3.13** (git tag `v0.3.13`). A real-code release — the first surface change since alpha.2: the wire registry grows **204 → 225 methods** with an upstream namespace rename, while every integration seam dsh-login actually mounts stays byte-stable or purely additive.

## 1. Version detection

| source | value at detection (2026-11-13 12:00 +08) |
|---|---|
| npm dist-tags | every `@deepseek-ai/dsh-*` peer's `next` tag moved to **0.2.2-rc.2** (`dsh`, `dsh-brand`, `dsh-client-connection`, `dsh-client-modules`, `dsh-credentials`, `dsh-host-frontend-static`, `dsh-host-webserver`, `dsh-scope`, `dsh-session`, `dsh-settings`, `dsh-web-frontend`); `latest` stays on the 0.2.1 line; vendor stable unchanged (cordis `4.1.0`, schemastery `3.19.0`, include `1.1.0`, loader `1.1.0`) — no new vendor cut in this range |
| git tags | `dsh-v0.2.2-rc.2` → `ddac96760b` ("Merge PR #8277 worktree-release-dsh-0.2.2-rc.2"), commit date 2026-11-11 10:32 +0800; `origin/master` tip moved `fcc0ad4621` → `e8f7b93a34` |
| commits between | `dsh-v0.2.2-rc.1` → `dsh-v0.2.2-rc.2`: **1568 commits, 2713 files changed, ~108K insertions** — the largest real-code delta of the 0.2.2 line so far (packages/client 699 files, experimental 605, api 107, credentials 52, typert 11, host 9, settings 1) |
| local runtime | the packaged desktop install (D:\soft\dsh, Electron 44.7.0) **already runs rc.2**: `app.asar` root `package.json` = `@deepseek-ai/dsh-desktop` `0.2.2-rc.2`, `dsh/` subtree `@deepseek-ai/dsh-desktop-runtime` `0.2.2-rc.2` (nightly update feed `https://download.deepseek.com/dsh-desk/feeds/win-x64/`) — i.e. the shipped runtime was ahead of the npm `next` tag for ~a day before the tag published |
| npm publish state | all devDep/peer packages verified published at the rc.2 line (dist-tag check) |

## 2. Compatibility surface (dsh-v0.2.2-rc.1 → dsh-v0.2.2-rc.2)

A 12-point seam audit (git diff/grep at tags `66491b05` vs `ddac9676`) found **11/12 seams byte-stable or purely additive**; dsh-login needed no retargeting beyond the wire surface:

| integration point | upstream change | impact on dsh-login |
|---|---|---|
| index render seam | **none** — `renderIndex(html, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738` unchanged, file diff empty; `PeerScope` at `packages/typert/protocol/src/types.ts:468` unchanged | login-wall + `uiRoleGate` index rewriting untouched |
| fallback seat | `registerFallback` unchanged (`webserver/src/index.ts:477`) | gateway mount untouched |
| `serveStatic` | still not exported (`frontend-static/src/index.ts:93`, internal only) | keep self-hosting static assets |
| client boot graph | `__DSH_BOOT__` row unchanged (`packages/client/modules/src/index.ts:635`); `parseBootManifest` (`client/manifest.ts:229`) unchanged; only change: a failed client entry load is now caught+logged instead of aborting boot (more tolerant) | boot-graph filter (`uiRoleGate`) untouched |
| `webserver/index-inject` event | unchanged (`packages/api/remote-access/src/index.ts:139`) | index-injection listener untouched |
| **wire registry / typert** | **the only real change.** typert's 11 changed files are generator/docs output; remotes mount re-pointed: `accountRemote` → `@deepseek-ai/dsh-deepseek-account/remote` (package `dsh-api-account-controller` deleted), `officeToPdfRemote` → `officeKitRemote`; added `agentTeamsRemote`, `mcpManagerRemote`, `webRemote`; forwarded events += `web/providers-changed`; `account.watch` now streams `AccountUpdate` (was `AccountView`, `deepseek-account/src/index.ts:621`) | **wire surface re-pinned 204 → 225** (§5); classification re-derived; fixture re-dumped |
| credentials API | additive only: `CredentialInfo` gains optional `masked?`; credentials-local `describe()` returns `{configured,source,writable,masked}`; `set(ref,value)`/`unset(ref)` unchanged; `deepseek-account-platform` deleted | no adapter change |
| boot admission | unchanged: `packages/boot/app-boot/src/plugin-compatibility.ts:52` still `semver.satisfies(..., {includePrerelease: true})`; `assertBundlePlatform` accepts `'wsl'` | published peer ranges admit rc.2 unchanged |
| `dsh-client-connection` | dual node/browser exports unchanged; `window.__ModuleLoader__.load({id:` banner still build-time (`packages/client/tsdown.client.ts:941`, asserted by `client-bundle-purity.spec.ts:66`) | `dist/client.js` rebuild **byte-identical** (SHA-256) |
| web runtime composition | `provide('webApp', {getAdvertisedUrl})` + `web-runtime` rows unchanged (`packages/bundle/web-app/src/index.ts:205/:210`); `cordis.patch.yml` rows `web-runtime`/`harness-dev-context` untouched (rc.2 hunks touch other rows: account-controller → ui-account-notifications, +mcp-manager, office-to-pdf → office-kit, +workspace-dependencies/skill-office/ui-agent-team) | webRuntime re-provide pattern still conflict-free |
| WS mux / gateway seams | unchanged: `REMOTE_STREAM_MUX_PATH='/api/remote.mux'` (`packages/api/gateway/src/stream-protocol.ts:7`); `gateway.dispatchRpc` (`gateway/src/index.ts:491`), `openWireStream` (`:525`), `connection.admit` (`rpc-host.ts:129`); `events.mux` is docs-only at both tags | dispatch-seam guard (0.3.12) untouched |
| vendor | cordis 4.1.0, schemastery 3.19.0, include 1.1.0, loader 1.1.0 — identical to rc.1 | no peer/devDep vendor change |

## 3. Changes shipped (0.3.13)

- **`package.json`** — `version` → `0.3.13`; the ten `@deepseek-ai/dsh-*` devDeps retargeted `^0.2.2-rc.1` → `^0.2.2-rc.2`; vendor devDeps and all peerDependencies unchanged (the `>=0.2.2-alpha.2 <0.3.0-0` DSH branches admit rc.2 via the same-tuple rule; the vendor stable branches match).
- **`src/api-filter.ts`** — `WIRE_SURFACE_DSH_VERSION = '0.2.2-rc.2'`; transcription header rewritten for the 225-method registry; **USER block**: `officeToPdf.*` → `officeKit.*` rename, += `agentTeams.setEnabled`, 12 × `forgePanel.*` review-flow methods, `terminal.watch`, `workspaceFiles.search`, `subagents.interruptByUser`; **ADMIN block**: `account.ackBonusNotified`/`account.getUnnotifiedBonuses` out, += `account.getNotifications`/`getNotificationContent`/`reportNotificationEvent`, `mcpManager.probe`/`restart`/`watch`, `web.listProviders`, `liveshareShares.addSessions`. Buckets move **124/79/1 → 139/85/1** (total 225).
- **`tests/fixtures/wire-surface.json`** — re-dumped from the built rc.2 checkout (`node scripts/dump-wire-surface.mjs --checkout E:\code\deepseek-harness-wt-022rc2 --version 0.2.2-rc.2`): 225 methods, `dshVersion: 0.2.2-rc.2`.
- **Test re-pins** — `tests/wire-surface.spec.ts` bucket counters → 139/85 + fallback 225; `tests/capabilities.spec.ts` officeKit spellings + `domains` containment; `tests/remote-guard.spec.ts` officeKit namespace in both owned/foreign cases.
- **`dist/*`** — rebuilt: `index.js`/`.map` re-stamp `WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.2"`; `client.js` **byte-identical** (36443 chars, SHA-256 unchanged) — expected, since the client bundle only encodes the module-loader banner + settings panel.
- **Docs** — this file; README / README.zh status + compatibility history + allow-list numbers; `.claude/rules/changelog.md` + `.claude/rules/gotchas.md` entries.

## 4. Verification

| step | result |
|---|---|
| dependency resolution | clean install after retarget (fresh `npm install`, 113 packages, 11s) — all `@deepseek-ai/dsh-*` at 0.2.2-rc.2, vendor stable 4.1.0/3.19.0/1.1.0/1.1.0 |
| `vitest run` | **22 files / 291 tests green** against the published rc.2 builds (incl. the strict live cross-check of the wire fixture against the rc.2-built harness checkout at 225) |
| `npm run verify:imports` | exit 0 |
| `npm run build` | exit 0; `dist/client.js` byte-identical (SHA-256); `dist/index.js` stamp-only diff |
| **live boot under rc.2** | isolated temp `DSH_HOME` + dev-tree boot of the built rc.2 checkout (`apps/cli/src/bin.ts web`): startup log records `{ id: 'include:dsh-login', module: '@islibaodong/dsh-login', version: '0.3.13', state: 'active', missing: [] }` — the plugin is officially admitted under rc.2 |
| live: login wall | `/` served with both dsh-login index markers; anonymous `/api/auth/capabilities` + `/api/auth/me` → 401 `{"error":"authentication required"}`; `/login` → first-run setup page; setup → owner admin; login/logout round-trip OK |
| live: method wall | owner `capabilities` = **224 methods** (139 + 85; host-internal excluded as always): every rc.2 addition present (`mcpManager.probe`, `account.getNotifications`, `web.listProviders`, `liveshareShares.addSessions`, `officeKit.render`, `agentTeams.setEnabled`, `forgePanel.changeRequestReview`, `workspaceFiles.search`, `terminal.watch`, `subagents.interruptByUser`), every removed method absent (`account.ackBonusNotified`, `account.getUnnotifiedBonuses`, `officeToPdf.render`, `subagents.interruptByParent`, `workspace.initializeDefault`) |
| live: role isolation | created user `alice` (non-admin) via `POST /api/auth/admin/users` → 201; alice's `capabilities` = **exactly 139** (the user bucket); admin methods (`mcpManager.probe`, `account.getNotifications`, `web.listProviders`, `settings.update`, `credentials.set`) all absent; `GET /api/auth/admin/users` as alice → 403 `{"error":"admin required"}` |
| live: session isolation | per-user session attribution live: owner onlineSessions 4, alice 0; `POST /api` is not a JSON dispatch path (carrier dispatch is WS-only via `/api/remote.mux`), answered 401 for both identities — the full per-user dispatch isolation remains covered by the 291-test suite (dispatch-guard/api-bridge-auth/isolation specs) and the deployment-side acceptance checklist |
| cleanup | boot job killed, port released, temp home + tarball removed |

## 5. Wire-surface delta (204 → 225)

**+26 / −5.** Added: `account.getNotifications`, `account.getNotificationContent`, `account.reportNotificationEvent`, `agentTeams.setEnabled`, 12 × `forgePanel.*` (changeRequestCommits/changeRequestReview/changeRequestReviewWrite/changeRequestViewed/diffBases/localCommits/requestReviews/rerunChecks/reviewerCandidates/setFileViewed/updateBranch/worktreeCleanup), `liveshareShares.addSessions`, `mcpManager.probe`, `mcpManager.restart`, `mcpManager.watch`, `officeKit.generation`, `officeKit.render` (rename of `officeToPdf.generation/render`), `subagents.interruptByUser`, `terminal.watch`, `web.listProviders`, `workspaceFiles.search`. Removed: `account.ackBonusNotified`, `account.getUnnotifiedBonuses`, `officeToPdf.generation`, `officeToPdf.render`, `subagents.interruptByParent`.

Classification rationale (verified by reading the controllers/typert d.ts at the rc.2 tag):

- **USER**: `agentTeams.setEnabled` (session-scoped: `agentId: SessionId` first arg, `rootOf` session resolution — `packages/team/agent-team/src/index.ts:112`); the 12 `forgePanel.*` methods (same session-scoped trust shape as the existing forge panel reads); `officeKit.generation/render` (session-scoped rename of `officeToPdf`: `render(workspaceFileScopeId: SessionId, path, priority)`); `subagents.interruptByUser` (the user-axis twin of the already-allowed `interruptByParent`); `terminal.watch` (user already holds `terminal.read/write`); `workspaceFiles.search` (user already holds the read-only `workspaceFiles.list`).
- **ADMIN**: the `account.*` notifications trio (DeepSeek Platform operator data — `packages/credentials/deepseek-account/src/index.ts:257+`; the whole `account.*` namespace was already admin-only); `mcpManager.probe/restart/watch` (host-wide MCP server lifecycle, the "management surface" of `packages/mcp/mcp-manager`); `web.listProviders` (host search/fetch provider registry read — `packages/web/web/src/index.ts:152`; provider selection already lives in admin settings); `liveshareShares.addSessions` (the `liveshareShares.*` namespace is share-management, admin-only as a rule).

The previous watch's drift radar (210 WIP at rc.1) predicted 7 of these; the actual release shipped 26 additions — the radar undercounts by design (it only sees methods added after the last tag), but the strict fixture cross-check is what actually pins the release.

## 6. Multi-user / role verdict

- **No native multi-user accounts at 0.2.2-rc.2.** The recurring `multi.?user|multiuser|role.?based|\brbac\b` grep now yields **7 hits — all documentation** (baseline standing hit `packages/api/remote-access/README.md:2`; new: `docs/api-gateway.md:93`, `docs/capability-seams.md:697`, `docs/ui-design-review-cases.md:59/115/158` + i18n — design-example noise). No password/user store exists (only packaging notarization credentials); the browser path is still single-owner: every browser request maps to the one `{ kind: 'owner' }` Peer (`packages/client/connection/src/rpc-host.ts:94`, `:133-134`).
- **Remote-access role engine unchanged; owner bypass intact** — README: "The owner ({ kind: 'owner' }) is never checked"; `decide()` early-ALLOW for owner (`src/index.ts:202`), `snapshotFor()` `OWNER_BASELINE` (`:255`), `registerPolicy` excludes owner kind. `git diff` of `remote-access` + `webserver` between the tags touches `package.json` only (zod 4.4.3 → 4.6.6).
- **`PrincipalMap` remains merge-extensible** (`packages/typert/protocol/src/types.ts:455-462`) — unchanged rc.1 → rc.2. This confirms the evaluation in [`docs/role-based-ui-gating.md`](role-based-ui-gating.md): a future dsh-login release could declare a `{ kind: 'user', username, role }` principal (mirroring the liveshare share-viewer pattern, `packages/experimental/liveshare/src/host/viewer-principal.ts:14-31`) and register remote-access policies for it, gaining method-level Gateway enforcement plus the `remoteAccess.follow` snapshot stream — a stronger complement to the index-only `uiRoleGate`. Still deferred until there is a driver for it; dsh-login's three in-plugin seams (bridge wall, dispatch-seam guard, boot-graph filter) cover the deployment today.
- **Whole-UI role gating** remains dsh-login's territory: `renderIndex`'s per-peer injection chain is intact, no native account UI appeared, and the client still activates every boot-graph row it receives.

**Conclusion: no new multi-user capability upstream. 0.3.13 is a wire-surface re-pin release onto the 0.2.2-rc.2 line (+26/−5 methods, officeToPdf→officeKit rename, buckets 139/85/1); every seam dsh-login mounts is byte-stable or additive; the plugin is verified admitted and enforcing under the packaged rc.2 runtime.**
