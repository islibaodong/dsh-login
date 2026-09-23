# DSH 0.1.7-alpha.2 compatibility adaptation (2026-09-23)

Status: **adapted and verified** — dsh-login 0.2.3 runs against DSH
0.1.7-alpha.2 (published npm builds), full suite green **18 files / 207
tests** (203 carried over + 4 new 0.1.7 regression tests), `verify:imports`
exit 0, `npm run build` green. Previous adaptation:
`docs/adapt-dsh-0.1.6-alpha.2.md` (0.1.6-alpha.2 → 0.2.2).

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new `0.1.7-alpha.1` (2026-09-22T06:10Z) and `0.1.7-alpha.2` (2026-09-22T15:54Z) under the **`alpha`** dist-tag (`latest` remains stale at `0.0.1-rc.1`; `next` moved to `0.1.5-rc.3` — install with `@alpha` or an exact version). Verified across all six peers + `dsh-web-app` + `dsh-invariants`. |
| Harness checkout (`E:/code/deepseek-harness`) | tags `dsh-v0.1.7-alpha.1` (`c36a83ff6b`, PR #4901) and `dsh-v0.1.7-alpha.2` (`00102833df`, PR #4978); **1461 commits** since `dsh-v0.1.6-alpha.2`; `origin/master` == the alpha.2 tag. Vendored toolchain bumped in the release: **cordis 4.0.4, schemastery 3.18.4, plugin-include 1.0.9, plugin-loader 1.0.5**. |

## 2. Compatibility surface (what changed that could affect dsh-login)

Diffed every option-A integration point between `dsh-v0.1.6-alpha.2` and
`dsh-v0.1.7-alpha.2`:

| Integration point | 0.1.7 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver` (fallback seat, `renderIndex`, `webserver/index-inject`, route precedence) | gzip compresses `multipart/form-data`; type cast cleanup. `index-inject` emit unchanged | **none** |
| `dsh-host-frontend-static` (6-arg `serveStatic` + `authorizeIndex`) | injected `<base href="/">` → `<base href="./">` (sub-path mountable SPA) | **none** — dsh-login's gateway forwards to `serveStatic` unchanged |
| `packages/bundle/web-app/src/index.ts` (cordis rows) | **source unchanged** — `web-runtime` + `connection` rows exactly as 0.1.6 (+772/−136 elsewhere in the package) | **none** — the shipped `cordis.patch.yml` applies as-is |
| `dsh-credentials` | main package split into subpackages (`credentials/`, `credentials-local/`, `authorization/`, `deepseek-account/`, `deepseek-account-platform/`); **`credentialRef` + `CredentialProvider`/`CredentialRef` types unchanged** in the main entry | **none** — `src/index.ts`/`src/users.ts` imports keep working |
| `dsh-settings` | **full rewrite**: the settings *provider* service became `SettingsForms extends Service` (config-schema projection over Cordis profile patches). **`ctx.settings` service name survives** and `update(ns, patch)` keeps merge-patch semantics; the `SettingsProvider` type export is gone; `settingsNamespace` moved to the wire layer | **adapted**: `remote-web-ui-compat.ts` drops the upstream type import for a local structural `SettingsWriteSeam` (§3); runtime `ctx.settings.update` call unchanged |
| `packages/client/connection` | `connection/request` waterfall **survives** (now emitted on `webCtx.waterfall`, string-first args — the api-bridge-auth seam is intact); `browser-auth.ts`: `authenticatedUrl` preserves the caller's path/mount (paired with the `<base href="./">` change), 303 redirect `/` → `./`; client rpc/host-rpc growth | **none** for the wall (event name + veto semantics unchanged); cookie/session mechanics unchanged |
| `packages/api/remotes` (wire catalog) | += `accountRemote` (**new namespace `account`**), `jobRemote` (**new namespace `job`**; `SessionJob` moved out of `session`), `pluginRegistryProbeRemote` (bundled plugin-manager UI probe); `agentPresets` **package renamed** to `dsh-agent-preset-registry` but the **wire namespace stays `agentPresets`**; `SessionJob as JobView` re-export removed | **adapted**: allow-list/guard updates (§4) |
| `packages/api/settings-controller` | methods now `describe` / `update` / `replace`; **`canOpenAgentPresetDirectory` removed** (moved to the preset-registry package) | **adapted**: admin advertisement corrected to the exact wire names (§4) |
| `packages/api/account-controller` (**new namespace `account`**) | `getState`/`getProfile`/`getBalance` (read projections), **`startSignIn`/`cancelSignIn`/`signOut`** (browser sign-in/cancel/revoke of the process-wide upstream DeepSeek Platform grant), `watch` (stream) | **adapted**: strictly admin-only (§4) — startSignIn/signOut rebind or revoke THE instance's upstream account; even the read projections expose the operator's profile and recharge-wallet balance |
| `packages/api/job-controller` (**new namespace `job`**) | `list` (stream), `follow` (stream), `kill` — every request carries `sessionId` (`follow` omits it only for unowned jobs, which any caller may observe) | **adapted**: ordinary-user surface (§4) — same trust boundary as `session.prompt`, ownership-checked via `GUARDED_ID_FIELDS` |
| `packages/api/workspace-controller` | **+`pinSession` / `unpinSession`** (sidebar session pinning) | **adapted**: ordinary-user surface (§4) |
| `packages/api/session-controller` / `terminal-controller` (incl. `terminal.retain`) / `workspace-files` / `subagent` / `goal` / `skill` / `llm` / `file-upload` / `interaction` | wire methods **unchanged** (subagent only dropped an internal `validateControlRequest` never on the user surface) | **none** |
| `packages/client/runtime` | **NO CHANGES** — still activates every installed bundle unconditionally; no identity gate | role-based whole-UI verdict unchanged (§6) |
| `packages/client/ui-slots` | ±5 lines; `renderFactorySlot()` still takes no Session identity | role-based whole-UI verdict unchanged (§6) |
| `packages/identity` | still anonymous telemetry ids only | multi-user verdict unchanged (§5) |

## 3. Adaptation: `dsh-settings` type decoupling

`@deepseek-ai/dsh-settings` was rewritten; the `SettingsProvider` type export
the plugin's `remote-web-ui-compat.ts` used is gone. Runtime analysis of the
new `SettingsForms` service confirmed:

- the service is still mounted as **`ctx.settings`** (`packages/settings/
  settings/src/index.ts` declares `settings: SettingsForms` and default-exports
  the class);
- `async update(ns: string, patch: object, expectedRevision?)` still exists
  with **merge-patch semantics** (`mergeLayers`) — exactly what the
  remote-web-ui compat write (`{ enabled, requirePairingForLan,
  publicBaseUrl? }` into namespace `remote-web-ui`) needs.

Fix: the module no longer imports upstream types. It declares a local
structural seam (`SettingsWriteSeam { update(namespace, patch): Promise<void> }`)
and `RemoteWebUiCompatDeps.getSettings` returns `Pick<SettingsWriteSeam,
'update'>`. The runtime call path and the graceful
`skipped`/`unregistered` outcomes are unchanged, and future upstream type
churn cannot break the plugin build again.

## 4. Adaptation: permission surface updates (0.1.7 additions)

All in the ordinary-user allow-list (`USER_ALLOWED`, `src/api-filter.ts`), the
guard (`src/remote-guard.ts`), and capability discovery/quiet-denial
(`src/capabilities.ts`):

1. **Ordinary users gain** (with the ownership guard intact):
   - `job.list`, `job.follow`, `job.kill` — the job controller is the user's
     own session-jobs surface (kill is the human stop button); every request
     carries `sessionId`, checked through the guard's `GUARDED_ID_FIELDS`.
     `jobId` is deliberately **not** added to the guarded fields: job ids are
     not in the ownership sidecar and every collected id must resolve owned,
     which would deny legitimate kills. `USER_DOMAINS` += `job`.
   - `workspace.pinSession`, `workspace.unpinSession` — sidebar session
     pinning; workspace/session ids already guarded.
2. **`account` is strictly admin-only** (three layers):
   - absent from `USER_ALLOWED` → the wire guard denies ordinary users;
   - `ADMIN_ONLY_NAMESPACES` (`remote-guard.ts`) += `account`;
   - `ADMIN_ONLY_TWO_SEGMENT_DOMAINS` (`capabilities.ts`) += `account`
     (two-segment `/api/account/*` probes: quiet 204 reads, loud 403 writes);
   - `QUIET_DENY_METHODS` += `account.getState/getProfile/getBalance/watch`
     (the GUI's account page probes at boot — read projections deny quietly;
     writes stay loud 403);
   - the admin capability advertisement lists the exact methods
     (`account.getState/getProfile/getBalance/startSignIn/cancelSignIn/
     signOut/watch`) and the `account` domain.
3. **Advertisement corrections**: admin-only methods now name the real
   settings wire methods (`settings.describe/update/replace` — the old
   `settings.list`/`settings.reset` never existed on the wire), and the new
   `pluginRegistryProbe` probe is advertised admin-only alongside
   `pluginManager`.

Regression tests (4 new): `tests/remote-guard.spec.ts` grants job + pinning
scoped to owned sessions (foreign sessionId denied) and denies the whole
`account` namespace for ordinary users while admins pass;
`tests/capabilities.spec.ts` asserts the 0.1.7 user additions and the
three-layer admin-only posture for `account`.

## 5. Multi-user detection at dsh-v0.1.7-alpha.2

**Still NO native multi-user support.** `git grep -ilE
'multi.?user|multiuser|role.?based|\brbac\b' dsh-v0.1.7-alpha.2 -- packages/`
→ **0 hits**; the package listing has no user/account/auth package
(`identity` remains anonymous telemetry correlation ids). The new `account`
namespace actually reinforces the single-operator model: it manages the ONE
process-wide upstream DeepSeek Platform grant (sign-in/sign-out/balance), not
per-user accounts. dsh-login remains the multi-user layer.

## 6. Role-based whole-UI permission control at dsh-v0.1.7-alpha.2

**Still infeasible.** `git grep -ilE 'permission\|isAdmin\|isAllowed\|role'
dsh-v0.1.7-alpha.2 -- packages/client/runtime/src packages/client/ui-slots/src`
→ **0 hits**; `packages/client/runtime` is byte-for-byte unchanged from 0.1.6
(client runtime still activates every bundle unconditionally, no
per-identity slot filter / activation gate / role concept), and ui-slots'
README still states `renderFactorySlot()` accepts no Session identity. The
`permission-presets` package (packages/interaction/permission-presets) is a
red herring for RBAC: it offers named **Agent execution** permission modes
(sandbox × approval-policy presets per session), not user-account roles.
Upstream asks remain as recorded in `docs/adapt-dsh-0.1.6.md` §6. Meanwhile
dsh-login's API layer stays role-aware (the §4 updates above), and the whole-UI
visibility gap remains the one thing only upstream can close.

## 7. Dependency / packaging notes

- `peerDependencies` retargeted per the tuple convention: all six `dsh-*`
  peers now read `>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 ||
  >=0.1.7-alpha.2 <0.2.0-0` (0.1.7 prereleases/stable admitted from alpha.2 —
  the verified floor; future `0.1.8-alpha.x` excluded). node-semver's
  prerelease rule makes the new branch mandatory: `0.1.7-alpha.2` does not
  satisfy the old `>=0.1.6-alpha.1` comparator (tuple mismatch), which is why
  the first `npm i` attempts ERESOLVE'd before the retarget.
- `devDependencies` pinned to the real release: six peers + `dsh-invariants`
  at `^0.1.7-alpha.2`, **new transitive peers** `dsh-scope` /
  `dsh-session` / `dsh-brand` at `^0.1.7-alpha.2` (`dsh-client-connection`
  peers on them with exact pins — leaving them out also ERESOLVEs), cordis
  `^4.0.4`, schemastery `^3.18.4`, plugin-include `^1.0.9`, plugin-loader
  `^1.0.5`. `package-lock.json` regenerated by a clean reinstall.
- `dist/client.js` regenerated from the 0.1.7 `dsh-client-connection`
  (37134 chars; the re-stamp banner matched — `scripts/build-client.mjs`
  fails loudly otherwise).
- Verification: full vitest suite **18 files / 207 tests green** against the
  published 0.1.7-alpha.2 builds; `verify:imports` exit 0; `npm run build`
  exit 0. Publish needs the user (`npm stage publish` + npmjs 2FA approval).
