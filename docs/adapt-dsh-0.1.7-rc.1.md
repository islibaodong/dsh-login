# DSH 0.1.7-rc.1 compatibility check (2026-09-24)

Status: **adapted and verified, no release required** — the published
`@islibaodong/dsh-login@0.2.3` already runs on DSH `0.1.7-rc.1` (its peer
ranges admit rc.1 and both of rc.1's new plugin-admission layers pass), so
0.2.3 stays the current release. This repo's devDeps were pinned to
`^0.1.7-rc.1` and the full suite verified against the real rc.1 builds:
**18 files / 207 tests green**, `verify:imports` exit 0, `npm run build`
exit 0 (`dist/client.js` re-stamp byte-identical at 37134 chars).
Previous adaptation: `docs/adapt-dsh-0.1.7.md` (0.1.7-alpha.2 → 0.2.3).

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new **`0.1.7-rc.1`** (2026-09-23T13:25Z) under the **`next`** dist-tag (`alpha` stays at `0.1.7-alpha.2`; `latest` still stale at `0.0.1-rc.1`). Verified across all six peers + `dsh-web-app` + `dsh-invariants` + `dsh-scope`/`dsh-session`/`dsh-brand`/`dsh-agent-preset-registry` (12 packages). |
| Harness checkout (`E:/code/deepseek-harness`) | tag `dsh-v0.1.7-rc.1` (`46a7f68b09`, PR #5073 release merge); **156 commits** since `dsh-v0.1.7-alpha.2`; `origin/master` advanced to the rc.1 tag. |

## 2. Compatibility surface (156 commits, diffed against `dsh-v0.1.7-alpha.2`)

933 files changed (+13851/−3101), but the vast majority are per-package
version-bump lines. Everything the plugin integrates with is **source-unchanged**:

| Integration point | rc.1 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver`, `dsh-host-frontend-static`, `dsh-settings`, `dsh-credentials`, `packages/bundle/web-app` rows, `packages/client/connection` (`connection/request` waterfall), `packages/client/runtime`, `packages/client/ui-slots` | **source unchanged** (version lines only) | **none** — `cordis.patch.yml` applies as-is; the api-bridge-auth wall, gateway fallback seat, and `authorizeIndex` handshake are untouched |
| `packages/api/remotes` (wire catalog) | **type re-export only** (`IncompatiblePlugin` added to the plugin-manager types re-export) — **zero namespace or method changes** in the registry | **none** for enforcement |
| `packages/preset/agent-preset-registry` | **+1 wire method `agentPresets.readDocument`** (`@Remote('read')` — view one declaration's child plugin list as YAML; no UI call site yet) | **advertisement only** (§3) — the namespace is admin-only, so ordinary users are denied by default and admins pass; no allow-list change |
| `packages/api/gateway` (`src/index.ts` ±31, `client/stream-client.ts` ±10) | async-cancellation hygiene: per-read stop promises in the uplink pump / `cancellableStream` / `UplinkDecoder` (fixes stale cancellation races + unhandled rejections); +188 lines of new tests | **none** — internal stream plumbing; the typertGateway service seam (`invoke`/`stream`) the guard wraps is unchanged |
| `packages/api/session-controller/src/client` (`assistant-stream.ts`, `session.ts`) | browser-side stream handling | **none** — the plugin does not bundle the session-controller client |
| `packages/client/ui-*` (chat/tool/primitives/subagent/agent-preset/plugin-manager/…) | functional/cosmetic UI work (markdown image paths, tool call tree, HoverCard/ImagePreview primitives, preset sections, …) | **none** — no runtime activation seam change (§6) |

## 3. NEW upstream mechanism: plugin/bundle compatibility admission (PR #5061)

The one substantive host change — and the reason to understand rc.1 well.
`packages/boot/app-boot` gained `plugin-compatibility.ts` +
`compatibility-preflight.ts` + `profile-compatibility.ts` (~430 lines):

- **What is checked**: each plugin/bundle manifest's `peerDependencies` —
  only keys named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
  (cordis/schemastery are ignored); `workspace:^`/`~`/`*` resolve to the
  running runtime; the test is
  `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
- **Where**: (1) `loadProfileDirectory` now evaluates every
  `dsh.profile.bundles` entry's own peers — an incompatible bundle is
  **reported on stderr and skipped** (its patch layer never loads);
  (2) `prepareProfileEntries` preflights every profile **row** (including
  rows inserted by composed patch layers — that includes dsh-login's own
  `insert:` row from `cordis.patch.yml`) and sets `disabled: true` on an
  incompatible row; a native Include reaching an incompatible plugin is
  denied whole. Agent-preset mounts run the same preflight
  (`mountPreset` → `prepareProfileEntries`).
- **Exemption**: a profile-local `compatibility.json` mapping exact
  `name@version` keys to exact runtime versions; granted via
  `dsh plugin allow-version` (requires `--accept-risk`, grants must name the
  current runtime). Install-time, the plugin manager refuses with a typed
  `incompatible-version` result naming the same command.

**dsh-login verdict under this mechanism**:

- **0.2.3 passes on 0.1.7-rc.1, no change needed.** The six dsh peer ranges
  (`>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 ||
  >=0.1.7-alpha.2 <0.2.0-0`) admit rc.1 — and with
  `includePrerelease: true` the boot check is *more lenient* than npm's
  install-time tuple rule (the first branch alone already admits any
  0.1.x prerelease ≥ alpha.1).
- **Adapted one advertisement line**: `agentPresets.readDocument` added to
  the admin capability advertisement (`src/capabilities.ts`
  `adminOnlyMethods()`), keeping the 0.2.3 discipline that advertised names
  match the real wire surface. Enforcement needed nothing: `agentPresets`
  is already in `ADMIN_ONLY_NAMESPACES` (wire guard) and
  `ADMIN_ONLY_TWO_SEGMENT_DOMAINS` (physical layer), and ordinary users are
  deny-by-default on anything absent from `USER_ALLOWED`.
- **Operational note (fail-open behavior on future incompatibility)**: if a
  future DSH release outpaces the plugin's peer ranges (e.g. 0.2.0+),
  rc.1's admission logic **skips the dsh-login bundle** (stderr diagnostic)
  and disables its row — meaning the web GUI boots **without the login
  wall** (the bundle's `web-runtime` disable patch never applies, so the
  native web runtime starts normally) rather than crashing the boot. npm's
  install-time refusal is the first gate (ERESOLVE on the same peers), so
  this needs an in-place upgrade that bypasses the plugin manager. After
  any DSH upgrade: **check that dsh-login actually loaded** (login page
  appears) before exposing the port.

## 4. Dependency notes

- `peerDependencies` **unchanged** — the `>=0.1.7-alpha.2 <0.2.0-0` branch
  already admits `0.1.7-rc.1` and the future `0.1.7` stable line.
- `devDependencies` bumped to `^0.1.7-rc.1` for all ten `@deepseek-ai/dsh-*`
  packages (six peers + invariants + the transitive
  scope/session/brand exact-pin peers). The incremental `npm install`
  ERESOLVE'd on the stale alpha.2 tree (old `dsh-host-frontend-static`
  exact-pinning `dsh-client-connection@0.1.7-alpha.2`) — fixed by the
  established fresh-reinstall runbook (delete `node_modules` +
  `package-lock.json`, reinstall; exit 0). No new transitive peers appeared
  at rc.1.
- `dist/client.js` re-stamped from the rc.1 `dsh-client-connection`:
  **byte-identical output (37134 chars)** — the connection client is
  source-unchanged between alpha.2 and rc.1.

## 5. Multi-user detection at dsh-v0.1.7-rc.1

**Still NO native multi-user support.** `git grep -ilE
'multi.?user|multiuser|role.?based|\brbac\b' dsh-v0.1.7-rc.1 -- packages/`
→ **0 hits** (156 commits added none); no user/account/auth package appeared
(`identity` remains telemetry ids; the `account` namespace still manages the
single process-wide DeepSeek Platform grant). dsh-login remains the
multi-user layer.

## 6. Role-based whole-UI permission control at dsh-v0.1.7-rc.1

**Still infeasible.** `git grep -ilE
'permission|isAdmin|isAllowed|role' dsh-v0.1.7-rc.1 -- packages/client/runtime/src
packages/client/ui-slots/src` → **0 hits**; both packages are
source-unchanged from alpha.2 (the client runtime still activates every
installed bundle unconditionally, no per-identity slot filter / activation
gate / role concept). rc.1's compatibility machinery (§3) is per-*plugin*
admission (a bundle loads or doesn't), not per-*user* visibility — it
cannot express role-based UI control. Upstream asks remain as recorded in
`docs/adapt-dsh-0.1.6.md` §6.

## 7. Verification

- Full vitest suite **18 files / 207 tests green** (5.74s) against the
  published `0.1.7-rc.1` builds (all ten `@deepseek-ai/dsh-*` devDeps at
  real rc.1; verified via each package.json version).
- `npm run build` exit 0; `npm run verify:imports` exit 0.
- **No release cut**: zero production-code changes (devDeps + one
  advertisement line + docs only), and the already-published 0.2.3 is
  compatible with rc.1 (peer ranges + both admission layers pass).
  0.2.3 remains `latest` on npmjs.
