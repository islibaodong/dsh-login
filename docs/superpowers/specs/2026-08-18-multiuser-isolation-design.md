# Multi-User Login & Logical Session Isolation — Design

Date: 2026-08-18
Status: Approved (chat review) — implementation pending

## Goal

Upgrade dsh-login from a single-password gateway to multi-user authentication
with logical session isolation: all users share one DSH host process, but each
user sees and can operate only their own conversations (admin sees everything).

## Decisions (from user Q&A)

- **Isolation depth**: logical isolation — shared backend, per-user filtering of
  session lists, session-addressed RPCs, and the SSE/WebSocket event streams.
- **Implementation location**: plugin wrapper layer inside the dsh-login
  repository. No deepseek-harness core changes.
- **User management**: admin-managed accounts. The first account created at
  first-time setup is the admin; the login page never offers self-registration.
- **Permission scope**: ordinary users are conversation-only. Allowed:
  `session.*`, `workspace.*`, `subagent.*`, `goal.*`, `skill.list`,
  `llm.providers`, `llm.models`, `host.describe`, the event streams, `respond`,
  and `session.export` of their own sessions. Everything else (credentials,
  settings, agentPreset, host directory/open-path, `llm.discoverModels`) is
  admin-only.

## Architecture

Three pieces, all inside dsh-login:

1. **User store** (`src/users.ts`): username → scrypt password hash record.
   Stored as one JSON document in the DSH credentials system under ref
   `<password-ref>_USERS` (derived from the existing `password` config; the
   local provider persists it to `.credentials.yaml`). First user gets
   `isAdmin: true`.

2. **Ownership index** (`src/ownership.ts`): sidecar JSON file
   (`dataDir/ownership.json`, default `<DSH_HOME>/.dsh-login/`) mapping
   `sessionId → username`, with debounced persistence. Recorded when
   `session.create` / `session.fork` responses pass through the wrapper.
   Sessions created internally by the host (subagents) are attributed lazily
   via their `parentSessionId` lineage (from `session.list` summaries and
   `host/session-added` frames). Unattributed sessions are visible to admin
   only (fail-closed).

3. **Connection takeover** (`src/connection.ts`, dual-face Cordis plugin):
   `cordis.patch.yml` disables the shipped `connection` row
   (`@deepseek-ai/dsh-client-connection`) and inserts this plugin. Its node
   half is a fork of the original ~150-line carrier: same trust fence
   (`isTrustedApiRequest`, re-exported from the original package's `./src/*`
   export), same `/api` prefix route and the two WebSocket upgrade routes.
   Differences: every request resolves the user from the `dsh_session` cookie
   before dispatch; dispatch goes through `toFetchHandler(wrappedProxy)`;
   the WebSocket downlinks pump frames through the per-user filtered
   `events.mux` / `events.host` (async-generator frame filter). The browser
   half re-exports `@deepseek-ai/dsh-client-connection/client` verbatim —
   zero frontend changes.

The per-user wrapper (`src/api-filter.ts`) decorates `ApiProxy`:

- `sessions.list` / `sessions.search`: filter items to owned (admin: all).
- `sessions.create` / `sessions.fork`: pass through, then record ownership.
- sessionId-addressed methods (`history`, `models`, `selectModel`, `rename`,
  `prompt`, `attachment`, `updateQueue`, `cancel`): resolve owner (direct index
  hit, else lineage walk); reject non-owned with a `forbidden` RPC error.
- `subagents.*`: same guard via the subagent's owning session.
- `workspace.*`: filter `workspace.list` views to owned sessions, drop
  workspaces with no owned sessions (admin: unfiltered).
- `goals.*`: sessionId-keyed, same guard.
- `events.mux`: drop frames whose `sessionId` is not owned (every MuxFrame
  variant except `stream/error` carries one).
- `events.host`: session-keyed frames filtered by ownership;
  `host/workspace-changed` / `workspace-order-changed` /
  `archived-sessions-changed` filtered to include only owned ids (dropped for
  a user who owns none of the affected sessions); `host/remote-event` is
  admin-only.
- Admin-only methods (permission scope above) return a `forbidden` RPC error
  for ordinary users.
- `session.export` (physical GET in `toFetchHandler`): guarded in the takeover
  route by query-param sessionId ownership before forwarding.

## Auth surface changes

- `POST /api/auth/login` now takes `{username, password}`; the session cookie
  token maps to `{username, isAdmin}` in the extended in-memory SessionStore.
- First-time setup form creates the admin account (username + password) via
  `POST /api/auth/setup` (only callable while the user store is empty).
- New admin routes (session-cookie auth, admin only):
  `GET /api/auth/me` (any logged-in user), `GET /api/auth/admin/users`,
  `POST /api/auth/admin/users` `{username,password,isAdmin?}`,
  `POST /api/auth/admin/users/password` `{username,password}`,
  `POST /api/auth/admin/users/remove` `{username}` (cannot remove self or the
  last admin), plus a self-contained `/admin` HTML page in the existing style.
- Legacy single-password credential (`password` config ref) remains untouched;
  it is no longer used for login once users exist. Backward migration is not
  provided (fail-closed fresh start).

## Concurrency

User sessions are independent agent sessions on the host (native concurrency).
Isolation guarantees non-interference: no cross-user visibility in lists,
search, streams, or direct sessionId access.

## Testing

Vitest unit tests per module (user store, ownership index incl. lineage,
api-filter allow/deny matrix incl. frame filtering, connection carrier with
two simulated users seeing disjoint sessions) plus the existing
integration-runner pattern for an end-to-end pass.

## Risks

- The takeover plugin forks ~150 lines of `dsh-client-connection` node half;
  upstream carrier-semantic changes must be followed (documented in README).
- Ownership index corruption degrades to admin-only visibility (fail-closed),
  never accidental cross-user leakage.
- Password hashing: node:crypto scrypt, no new dependencies.
- `respond` (approval/question answers) is not session-guarded; answers are
  keyed by unguessable UUID rpcIds of frames the user never received. Accepted
  residual risk, documented.
