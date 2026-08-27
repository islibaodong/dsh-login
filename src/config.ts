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
   * host.pickDirectory dialog. Default false (opt-in). Admin is unaffected.
   * Each user's sandbox lives under workspaceRoot/<username>; a blank starter
   * session is seeded there so the workspace is immediately visible in
   * workspace.list (which only shows workspaces holding that user's sessions). */
  defaultWorkspace: boolean
  /** Filesystem root that holds each user's default-workspace sandbox. Empty
   * resolves to `<dshHome>/workspaces`. Only used when defaultWorkspace is on. */
  workspaceRoot: string
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
  defaultWorkspace: z.boolean().default(false),
  workspaceRoot: z.string().default(''),
})
