/**
 * Pure physical-layer permission predicates for the dsh-login gateway.
 *
 * In DSH ≥ 0.1.5-alpha.1 dsh-login no longer takes over the `/api` carrier
 * (see docs/adapt-dsh-0.1.5.md, option A): the native `connection` +
 * `api-gateway` transport owns `/api`, and dsh-login composes its login wall
 * and — via the remote/controller layer — its per-user ownership enforcement on
 * top. The old `createUserProxy` (a per-method decorator over the removed
 * `@deepseek-ai/dsh-host-apiproxy` `ApiProxy`) is gone with that package; what
 * remains here is the pure, package-independent predicate surface that
 * `capabilities.ts` and the admission layer still rely on.
 */
export interface AuthUser { username: string; isAdmin: boolean }

/**
 * Physical-layer allow-list: every RpcMethodMap key (exact spellings copied
 * from the removed packages/host/apiproxy rpc-map — `session.list` singular,
 * etc.) an ordinary user may call through the /api carrier. Kept as the shared
 * source of truth for capability discovery (`deriveCapabilities`); in option A
 * the transport no longer hard-gates on it (upstream owns /api), but the
 * surface it describes is what the per-user admission seam must honor.
 */
export const USER_ALLOWED: ReadonlySet<string> = new Set([
  'session.list', 'session.search', 'session.create', 'session.history', 'session.models',
  'session.selectModel', 'session.rename', 'session.fork', 'session.prompt', 'session.attachment',
  'session.updateQueue', 'session.cancel',
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'host.describe',
  'workspace.list', 'workspace.create', 'workspace.rename', 'workspace.delete',
  'workspace.insertBefore', 'workspace.insertSessionBefore', 'workspace.archiveSession',
  // DSH 0.1.6: restore one archived Session (pairs with archiveSession above).
  'workspace.unarchiveSession',
  // DSH 0.1.6: the sidebar terminal (`dsh-api-terminal-controller`, typert
  // namespace `terminal`). Every method is session-agent-scoped by the Gateway
  // (the `agent` argument is supplied by the Gateway itself, never by the
  // browser), so it stays inside the caller's own agent subtree — the same
  // trust boundary as `session.prompt` (an agent can already run shell for the
  // user). `terminal.list` addresses a session explicitly and is ownership-
  // checked through the guard's GUARDED_ID_FIELDS (`sessionId`).
  'terminal.environment', 'terminal.shells', 'terminal.list', 'terminal.create',
  'terminal.follow', 'terminal.write', 'terminal.resize', 'terminal.rename',
  'terminal.close',
  'skill.list',
  'llm.providers', 'llm.models',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'respond',
])

/** May an ordinary (non-admin) user call this wire method? (Information surface only.) */
export function isUserAllowed(method: string): boolean {
  return USER_ALLOWED.has(method)
}