# DSH 0.1.6-alpha.1 compatibility adaptation (2026-09-17)

Status: **adapted and verified** — dsh-login 0.2.1 runs against DSH 0.1.6-alpha.1
(published npm builds), full suite green 17 files / 192 tests, `verify:imports`
exit 0, `npm run build` green.

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh-*` | new `0.1.6-alpha.1` under the **`alpha`** dist-tag (the `latest` tag is stale at `0.0.1-rc.x`; `next` sits at `0.1.5-rc.2` — install with `@alpha` or an exact version) |
| Harness checkout (`E:/code/deepseek-harness`) | tag `dsh-v0.1.6-alpha.1` (release commit `ea53423b60`, PR #4171), worktree at `0d1f50007f` = tag + 5 perf commits (generated-schema materialization, deferred optional native deps, caller-relative lazy require, deferred client combo assembly) |
| Line size | 800 commits between `dsh-v0.1.5-rc.2` and `dsh-v0.1.6-alpha.1` |

## 2. Compatibility surface (what could have broken dsh-login)

Diffed every option-A integration point between the tags:

| Integration point | 0.1.6 change | Impact on dsh-login |
|---|---|---|
| `dsh-host-webserver` (fallback seat, `renderIndex`, `webserver/index-inject`, route precedence) | **source unchanged** (README/tests only) | none |
| `dsh-host-frontend-static` (6-arg `serveStatic` with `authorizeIndex`) | **source unchanged** | none |
| `dsh-settings` / `dsh-credentials` (string namespaces, credential refs) | **source unchanged** | none |
| `packages/api/session-controller` | fork cut-point fix + `SkillEntry.path` field (additive type); **no new/renamed wire methods** | none |
| `packages/api/workspace-controller` | **new wire method `workspace.unarchiveSession`** (0.1.6 unarchive-sessions feature) | adapted: added to `USER_ALLOWED` (pairs with the already-allowed `workspace.archiveSession`) |
| `packages/api/terminal-controller` (**new package**, web-app rows `terminal-controller` + `ui-sidebar-terminal`) | new typert namespace **`terminal`** with 9 agent-scoped methods: `environment`, `shells`, `list`, `create`, `follow` (stream), `write`, `resize`, `rename`, `close` | adapted: methods added to `USER_ALLOWED`, `terminal` added to `USER_DOMAINS` (see §4 for the trust rationale) |
| `packages/client/connection` (BrowserAuth) | client rework + removal of the 4037-line client fixture; the host half is unchanged | none — under option A the shipped `connection` row owns `/api` and its browser half self-consistently |
| `packages/bundle/web-app/cordis.patch.yml` | rows changed: +`terminal-controller`, +`ui-sidebar-terminal`, +`ui-settings-unarchive-sessions`, −`code-runtime`, `workflow-worker-thread`→`workflow-ptc` | **none** — the rows dsh-login patches (`web-runtime` disable, `connection` keep-enabled, `dsh-login` insert) are all still present and untouched, so the shipped `cordis.patch.yml` applies as-is |
| `packages/client/ui-slots` / `ui-settings` / locale (client inject list) | README/version only | none — `dsh.client.inject` unchanged |

Local-environment incident worth recording: the working tree's
`node_modules/@deepseek-ai/*` had previously been hand-advanced beyond the
lockfile (verified-green at 0.2.0 time); an `npm install` on 2026-09-14 reset
them to the lockfile's `0.1.1-rc.2` builds, whose 5-arg `serveStatic` turned the
plugin's `authorizeIndex` callback into the `renderIndex` slot — 4 failures
(gateway static/index specs + one full-composition boot). Re-pinning the
devDependencies to the real `0.1.6-alpha.1` tarballs fixed resolution **and**
made the suite exercise the new release for real.

## 3. Changes shipped in 0.2.1

- `package.json`: version `0.2.0 → 0.2.1`; peerDependencies retargeted to
  `>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0` for all six
  `@deepseek-ai/dsh-*` peers (same semver-prerelease convention as 0.2.0: the
  `>=0.1.6-alpha.1` comparator carries tuple `[0,1,6]`, so every 0.1.6
  prerelease/stable satisfies, while a future `0.1.7-alpha.x` — tuple `[0,1,7]`
  — is excluded until its own floor is added). devDependencies upgraded to
  `^0.1.6-alpha.1` (tarballs exclude devDeps; lockfile updated by npm).
- `src/api-filter.ts`: `USER_ALLOWED` += `workspace.unarchiveSession` + the nine
  `terminal.*` methods (with a comment documenting the agent-scoped trust
  boundary).
- `src/capabilities.ts`: `USER_DOMAINS` += `terminal`.
- Tests: `tests/capabilities.spec.ts` (+2: the 0.1.6 method additions; the
  terminal domain exposure/non-denial) and `tests/remote-guard.spec.ts` (+1:
  guard admits `terminal.create`/`write`/`list` (owned) and
  `workspace.unarchiveSession`, still denies a foreign `sessionId` in
  `terminal.list`). Suite: **17 files / 192 tests green** against the published
  0.1.6-alpha.1 builds.
- `dist/index.js` + `dist/client.js` rebuilt (`npm run build`).

## 4. Trust rationale for allowing `terminal.*` to ordinary users

The terminal controller is agent-keyed: the Gateway itself supplies the `agent`
argument on every method, so a terminal always lives inside the invoking
session's own agent subtree (cwd/workspace), never cross-user. That is the same
trust boundary as `session.prompt`, which is already allowed — an ordinary
user's agent can already run shell commands for them. `terminal.list` is the
one method taking an explicit `sessionId`; the ownership guard
(`GUARDED_ID_FIELDS` covers `sessionId`) fails closed on foreign ids. Admins
always pass unfiltered.

Deployments that want a stricter posture simply compose the guard with a
narrowed allow-list (the lists are plain sets — subtract `terminal.*` before
wrapping); the capability advertisement derives from the same list, so the
sidebar terminal becomes a quiet 204/403 for those users.

## 5. Multi-user support in DSH 0.1.6 — detection result

**DSH 0.1.6-alpha.1 still has NO native multi-user support.** Evidence:

- `git grep -iE 'multi-user|multiuser'` over `packages/` + `apps/` at the tag: zero hits.
- No accounts/user-management/RBAC packages exist (`packages/host/` is unchanged; no new host auth layer).
- `packages/identity` = anonymous per-harness-home **telemetry correlation ids** (not accounts).
- `packages/guard` = loop-hygiene reminders/timeouts (not access control).
- `packages/sandbox` = a **process-confinement seam** (per-platform backends, policy resolver, Windows write-restriction rung) — relevant as a *future building block* for per-user OS isolation, but not multi-user itself.
- The browser-auth model remains one persistent BrowserAuth session per process (`dsh-client-connection`), i.e. single-tenant with a single console.

dsh-login therefore remains the multi-user layer for the DSH Web GUI on 0.1.6;
nothing upstream duplicates or conflicts with it (the login wall's fallback
seat, `/api/auth/*` routes, and the patch rows are all still owned the same way).

## 6. Role-based whole-UI permission control — feasibility at 0.1.6

**Verdict: still not implementable cleanly for third-party UI; unchanged from 0.1.5.**

- `ui-slots` (the slot/section composition core) is source-unchanged: SlotMap
  declaration merging + a single `register` API, **no per-identity filter, no
  activation gate, no role concept**.
- `packages/client/modules` (client runtime) still activates every installed
  bundle; no identity hook fires before a plugin's boot fetches. Third-party
  plugin self-registered exact routes (`/api/<plugin>/*`) remain outside any
  dsh-login gate (unchanged boundary note from 2026-08-28).
- What dsh-login can still do (and does): capability discovery
  (`window.__DSH_SESSION__` baseline + `GET /api/auth/capabilities`), its own
  two-panel settings surface (admin 用户管理 / ordinary 账户), and — for
  deployments that compose it — the remote-guard as the API-layer role
  enforcement.
- What would make whole-UI role control possible (upstream asks):
  1. a per-identity filter in `ui-slots` registration or `useSections` consumption,
  2. an activation gate in the client runtime keyed on the BrowserAuth identity,
  3. host-side role metadata attached to bundle rows in `cordis.patch.yml`.

  Any one of these would let dsh-login map its users to roles and prune the
  client tree; today that pruning can only be advisory (capability convention),
  not enforcing.

## 7. Publish checklist (not executed here)

`npm publish` from this tree will run `prepack` (`npm run build`). Per the
0.2.0 experience: the account's granular token is staging-only — publish via
`npm stage publish` → approve on npmjs.com (2FA). Verify with
`npm view @islibaodong/dsh-login versions` afterwards. Tag `v0.2.1` after
publish.
