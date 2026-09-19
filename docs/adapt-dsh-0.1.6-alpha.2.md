# DSH 0.1.6-alpha.2 compatibility adaptation (2026-09-18)

Status: **adapted and verified** — dsh-login 0.2.2 runs against DSH
0.1.6-alpha.2 (published npm builds), full suite green **18 files / 203
tests**, `verify:imports` exit 0, `npm run build` green. Previous adaptation:
`docs/adapt-dsh-0.1.6.md` (0.1.6-alpha.1 → 0.2.1).

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new `0.1.6-alpha.2` under the **`alpha`** dist-tag (`latest` remains stale at `0.0.1-rc.x`, `next` at `0.1.5-rc.2` — install with `@alpha` or an exact version). Verified across `dsh-host-webserver`, `dsh-client-connection`, `dsh-web-frontend`, `dsh-settings`, `dsh-credentials`, `dsh-host-frontend-static`. |
| Harness checkout (`E:/code/deepseek-harness`) | tag `dsh-v0.1.6-alpha.2` (commit `ddefc45fbc`); several hundred commits since `dsh-v0.1.6-alpha.1` (large feature branches merged: plugin management UI, desktop thin shell, Office pipeline, sidebar browser, user-terminal permissions). |

## 2. Compatibility surface (what changed that could affect dsh-login)

Diffed every option-A integration point between the tags:

| Integration point | 0.1.6-alpha.2 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver` (fallback seat, `renderIndex`, `webserver/index-inject`, route precedence) | **source unchanged** | none |
| `dsh-host-frontend-static` (6-arg `serveStatic` with `authorizeIndex`) | **source unchanged** | none |
| `dsh-settings` / `dsh-credentials` | **source unchanged** | none |
| `packages/bundle/web-app/cordis.patch.yml` | rows +`office-to-pdf`, +`ui-sidebar-browser`, +`ui-plugin-manager`, +`workspace-changes`, −`tool-plugin-manager` disabled entry added; **`web-runtime` and `connection` rows untouched** | **none** — dsh-login's shipped `cordis.patch.yml` applies as-is |
| `packages/client/connection` | **NEW `connection/request` waterfall** on the shared `/api` route (see §3); client gains optional `__DSH_TRANSPORT__.streamBaseUrl` hook (host-shell only; served pages never carry it) | **adapted**: the /api bridge auth wall (§3) |
| `packages/api/gateway` | client-side strict-input rework (`requireStrictInputs`, schema `create()` on the host), remote-events additions | none — the host `typertGateway.invoke/stream` dispatch surface dsh-login wraps is unchanged |
| `packages/api/remotes` | remote catalog += `pluginManagerRemote`, `officeToPdfRemote`; forwarded events += `plugin-manager/changed|install-log|install-state` | **adapted**: allow-list/guard updates (§4) |
| `packages/api/terminal-controller` | **new wire method `terminal.retain`** (stream, explicit `sessionId`); terminals now run with the execution environment's **system-user permissions** (no Agent sandbox/approval) | **adapted**: `USER_ALLOWED` += `terminal.retain`; posture note in §4 |
| `packages/api/session-controller` | no new/renamed wire methods (`updateQueue` now async internally; new error code) | none |
| `packages/api/workspace-files` | `readAll` bounds reworked internally | none (surface already covered — see §4) |
| `packages/document/office-to-pdf` (**new wire namespace `officeToPdf`**) | `render` (scoped session identity on the wire as `workspaceFileScopeId`) + `generation`; document-preview conversion | **adapted**: `USER_ALLOWED`/`USER_DOMAINS` += the read surface (§4) |
| `packages/boot/plugin-manager` (**new wire namespace `pluginManager`**) | installs/enables/disables/removes profile bundles | **adapted**: strictly admin-only (§4) |
| `packages/client/ui-slots` | +Component Factories (`SlotFactoryMap`, `registerFactory`, `renderFactorySlot`, `useFactorySlot`) — a reusability feature; README: "`renderFactorySlot()` does not accept a Session identity"; **still no per-identity slot filter / activation gate / role concept** | none for composition; role-based whole-UI verdict unchanged (§6) |
| `packages/client/modules` (client runtime) | still activates every installed bundle; no identity gate | role-based whole-UI verdict unchanged (§6) |
| `packages/identity` | anonymous telemetry ids only | multi-user verdict unchanged (§5) |

## 3. Adaptation highlight: the `/api` bridge auth wall (`connection/request`)

Under option A the native `connection` row owns `/api` and fences it with
(1) the Host/Origin trust fence and (2) a **process-wide browser-auth cookie**
that every logged-in dsh-login user receives via `authorizeIndex` when the SPA
index is served. That cookie outlives a dsh-login logout, so the only per-user
boundary on /api was the composition-only remote guard.

alpha.2's `connection/request` waterfall runs on that shared bridge *before*
the native bridge ("admit or wrap an authenticated shared API request,
including body transfer… a listener that does not call `next()` vetoes the
rest of the chain"). dsh-login 0.2.2 registers a wall there
(`src/api-bridge-auth.ts`, config **`apiBridgeAuth`**, default **true**):

- a request with a valid `dsh_session` cookie is admitted (`next()`);
- anything else answers **401** and vetoes the bridge — logout/expiry/revocation
  now actually cut /api access, and every bridged call requires a dsh-login
  identity instead of riding the shared browser-auth cookie.

Cordis mechanics (verified in `@deepseek-ai/cordis@4.0.1`): all listeners share
one registry (the root context's `EventsService`, prototypally inherited), and
the emit site `webCtx.waterfall('connection/request', req, res, () => bridge(…))`
passes a string first argument, so no dispatch filter applies — a listener
registered in dsh-login's fiber receives it; `{ global: true }` is added for
robustness against future emit-site changes. On DSH < 0.1.6-alpha.2 the event
never fires and the wall is a harmless no-op (0.2.1 behavior), so the
0.1.5-alpha.1 peer branch keeps working.

Deliberately unchanged boundaries (verified against the 0.3.23 remote-web-ui
build):

- The upstream fence still runs first (untrusted Host → 403 before the wall).
- Plugin-exact webServer routes never reach the bridge: dsh-login's
  `/api/auth/*`, remote-web-ui's `/api/pair/*` (pre-login pairing) are exact
  routes served directly by their owners.
- The Remote stream mux WebSocket upgrade goes through
  `webServer.registerUpgrade` with its own `requestRejection` fence only —
  there is no per-request hook for dsh-login there (upstream gap, documented).
- Third-party plugins that register their own exact `/api/...` webServer
  routes bypass the bridge (the 2026-08-28 boundary note) — unchanged.

Deployment note: remote-web-ui's `/remote` paired-device channel re-issues
requests server-side to loopback **without** the `dsh_session` cookie (it
attaches only its inner browser-auth credential). That is by design a
full-control credential outside dsh-login's user model, so with
`apiBridgeAuth` on (default) a paired device gets 401 on bridged calls — an
auth bypass around dsh-login's roles is closed. Deployments that want the
paired-device channel open despite this should set `apiBridgeAuth: false`
(and understand pairing then replaces the login wall on /api).

## 4. Permission-surface updates (allow-list, guard, capabilities)

- `src/api-filter.ts` `USER_ALLOWED` +=
  `terminal.retain` (alpha.2 retention; explicit `sessionId`, ownership-guarded)
  and the document-preview read surface: `workspaceFiles.read|readAll|readBytes|readRelated|stat|list|changes`
  + `officeToPdf.render|generation` — every call's first wire argument is the
  scoped session identity (`workspaceFileScopeId`, confirmed from the generated
  typert descriptors), which the guard ownership-checks.
- `src/remote-guard.ts`: `ADMIN_ONLY_NAMESPACES` += `pluginManager`
  (installs/removes bundles — never ordinary-user reachable);
  `GUARDED_ID_FIELDS` += `workspaceFileScopeId`.
- `src/capabilities.ts`: `USER_DOMAINS` += `workspaceFiles`, `officeToPdf`;
  admin advertisement gains the `pluginManager` domain + methods.
- Terminal posture note: since alpha.2 user terminals run with the execution
  environment's **system-user permissions** (upstream "give user terminals
  system-user permissions"), `terminal.*` in the ordinary surface is a stronger
  grant than it was at alpha.1 (where terminals were sandbox-adjacent).
  Deployments wanting a stricter posture subtract the `terminal.*` entries from
  `USER_ALLOWED` before wrapping the guard (the capability advertisement
  derives from the same list, so the sidebar terminal then quietly disappears
  for those users).

## 5. Multi-user support in DSH 0.1.6-alpha.2 — detection result

**Still NO native multi-user support** (unchanged from 0.1.6-alpha.1):

- `git grep -iE 'multi-user|multiuser|role-based|rbac'` over `packages/` +
  `apps/` at the tag: zero relevant hits (only false positives such as
  `DebuggerBackend`).
- No accounts/user-management/RBAC host packages; `packages/identity` remains
  anonymous telemetry correlation ids.
- The browser-auth model remains one process-wide browser session
  (`dsh-client-connection`) — single-tenant transport; dsh-login remains the
  multi-user layer. The new `connection/request` hook strengthens (not
  replaces) that: it lets dsh-login make its per-user sessions authoritative
  on the shared bridge.

## 6. Role-based whole-UI permission control — feasibility at 0.1.6-alpha.2

**Verdict: still not implementable cleanly for third-party UI; unchanged from
0.1.6-alpha.1 in kind.**

- The ui-slots work in alpha.2 (Component Factories, +522 lines) is about
  reusable assemblies with caller-selected local components. The README is
  explicit that a factory occurrence "inherits its render-position scope" and
  "`renderFactorySlot()` does not accept a Session identity" — no per-identity
  filter, no activation gate, no role concept was added.
- The client runtime still activates every installed bundle with no
  identity-aware gate, so third-party plugin boot fetches cannot be pruned by
  role.
- What dsh-login can do (and 0.2.2 does): capability discovery
  (`window.__DSH_SESSION__` + `GET /api/auth/capabilities`), its own
  two-segment settings surface, the remote-guard as API-layer role
  enforcement when composed, and — new in 0.2.2 — the /api bridge wall, which
  makes the **API layer** role-aware (a paired device / stale cookie can no
  longer reach the bridge without a dsh-login identity). Whole-UI *visibility*
  control still requires one of the upstream asks recorded in
  `docs/adapt-dsh-0.1.6.md` §6 (per-identity slot filter, activation gate, or
  host-side role metadata on bundle rows); none landed in alpha.2.

## 7. Changes shipped in 0.2.2

- `package.json`: version `0.2.1 → 0.2.2`; devDependencies upgraded to
  `^0.1.6-alpha.2` (suite exercises the published alpha.2 builds). peerDependencies
  unchanged — verified with node-semver that the shipped range
  `>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0` already admits
  `0.1.6-alpha.2` (same `[0,1,6]` tuple) and still excludes `0.1.7-alpha.1`.
- `src/api-bridge-auth.ts` (new) + `src/index.ts` wiring + `src/config.ts`
  `apiBridgeAuth` (default true): the /api bridge wall (§3).
- `src/api-filter.ts` / `src/remote-guard.ts` / `src/capabilities.ts`: §4.
- `dist/index.js` + `dist/client.js` rebuilt (`npm run build`; client.js
  re-stamped from the alpha.2 connection client).
- Tests: `tests/api-bridge-auth.spec.ts` (new: wall unit + full-composition
  admit/veto/logout/config-off), `tests/capabilities.spec.ts` (+2),
  `tests/remote-guard.spec.ts` (+2). Suite: **18 files / 203 tests green**
  against the published 0.1.6-alpha.2 builds; `verify:imports` exit 0.

## 8. Publish record (executed 2026-09-19)

**Published: `@islibaodong/dsh-login@0.2.2` is LIVE on npmjs** (`latest = 0.2.2`,
verified via `npm view dist-tags` against the official registry). Tarball:
31 files / 144.4 kB, shasum `3e7f02a2c836f5965853e1a2548ef2a984972ac5`.

Path (same runbook as 0.2.0/0.2.1): the `~/.npmrc` token left by the 0.2.1
login had been revoked (whoami E401) → fresh **web login** in an interactive
terminal window (`npm login --auth-type=web --registry=https://registry.npmjs.org`,
user approved in browser; non-TTY would get the redacted URL) →
`npm stage publish ./ --registry=…` → stage id
`3c59197f-1271-4c3f-872b-6a59a1d5ce05` (prepack rebuild ran; staged with tag
`latest`) → `npm stage approve <id>` in an interactive terminal window
(`Start-Process powershell`) → user approved the 2FA prompt in the browser →
registry dist-tags polled until `latest` flipped to `0.2.2`.

Hygiene: the web login writes a fresh `//registry.npmjs.org/:_authToken` into
`~/.npmrc` — revoke it on npmjs.com if the machine is shared.
