import z from '@deepseek-ai/schemastery'

/** Plugin configuration for the dsh-login authentication gateway. */
export interface Config {
  /** Credential reference name for the password (e.g. 'DSH_LOGIN_PASSWORD'). */
  password: string
  /** Absolute path to index.html in the frontend dist directory. When empty,
   * resolved automatically from @deepseek-ai/dsh-web-frontend's exports. */
  distIndex: string
  /** Directory for dsh-login-owned data files (ownership index). When empty,
   * resolved to `<dshHome>/.dsh-login` at apply time. */
  dataDir: string
  /** Session lifetime in seconds (default: 604800 = 7 days). */
  sessionTtl: number
  /** Whether the gateway is active (default: true). When false, the plugin
   * registers no routes and the usual frontend fallback serves as usual. */
  enabled: boolean
  /** Whether dsh-login takes over the `webRuntime` service and the fallback
   * seat from the dsh-web-app `web-runtime` row (default: true). The shipped
   * cordis.patch.yml disables that row; enabling this without disabling it
   * makes the second fallback registration fail the boot. */
  takeOverWebRuntime: boolean
  /** Explicit trusted authorities (from --trusted-host), appended after the
   * LAN literals, exactly like dsh-web-app's resolveLanTrust. */
  trustedHosts: string[]
  /** Automatically learn the Host of any successful login and trust it for
   * the /api fence (persisted under <dataDir>/trusted-hosts.json). Default
   * true; set false to keep only loopback + trustedHosts (+ the LAN literals
   * when takeOverWebRuntime is on). */
  autoTrustHosts: boolean
  /** Provision a per-user default workspace for non-admin users on their
   * first /api access, so they get a usable workspace without the privileged
   * host.pickDirectory dialog. Enabled by default; an admin can toggle it at
   * runtime from the 设置-用户管理 panel (persisted separately, see
   * src/workspace-setting.ts). Each user's sandbox lives under
   * workspaceRoot/<username>; a blank starter session is seeded there so the
   * workspace is immediately visible in workspace.list (which only shows
   * workspaces holding that user's sessions). */
  defaultWorkspace: boolean
  /** Filesystem root that holds each user's default-workspace sandbox. Empty
   * resolves to `<dshHome>/workspaces`. Only used when defaultWorkspace is on. */
  workspaceRoot: string
  /**
   * Compatibility with `@linxin666/dsh-remote-web-ui` (default true). When on,
   * dsh-login writes that plugin's settings to `{ enabled: true,
   * requirePairingForLan: false }` (live + persisted, merged — so its host
   * routes mount while the device-pairing gate stays off). Non-loopback
   * desktop traffic — e.g. a public FRP host — then rides the ordinary /api
   * channel dsh-login gates by the dsh_session cookie instead of remote-web-ui's
   * pairing gate (which otherwise 401s a model-dialog / history request).
   * No-op when remote-web-ui is not installed or not in the composition.
   * An admin can toggle it live from 设置-用户管理.
   */
  remoteWebUiCompat: boolean
  /** Public base URL of a tunnel / FRP host in front of this server (e.g.
   * `http://your.host:13080`), written into remote-web-ui's `publicBaseUrl`
   * so its `/api/pair/*` fence trusts that ordinary-user origin. Only applied
   * when remoteWebUiCompat is on; empty disables it. No-op when remote-web-ui
   * is not installed. */
  remoteWebUiPublicBaseUrl: string
  /**
   * Quietly deny side-effect-free discovery probes for ordinary users (default
   * true). When on, the physical layer answers an unauthorized read probe
   * (`list`/`status`/`describe`/… or a QUIET_DENY_METHODS method) with 204 No
   * Content instead of 403, so UI-plugin startup enumeration does not splash
   * errors into the browser console or trigger retries. Side-effecting writes
   * always keep 403. When off, every unauthorized method returns 403 as before.
   * This never loosens authorization — only the shape of the denial for
   * side-effect-free calls.
   */
  quietDenials: boolean
  /**
   * Enforce the dsh-login session on the shared `/api` bridge (default true).
   * DSH ≥ 0.1.6-alpha.2 fires the `connection/request` waterfall on the native
   * connection row's `/api` route (option A: upstream owns the carrier); when
   * this is on, dsh-login listens on it and answers 401 unless the request
   * carries a valid dsh-login session cookie — so a logout (or expiry)
   * actually revokes /api access even though the browser keeps the
   * process-wide connection browser-auth cookie, and the per-user boundary no
   * longer rides that shared cookie. On DSH < 0.1.6-alpha.2 the event never
   * fires, so this silently degrades to the 0.2.1 behavior. The native
   * Host/Origin + browser-auth fence still runs first (upstream order), and
   * plugin-exact routes (dsh-login's /api/auth/*, remote-web-ui's
   * /api/pair/*) never reach the bridge. Turn off only for deployments that
   * serve the bridge to clients that cannot carry the dsh_session cookie
   * (e.g. remote-web-ui's paired-device proxy re-issues requests server-side
   * without it — pairing is by design a full-control credential outside the
   * dsh-login user model).
   */
  apiBridgeAuth: boolean
}

export const Config: z<Config> = z.object({
  password: z.string().required(),
  distIndex: z.string().default(''),
  dataDir: z.string().default(''),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
  takeOverWebRuntime: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  autoTrustHosts: z.boolean().default(true),
  defaultWorkspace: z.boolean().default(true),
  workspaceRoot: z.string().default(''),
  remoteWebUiCompat: z.boolean().default(true),
  remoteWebUiPublicBaseUrl: z.string().default(''),
  quietDenials: z.boolean().default(true),
  apiBridgeAuth: z.boolean().default(true),
})
