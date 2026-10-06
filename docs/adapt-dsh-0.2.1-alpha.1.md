# DSH 0.2.1-alpha.1 compatibility check (2026-10-05; §6 = 2026-10-06 role-gate feature)

Status: **adapted and RELEASED as `@islibaodong/dsh-login@0.2.7`** (npm latest,
2026-10-05; git tag `v0.2.7` + master pushed). First adaptation on the
**0.2.1 tuple line** and the first containing an upstream **removal**: DSH
0.2.1-alpha.1 deleted the runtime invariant plugins and every `./invariant`
subpath export, retiring `@deepseek-ai/dsh-invariants` (npm stops at
0.2.0-rc.2), which this repo referenced in three places. The peer ranges could
not admit a 0.2.1 prerelease, so a peer retarget + release was mandatory (the
boot-time compatibility admission is fail-open, but the login wall would still
have been reported incompatible on every boot). Suite **18 files / 216 tests
green** on real 0.2.1-alpha.1 builds. Previous adaptation:
`docs/adapt-dsh-0.2.0-rc.2.md`.

## 1. Version detection

| Channel | Finding |
|---|---|
| npm `@deepseek-ai/dsh` dist-tags | new **`0.2.1-alpha.1`** under the **`alpha`** tag (published 2026-10-05); `latest` = `next` = `0.2.0-rc.2`. |
| Harness checkout | tag `dsh-v0.2.1-alpha.1`; `origin/master` = `5badb15009ae1756c3afe0ae0cef1faafc290ccc`; **266 commits** since `dsh-v0.2.0-rc.2` (the local checkout sits on branch `dev`, 258 behind — read remote content via `git show origin/master:<path>`, never through the worktree). |
| dsh-login base | `72ff38a11493c0d3f43978f05e6f35bb99c3772b` ("docs: 2026-10-02 re-check…"), clean. |

## 2. Compatibility surface (266 commits, diffed against `dsh-v0.2.0-rc.2`)

Release theme: **`claudeCodeMods`** — a new agent-mods/band UI surface (PR
#5623 family, "claude code mods"), plus the invariant removal
(`f028f25667`, 1355 files, −15.4k lines) and the usual version-bump churn.
The only NEW wire namespace is `claudeCodeMods` (mod band above the prompt:
`watchBand`/`pressBand` streams, `add(definition: ModDefinition)`,
`agentPresets.inspectCompositions()`); dsh-login's allow-lists do not
reference it and it rides the default deny / `USER_ALLOWED` model — no
allow-list change needed.

| Integration point | 0.2.1-alpha.1 change | Impact on dsh-login |
|---|---|---|
| `@deepseek-ai/dsh-invariants` | **RETIRED** — the package and every `./invariant` subpath export removed (`f028f25667`); npm stops at 0.2.0-rc.2 | dsh-login referenced it in exactly three places, all config-only: `package.json` devDep, `tsconfig.json` path mapping, and one `PACKAGE_MAP` entry in each of `tests/runner.mjs` + `tests/integration-runner.mjs`. No `src/` file imports it → source-compatible; the three references were removed |
| `packages/api`, `packages/typert` | session-controller `list.ts` (+34) + a new host-scheduling test file; terminal-controller `shells.ts` (+5); gateway tests; typert analyzer/loader touches — **no protocol/registry change** | none on the wire face |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | +323: service `invariants` removed; service `claudeCodeMods` added (`@Remote({mode:'stream'}) watchBand(agent, signal)`, `pressBand(agent, generation, actionId)`, `add(definition)`); `agentPresets.inspectCompositions(ctx?)`; ~30 new types (`Mod*`, `Pane*`, `Serialized*`, `UiElement(s)`, `PromptOrigin/Submit*`, `Turn*`, `ToolCall*`, `Session*`, `MatcherValue`, `AgentPresetInspection`, `AskOptions`, `BoxProps`, `TextProps`, `ToastOptions`, `PluginOption*`, `SubagentSessionError`); `SignInErrorCode` gains `'no-response'`; `ScheduleToolError` gains a `SubagentSessionError` cause (code `subagent_session`); fileUpload receipts keyed by exact Session | the new namespace rides the default-deny posture; `SUBAGENT_SESSION` is a tool-error shape, not a namespace |
| `packages/client/modules`, `packages/client/ui-slots` | **src unchanged** at the plugin-visible level (SlotEntryDef at `ui-slots/src/index.ts:116` still has no visibility/permission field) | RBAC verdict unchanged (§5); the boot-graph lever (rc.2 doc §6.5) still valid |
| Peer/dep graph | ALL 0.2.1-alpha.1 packages peer-require `@deepseek-ai/cordis@~4.0.5-alpha.1` (published only as 4.0.5-alpha.1); `dsh-settings` also peers `@deepseek-ai/schemastery@~3.18.5-alpha.1`; `cordis@4.0.5-alpha.1` peers `cordis-plugin-loader ~1.0.6-alpha.1` + `cordis-plugin-include ~1.0.10-alpha.1`; `dsh-host-webserver` now DEPENDS on `schemastery ~3.18.5-alpha.1` directly | forced the devDep retarget below (an incremental `npm install` wedged on the stale rc.2 tree — `dsh-settings@0.2.0-rc.2` nested via `dsh-config-editor` demanded cordis `~4.0.4`; **a clean `node_modules` + lockfile reinstall is required**, same recurring wedge as 0.2.5) |

## 3. Changes shipped (0.2.7)

- **`package.json` version** `0.2.6` → `0.2.7`.
- **peerDependencies**: the six dsh peers (`dsh-client-connection`,
  `dsh-credentials`, `dsh-host-frontend-static`, `dsh-host-webserver`,
  `dsh-settings`, `dsh-web-frontend`) gain `|| >=0.2.1-alpha.1 <0.3.0-0`
  (tuple rule: a 0.2.1-alpha.x prerelease satisfies no `>=0.2.0-rc.2`
  comparator); `@deepseek-ai/cordis` gains `|| ~4.0.5-alpha.1` (same rule —
  `^4.0.1-rc.1` admits no 4.0.5 prerelease);
  `@deepseek-ai/schemastery` gains `|| ~3.18.5-alpha.1`.
- **devDependencies**: 9 dsh packages → `^0.2.1-alpha.1`;
  `@deepseek-ai/dsh-invariants` removed; `cordis` → `~4.0.5-alpha.1`,
  `cordis-plugin-include` → `~1.0.10-alpha.1`, `cordis-plugin-loader` →
  `~1.0.6-alpha.1`, `schemastery` → `~3.18.5-alpha.1` (all forced by the new
  peer graph).
- **`tsconfig.json`**: dangling `@deepseek-ai/dsh-invariants` path mapping
  removed (`packages/runtime-diagnostics/invariants/src` no longer exists
  upstream).
- **`tests/runner.mjs` + `tests/integration-runner.mjs`**: the
  `dsh-invariants` `PACKAGE_MAP` entries removed.
- **No `src/` change** — the invariant retirement touched config/tests only;
  `dist/client.js` rebuilt **byte-identical** (37134 chars, the cheap
  determinism check).

## 4. Verification (against real 0.2.1-alpha.1 builds from npm)

- `npm install` clean **only after** deleting `node_modules` +
  `package-lock.json` (the stale-tree ERESOLVE wedge, third occurrence).
- `npm test`: **18 files / 216 tests passed** (vitest resolves
  `@deepseek-ai/*` at runtime from `node_modules`, so the suite ran on the
  actual 0.2.1-alpha.1 packages).
- `npm run verify:imports`: every `src/*.ts` ok.
- `npm run build`: exit 0; `dist/client.js` = 37134 chars — byte-identical to
  the 0.2.0-rc.2 stamp.

## 5. Multi-user / role verdict at 0.2.1-alpha.1 (git grep on `origin/master`)

- `multi.?user|multiuser` and `\brbac\b|role.?based` over `packages` + `apps`:
  **0 hits**. Upstream still ships **no native multi-user support**.
- `isAdmin|isAllowed` over `packages/client`: **0 hits**. (The DOM
  `role="…"` accessibility false-positive trap persists — 238 files under
  `packages/client` still match `\brole\b`; do not read a raw `role` grep as
  evidence of account roles.)
- `SlotEntryDef` (`packages/client/ui-slots/src/index.ts:116`) unchanged —
  still no visibility/permission/identity field.
- Conclusion: the 2026-10-02 verdict stands — no upstream per-role UI gate;
  the whole-UI role gate remains implementable **inside dsh-login** via the
  boot-graph lever (`docs/adapt-dsh-0.2.0-rc.2.md` §6.5) — see **§6**: it has
  since been implemented as 0.3.0.

## 6. 2026-10-06 — the boot-graph lever IMPLEMENTED as 0.3.0 (per-role whole-UI gate)

Status: **shipped as `@islibaodong/dsh-login@0.3.0`** (git tag `v0.3.0`).
This is the feature the 2026-10-02 §6.5 investigation said was feasible and
the 2026-10-05 §5 re-check confirmed still valid — now implemented inside
dsh-login with **zero upstream changes**.

### 6.1 Mechanism recap (verified at 0.2.1-alpha.1)

The whole boot roster lives in the rendered index HTML that dsh-login's
gateway already holds per request:

- `bootInjections` (`packages/client/modules/src/index.ts:552` at
  0.2.1-alpha.1) emits the `window.__DSH_BOOT__` global row carrying the
  `WebBootGraph` (`{rev, entries, batches}`).
- The page controller (`packages/client/modules/src/client/entries.ts`,
  `start()`) activates **exactly** `graph.entries` — one cordis entry per
  row — and `reconcile` removes managed entries absent from the roster.
  There is no other activation source and no bypass.
- `parseBootManifest` (client manifest parser) requires: string `id/url/rev`
  per entry, no duplicate ids, batch `phase` enum, no duplicate batch URLs,
  non-empty batch entry lists, every batch entry naming a graph entry, and
  each entry in exactly one batch.
- `webServer.renderIndex` (dsh-host-webserver) renders the global row as
  `<script>globalThis["__DSH_BOOT__"] = <json></script>` with every `<`
  escaped to `\u003c` inside the value — so the first `</script>` after the
  marker safely terminates the element, and a rewritten value must re-escape
  the same way.

### 6.2 Implementation (new `src/ui-gate.ts`, wiring in gateway/config)

- **`filterBootGraph(graph)`**: pure filter over the decoded JSON. Removes
  every entry whose id is in `ADMIN_ONLY_UI_PLUGINS` (the deny-list exported
  from `src/capabilities.ts`); patches the owning batches (`entries` minus
  removed ids), **drops batches that become empty**; **fails open (returns
  null)** on any unexpected shape — unknown top-level fields are preserved by
  spread, `rev` untouched. A kept bundle that `inject`s or `external`s a
  removed id (including the `<pkg>/client` alias) aborts the filter — refuse
  to guess rather than serve a graph the shell cannot resolve.
- **`applyUiGate(html)`**: locates the `__DSH_BOOT__` global row in the
  rendered index, decodes, filters, re-encodes with the upstream `\u003c`
  escaping, splices back. Every failure mode (marker absent, malformed JSON,
  unexpected shape) returns the input HTML unchanged.
- **Wiring**: `src/config.ts` gains `uiRoleGate: boolean` (default **true**);
  `src/gateway.ts` passes a gated `renderIndex` to `serveStatic` only when
  `config.uiRoleGate && !session.isAdmin` — admins and unauthenticated
  requests (the latter already redirect to `/login`) see the graph untouched.
- **Boundaries (unchanged and deliberate)**: presentation only — the `/api`
  allow-list (`apiBridgeAuth` + `USER_ALLOWED`) and the remote isolation
  guard remain the security boundary; per-package granularity (hiding one
  slot inside an allowed bundle is out of scope); a dev-mode `client-hmr`
  rebuild pushes a full `{type:'graph'}` frame and re-syncs the complete
  roster (dev sessions only; production never re-pushes the graph).

### 6.3 Verification (0.2.1-alpha.1)

- **`tests/ui-gate.spec.ts`**: 16 tests — filter semantics (remove/patch/
  drop/keep-rev/no-op identity/idempotence), fail-open on 11 malformed
  shapes, kept-depends-on-gated abort (both `inject` and the
  `<pkg>/client` `external` alias), HTML round-trip (only the global row
  rewritten; preload/bootstrap/body rows intact; `\u003c` re-escaping
  round-trips), plus 4 gateway integration tests on a real webserver boot
  (ordinary user filtered / admin full / `uiRoleGate:false` full /
  unauthenticated 302).
- Full suite: **19 files / 232 tests green**; `verify:imports` all ok;
  `npm run build` exit 0 (`dist/client.js` still 37134 chars — the client
  half is untouched by the gate, which lives entirely in the Node gateway).
- Test-time acceptance note: the shipped
  `@deepseek-ai/dsh-client-modules@0.2.1-alpha.1` lib does **not** export
  `parseBootManifest` (its `lib/index.js` export list omits it despite
  `lib/types/index.d.ts:19` promising it), so the spec asserts against
  `orderByModuleGraph` (the shipped runtime acceptance for dependency edges
  and cycles) plus the parser invariants encoded in the fixtures. Revisit if
  a later build exports the parser.
