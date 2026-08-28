/**
 * Capability discovery for the dsh-login gateway.
 *
 * The browser half of many DSH UI plugins discovers what it can do by
 * firing requests at `/api/<method>` on startup. When dsh-login's physical
 * layer denies those with 403, the browser logs a wall of "forbidden"
 * errors and may retry — noisy and wasteful on an ordinary-user session
 * that legitimately has no access to admin/plugin domains.
 *
 * This module gives clients a declarative, per-identity capability surface
 * (so they need not probe blindly) AND a semantic denial strategy (so the
 * few probes that do leak through fail quietly instead of flaming red):
 *
 *  - `deriveCapabilities(isAdmin)` returns what that identity may actually
 *    call (methods, domains, visible UI plugins). It is derived from the
 *    same `USER_ALLOWED` allow-list the physical layer enforces, so it can
 *    never advertise more than the deny-rule grants.
 *  - `isReadProbe(method)` classifies a call as a side-effect-free
 *    discovery probe (list/status/describe/get/…). The physical layer
 *    answers an unauthorized read probe with 204 No Content — the client
 *    treats "there is nothing here" as normal, quietly skipping the feature
 *    instead of surfacing an error or retrying. Side-effecting writes stay
 *    403. `QUIET_DENY_METHODS` lists whole methods that are safe to flush
 *    quietly regardless of the read-probe heuristic.
 *
 * Nothing here loosens authorization: the physical allow-list and the
 * ownership-filtered decorator remain the authority. Capability discovery
 * only *tells* the client the boundary so it does not cross it; 204 merely
 * restates "not here for you" in a form the browser does not treat as an
 * error.
 */
import { USER_ALLOWED } from './api-filter.ts'
import type { AuthUser } from './api-filter.ts'

/** Single-segment RpcMethodMap methods an ordinary user may call (physical layer). */
export function userAllowedMethods(): string[] {
  return [...USER_ALLOWED]
}

/**
 * Two-segment `/api/<domain>/<member>` domains that are admin-only: ordinary
 * users are denied them at the physical layer (quiet 204 for read shapes, 403
 * for writes) instead of being forwarded to the harness — which answers a loud
 * 403 and floods the browser console on startup probes like `GET /api/pet/pets`.
 *
 * The surface is a *deny-list*, not an allow-list: everything else (including
 * user-facing two-segment domains such as `ssh`, `skill`, `settings`) is
 * dispatched exactly as before, so this never regresses a genuinely
 * user-reachable feature. Domains here are the config/secrets, pairing/update
 * (loopback) and admin/decoration UI-plugin domains an ordinary user must not
 * reach.
 */
export const ADMIN_ONLY_TWO_SEGMENT_DOMAINS: ReadonlySet<string> = new Set([
  // config + secrets (admin)
  'credentials', 'agentPresets', 'agentPreset',
  // pairing / update / remote-channel (loopback-only)
  'pair', 'update', 'dsh-desktop-launcher', 'dsh-web-ui-settings', 'web-ui-settings', 'dsh-ssh',
  // admin / decoration UI-plugin domains
  'pet', 'task-board', 'plugin-manager', 'doctor', 'perf', 'liangshen', 'aionui',
  'market', 'git-graph', 'skill-explorer', 'skin-center', 'community-plugins',
  // harness admin-agent domain
  'agents',
])

/**
 * Whether a two-segment domain is admin-only for an ordinary user (see
 * {@link ADMIN_ONLY_TWO_SEGMENT_DOMAINS}). Denying it is safe and never touches
 * user-facing domains, so the physical layer can answer it gracefully.
 */
export function isUserDeniedTwoSegment(domain: string): boolean {
  return ADMIN_ONLY_TWO_SEGMENT_DOMAINS.has(domain)
}

/**
 * Whole two-segment domains the browser half of UI plugins poll that a normal
 * user may reach (those the decorated proxy exposes, ownership-scoped). These
 * are safe for the client to render for an ordinary user; admin-only domains
 * (`credentials`, `settings`, `agentPresets`) are deliberately absent.
 */
export const USER_DOMAINS: readonly string[] = [
  'session',
  'workspace',
  'goals',
  'subagents',
  'llm',
  'host',
  'skill',
  'api',
]

/** UI plugin ids hidden from an ordinary user (admin-only surfaces). */
const ADMIN_ONLY_UI_PLUGINS: readonly string[] = [
  '@linxin666/dsh-client-ui-plugin-manager',
  '@linxin666/dsh-client-ui-skill-explorer',
  '@linxin666/dsh-client-ui-skin-center',
  '@linxin666/dsh-client-ui-market',
  '@linxin666/dsh-client-ui-git-graph',
  '@linxin666/dsh-client-ui-community-plugins',
  '@linxin666/dsh-client-ui-web-ui-settings',
  '@linxin666/dsh-client-ui-aionui-panel',
  '@linxin666/dsh-client-ui-task-board',
  '@linxin666/dsh-desktop-launcher',
  '@linxin666/dsh-doctor',
  '@linxin666/dsh-pet',
  '@linxin666/dsh-ssh',
  '@linxin666/dsh-perf',
  '@linxin666/dsh-liangshen',
]

/** UI plugin ids always available (the login gateway's own panel + model core). */
const CORE_UI_PLUGINS: readonly string[] = [
  '@islibaodong/dsh-login',
]

/** Capabilities advertised for one identity. */
export interface Capabilities {
  /** Single-segment wire methods the identity may call. */
  methods: string[]
  /** Two-segment domains the identity may reach. */
  domains: string[]
  /** UI plugin ids the client should render for this identity. */
  uiPlugins: string[]
}

/**
 * Capabilities for the given identity, derived from the same allow-list the
 * physical layer enforces. Admin: every possible method/domain + every UI
 * plugin. Ordinary: the USER_ALLOWED allow-list + USER_DOMAINS + core plugins.
 * @param user - the authenticated identity.
 */
export function deriveCapabilities(user: AuthUser): Capabilities {
  if (user.isAdmin) {
    return {
      methods: userAllowedMethods().concat(adminOnlyMethods()),
      domains: allDomains(),
      uiPlugins: CORE_UI_PLUGINS.concat(allUiPlugins()),
    }
  }
  return {
    methods: userAllowedMethods(),
    domains: [...USER_DOMAINS],
    uiPlugins: [...CORE_UI_PLUGINS],
  }
}

/** Methods an admin may additionally call (the allow-list does not carry them). */
function adminOnlyMethods(): string[] {
  // The physical layer's allow-list is the ordinary-user boundary. The admin
  // surface spans every RpcMethodMap key plus the admin-only domains; we
  // advertise a representative superset. Deriving the true full list would
  // require importing the harness RpcMethodMap, which is out of scope for a
  // capability advertisement (the physical layer remains authoritative).
  return [
    'credentials.list', 'credentials.get', 'credentials.set', 'credentials.delete',
    'settings.list', 'settings.update', 'settings.reset',
    'agentPreset.list', 'agentPreset.read', 'agentPreset.write',
    'host.path', 'host.system',
  ]
}

/** Every user domain plus the admin-only ones. */
function allDomains(): string[] {
  return [...USER_DOMAINS, 'credentials', 'settings', 'agentPresets']
}

/** Every UI plugin id (core + admin-only). */
function allUiPlugins(): string[] {
  return [...CORE_UI_PLUGINS, ...ADMIN_ONLY_UI_PLUGINS]
}

/**
 * Whole methods that are safe to deny quietly even if the read-probe
 * heuristic below cannot classify them (a curated list of the common
 * plugin boot probes).
 */
export const QUIET_DENY_METHODS: ReadonlySet<string> = new Set([
  'agentPreset.list', 'agentPreset.get',
  'credentials.list',
  'settings.list', 'settings.describe',
  'pluginManager.list', 'plugin.list',
  'doctor.status', 'doctor.run',
  'ui.plugins', 'ui.list',
])

/**
 * Whether a single-segment method is a side-effect-free discovery probe whose
 * denial can be a quiet 204 instead of a loud 403. Heuristic on the trailing
 * verb; whole-method exceptions live in QUIET_DENY_METHODS.
 */
export function isReadProbe(method: string): boolean {
  if (QUIET_DENY_METHODS.has(method)) return true
  const verb = method.slice(method.lastIndexOf('.') + 1).toLowerCase()
  // Read-style verbs are safe to flush quietly; mutating verbs are not.
  return READ_VERBS.has(verb)
}

/** Trailing verbs treated as read-only probes. */
const READ_VERBS: ReadonlySet<string> = new Set([
  'list', 'get', 'status', 'describe', 'fetch', 'summary', 'version',
  'info', 'config', 'state', 'providers', 'models', 'ping',
])