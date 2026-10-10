# DSH 0.2.1-alpha.2 compatibility check (2026-10-10)

Status: **adapted and RELEASED as `@islibaodong/dsh-login@0.3.2`** (npm latest;
git tag `v0.3.2` + master pushed). DSH 0.2.1-alpha.2 (published 2026-10-09,
first 0.2.1-tuple publish since alpha.1) adds TLS to the webserver, reworks the
LAN/trust plumbing around a new `webStartup` service, and **retires the
`webRuntime` service upstream** — which dsh-login re-provides when
`takeOverWebRuntime` is on. The retake is compat-only (nothing upstream
consumes `webRuntime` anymore), the peer ranges already admitted alpha.2, and
no new wire methods/namespaces landed. Suite **19 files / 247 tests green** on
real 0.2.1-alpha.2 builds. Previous adaptation:
`docs/adapt-dsh-0.2.1-alpha.1.md`.

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-web-frontend` dist-tags | new **`0.2.1-alpha.2`** under the **`alpha`** tag (published 2026-10-09T08:17Z); `latest` = `0.0.1-rc.5`, `next` = `0.2.0-rc.2` unchanged. Vendored `@deepseek-ai/cordis` (4.0.5-alpha.1) and `@deepseek-ai/schemastery` (3.18.5-alpha.1) **not re-published** — dist-tag `dsh-0-2-1-alpha-1` still points at the same versions. |
| Harness checkout | tag `dsh-v0.2.1-alpha.2`; `origin/master` = `d743267388` (release merge, PR #5946); **669 commits** since `dsh-v0.2.1-alpha.1` (diff 1964 files, +51881/−16126). TLS-EOF fetch flake once again needed one retry. |
| dsh-login base | `0.3.1` tree, clean. |

## 2. Compatibility surface (669 commits, diffed against `dsh-v0.2.1-alpha.1`)

Release theme: **HTTPS + trust rework**. The webserver gains TLS
(`Config.tls {certFile, keyFile}` → `createSecureServer`, new
`get protocol(): 'http:' | 'https:'`, deps `ipaddr.js`/`negotiator`), and the
connection row's trust authorities move from the `webRuntime` service to the
new `webStartup` service. The `webserver.host` schema now accepts **concrete IP
literals only** — wildcard (`0.0.0.0`/`::`) binds are rejected at schema load
(in alpha.1 they were already CLI-rejected) — and the URL line spells the bind
address instead of always `127.0.0.1`.

| Integration point | 0.2.1-alpha.2 change | Impact on dsh-login |
|---|---|---|
| `packages/bundle/web-app` | **`webRuntime` service REMOVED** (`resolveLanTrust`/`WebRuntimeValues` deleted); web-runtime row config = `{openBrowser, printUrl, publicUrl, surfaceContext}`; connection row now `inject: [webStartup]` with `trustedHosts: !!js ctx.webStartup.trustedHosts`; webserver row gains `tls: !!js ctx.webStartup.tls`; tool-ralph row dropped from the patch | dsh-login's `takeOverWebRuntime` re-provide of `webRuntime` is now **compat-only** — no upstream consumer. Kept for backward compatibility with older harness versions and any deployment row that still injects it. The shipped `cordis.patch.yml` still disables the web-runtime row and asserts unchanged (`tests/integration-runner.mjs:554` checks `takeOverWebRuntime === true`) |
| `packages/client/connection/src` | `BrowserAuth.authorizeIndex(req, res, secure = false)` / `isAuthenticated(request, secure = false)` gain an optional trailing `secure` param (HTTPS mints origin-spelled + Secure cookies); `requestRejection` reads bindHost/protocol from `ctx.get('webServer')`; new required `HostConnectionHandle` member `allowsRemoteAuthorities` | **No dsh-login change needed**: `HostConnectionService.authorizeIndex` is still 2-arg and computes `secure` internally from `webServer.protocol`; the 1-arg `isAuthenticated` call in `src/gateway.ts:85` stays assignable (extra optional params), and dsh-login never calls `BrowserAuth.authorizeIndex` directly. dsh-login consumes `connection` as a structural `ConnectionAuth` — the new interface member affects implementers only |
| `packages/host/webserver/src` | TLS + concrete-IP-literal-only `host` schema (wildcard rejected at load) | dsh-login's `resolveLanTrust` 0.0.0.0 branch can no longer trigger on alpha.2 — LAN-literal capture is obsolete-but-harmless (kept: older harness versions can still bind `0.0.0.0`, and the code self-disables on concrete binds) |
| `packages/api/*` | **No new wire methods or namespaces** — the only registry-adjacent addition is the new RemoteError code `'session/migration-required'`; session-controller gains a session-format migration flow (fork/projections gate on `formatStatus === 'migration-required'`), terminal-controller injects `workingDirectory` | `src/capabilities.ts` allow-lists unchanged (method gate is name-based; an error code is not a method). Workspace-controller source untouched — `pinSession`/`unpinSession`/`initializeDefault` still `USER_ALLOWED` |
| `packages/client/modules`, `packages/client/ui-slots` | **src unchanged** | Boot-graph lever intact (`packages/client/modules/src/index.ts:585` still pushes the `__DSH_BOOT__` global row) — `uiRoleGate` (0.3.0) unaffected |
| `@deepseek-ai/dsh-web-frontend@0.2.1-alpha.2` | version bump + devDep churn; exports map still `./dist/*` → `./dist/*` | `resolveDistIndex()` (`require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')`) unaffected |

## 3. Changes shipped (0.3.2)

- **`package.json` version** `0.3.1` → `0.3.2`.
- **devDependencies**: the 10 dsh packages → `^0.2.1-alpha.2` (test-time
  runtime alignment; the peer tuple `>=0.2.1-alpha.1 <0.3.0-0` already admits
  alpha.2, so no peer retarget). cordis/schemastery/vendor pins unchanged —
  the vendored alphas were not re-published.
- **`src/web-runtime.ts`**: the `dsh web:` URL line and the `DSH_WEB_URL`
  shell variable now spell the **actual bind address** (`webServer.host`)
  instead of hardcoded `127.0.0.1`, mirroring upstream web-app's new
  bind-address URL. A `0.0.0.0` bind (only possible on pre-alpha.2 harness)
  still falls back to loopback with the LAN suffix.
- **No other `src/` change** — gateway/auth call shapes are structurally
  compatible (§2), and the webRuntime takeover is deliberately kept.

## 4. Verification (against real 0.2.1-alpha.2 builds from npm)

- `npm install` clean **only after** deleting `node_modules` +
  `package-lock.json` (the stale-tree ERESOLVE wedge, recurring).
- `npm test`: **19 files / 247 tests passed** (7.02 s) on the published
  0.2.1-alpha.2 packages.
- `npm run verify:imports`: every `src/*.ts` ok.
- `npm run build`: exit 0.

## 5. Multi-user / role verdict at 0.2.1-alpha.2 (git grep at the tag)

- `multi.?user|multiuser|role.?based|\brbac\b` over `packages` + `apps`:
  **0 hits**. Upstream still ships **no native multi-user support**.
- `__DSH_BOOT__` boot-graph lever intact — `uiRoleGate` (0.3.0) + the 0.3.1
  bridge-wall enforcement remain the role-UI mechanism; nothing new to
  assess this release.
