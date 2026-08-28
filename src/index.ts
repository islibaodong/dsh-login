import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'
import { Config as ConfigSchema } from './config.ts'
import { SessionStore } from './session.ts'
import { UserStore } from './users.ts'
import { OwnershipIndex } from './ownership.ts'
import { TrustedHosts } from './hosts.ts'
import { DefaultWorkspaceSetting } from './workspace-setting.ts'
import { BooleanSetting } from './boolean-setting.ts'
import { applyWithRetry, RemoteWebUiCompat, type RemoteWebUiCompatDeps } from './remote-web-ui-compat.ts'
import { createGatewayHandler } from './gateway.ts'
import { createLoginHandler, createLogoutHandler, createLogoutRedirectHandler, createSetupHandler } from './login-api.ts'
import { createAdminRoutes } from './admin-api.ts'
import { renderLoginPage, renderSetupPage } from './login-page.ts'
import { provideWebRuntime, resolveDistIndex } from './web-runtime.ts'
import { resolveDshHome } from './http-json.ts'
import { createConnectionPlugin } from './connection.ts'
import { deriveCapabilities } from './capabilities.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-login'

/** Hard dependencies: the web server and credentials services. */
export const inject = ['webServer', 'credentials']

export { ConfigSchema as Config }

/**
 * Register the multi-user authentication gateway on the web server:
 *
 * - Login/logout/setup JSON API (`{username, password}` against the
 *   UserStore — scrypt hashes stored under the `${password}_USERS`
 *   credential ref; the old single-password ref itself stays configured but
 *   is no longer used for authentication).
 * - Admin JSON API + `GET /admin` management page (admin sessions only).
 * - The identity-aware `/api` carrier takeover (`createConnectionPlugin`)
 *   mounted as a child plugin, and the OwnershipIndex sidecar with a
 *   teardown flush so pending ownership writes reach disk on stop/update.
 *
 * All route disposers are owned by the plugin fiber via ctx.effect for clean
 * teardown on stop/update/undefine. dsh-login takes over the webRuntime
 * service and the fallback seat from dsh-web-app's web-runtime row (which
 * the shipped cordis.patch.yml disables) and serves the frontend dist
 * through the authenticated gateway.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const dataDir = config.dataDir === '' ? join(resolveDshHome(), '.dsh-login') : config.dataDir
  // Persisted session store: sessions survive a process restart (so an already
  // open SPA's /api calls are not suddenly 401'd — the in-memory-only store
  // invalidated every cookie on reload). Tokens live in <dataDir>/sessions.json
  // (0o600). Session TTL still applies on load, so stale records are dropped.
  const store = new SessionStore(config.sessionTtl, join(dataDir, 'sessions.json'))
  const users = new UserStore(ctx.credentials, credentialRef(`${config.password}_USERS`))
  const ownership = new OwnershipIndex(join(dataDir, 'ownership.json'))
  const hosts = new TrustedHosts(join(dataDir, 'trusted-hosts.json'))
  // Live + persisted "默认用户工作空间" toggle: starts from config.defaultWorkspace
  // (default on) and can be flipped by an admin at runtime from the settings
  // panel. The provisioner reads it per request, so the toggle binds immediately.
  const defaultWorkspaceSetting = new DefaultWorkspaceSetting(join(dataDir, 'settings.json'), config.defaultWorkspace)
  // Absolute root for per-user default-workspace sandboxes when the feature is
  // enabled (config.defaultWorkspace is the boot default; the runtime toggle is
  // defaultWorkspaceSetting): explicit workspaceRoot or `<dshHome>/workspaces`.
  const defaultWorkspaceRoot = config.workspaceRoot === '' ? join(resolveDshHome(), 'workspaces') : config.workspaceRoot
  // Live + persisted "remote-web-ui 兼容" toggle: when on (default), dsh-login
  // writes @linxin666/dsh-remote-web-ui's requirePairingForLan to false so
  // non-loopback (public FRP) desktop traffic rides dsh-login's /api channel
  // instead of remote-web-ui's device-pairing gate. No-op if remote-web-ui is
  // not installed. The toggle is settings-backed + hot-reloaded by that plugin,
  // so flipping it at runtime takes effect immediately and persists.
  const remoteWebUiSetting = new BooleanSetting(join(dataDir, 'settings-remote-web-ui.json'), config.remoteWebUiCompat)
  const remoteWebUiCompat = new RemoteWebUiCompat({
    getSettings: () => ctx.get('settings') as unknown as ReturnType<RemoteWebUiCompatDeps['getSettings']>,
  })
  const distIndex = config.distIndex === '' ? resolveDistIndex() : config.distIndex
  const gatewayConfig = { ...config, distIndex }
  const loginDeps = { users, store, sessionTtl: config.sessionTtl, hosts, autoTrust: config.autoTrustHosts }

  // Capture the webRuntime LAN literals so the /api takeover trusts the
  // bound LAN addresses automatically (the shipped connection row read them
  // from webRuntime too; dsh-login's own fence used to see only the static
  // config list, which is why LAN IPs and frp public hosts needed hand-listing).
  const runtime = config.takeOverWebRuntime ? provideWebRuntime(ctx, config.trustedHosts) : undefined
  const lanAuthorities = runtime?.lanAddresses ?? []
  // Live effective set: LAN literals + config.trustedHosts + learned/manager
  // hosts (deduped). The fence reads it per request so learned hosts bind
  // immediately and removals take effect without a restart.
  const effectiveTrustedHosts = (): string[] => {
    const learned = config.autoTrustHosts ? hosts.list() : []
    return [...new Set([...lanAuthorities, ...config.trustedHosts, ...learned])]
  }

  const loginPageRoute: WebRoute = {
    kind: 'exact',
    path: '/login',
    handler: async (_req, res) => {
      // No users yet → first-time setup form; otherwise the login form.
      const html = (await users.isEmpty()) ? renderSetupPage() : renderLoginPage()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    },
  }

  const gatewayHandler = createGatewayHandler(ctx, gatewayConfig, store)

  ctx.effect(() => ctx.webServer.register(loginPageRoute), 'dsh-login: /login')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/setup',
    handler: createSetupHandler(loginDeps),
  }), 'dsh-login: /api/auth/setup')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/login',
    handler: createLoginHandler(loginDeps),
  }), 'dsh-login: /api/auth/login')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/auth/logout',
    handler: createLogoutHandler(store),
  }), 'dsh-login: /api/auth/logout')
  // Link-friendly logout: same revocation, but answers with a redirect so
  // plain <a href="/logout"> entries (e.g. the admin page topbar) work.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/logout',
    handler: createLogoutRedirectHandler(store),
  }), 'dsh-login: /logout')
  for (const route of createAdminRoutes({ users, store, hosts, defaultWorkspaceSetting, remoteWebUiSetting, remoteWebUiCompat, onRemoteWebUiApply: (enabled) => applyWithRetry(remoteWebUiCompat, enabled, config.remoteWebUiPublicBaseUrl, 3, 50) })) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-login: ${route.path}`)
  }
  // Boot-time application of the remote-web-ui compatibility toggle. Deferred
  // so it never blocks startup; applyWithRetry keeps retrying a few hundred ms
  // in case remote-web-ui's settings namespace registers after dsh-login does.
  const bootCompat = applyWithRetry(remoteWebUiCompat, remoteWebUiSetting.get(), config.remoteWebUiPublicBaseUrl)
  void bootCompat
  // The gateway claims the fallback seat (not prefix /) because the
  // WebServer's prefix match only catches the exact path '/' for a '/'
  // prefix. The fallback catches everything no named route claims.
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), 'dsh-login: gateway fallback')

  // Per-identity capability baseline, injected at render time. index-inject
  // fires before any specific user's request, so this declares the ordinary-
  // user surface as a static, safe default (the common case for dsh-login);
  // clients that need the exact identity (an admin, a special account) fetch
  // GET /api/auth/capabilities, which is authoritative. UI-plugin boot code
  // can read window.__DSH_SESSION__ to skip features the current user cannot
  // use instead of probing (and being denied on) them.
  const cap = deriveCapabilities({ username: '', isAdmin: false })
  const sessionBaselineScript = `window.__DSH_SESSION__={username:null,isAdmin:false,capabilities:${JSON.stringify(cap)}};`
  ctx.effect(() => ctx.on('webserver/index-inject', (table: Array<{ kind: string; placement: string; text: string }>) => {
    table.push({ kind: 'script', placement: 'head', text: sessionBaselineScript })
  }), 'dsh-login: capability baseline injection')

  // Identity-aware /api carrier takeover, mounted as a child plugin so its
  // SessionStore/OwnershipIndex instances live in this fiber.
  ctx.effect(() => {
    const child = ctx.plugin(createConnectionPlugin({
      store,
      ownership,
      trustedHosts: config.trustedHosts,
      effectiveTrustedHosts,
      defaultWorkspaceRoot,
      isDefaultWorkspaceEnabled: () => defaultWorkspaceSetting.get(),
      quietDenials: config.quietDenials,
    }))
    return () => { void child.stop?.() }
  }, 'dsh-login: connection takeover')

  // Teardown: flush any pending ownership-index / trusted-hosts writes to
  // disk. Returning the Promise lets Cordis await it on stop so a freshly
  // learned host (debounce still pending) is not dropped (review #3).
  ctx.effect(() => () => Promise.all([store.flush(), ownership.flush(), hosts.flush(), defaultWorkspaceSetting.flush(), remoteWebUiSetting.flush()]), 'dsh-login: sessions + ownership + hosts + settings flush')
}
