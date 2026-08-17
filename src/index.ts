import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'
import { Config as ConfigSchema } from './config.ts'
import { SessionStore } from './session.ts'
import { createGatewayHandler } from './gateway.ts'
import { createLoginHandler, createLogoutHandler, createSetupHandler } from './login-api.ts'
import { renderLoginPage, renderSetupPage } from './login-page.ts'
import { provideWebRuntime, resolveDistIndex } from './web-runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-login'

/** Hard dependencies: the web server and credentials services. */
export const inject = ['webServer', 'credentials']

export { ConfigSchema as Config }

/**
 * Register the authentication gateway, login page, and login/logout/setup
 * API routes on the web server. All route disposers are owned by the plugin
 * fiber via ctx.effect for clean teardown on stop/update/undefine.
 *
 * dsh-login takes over the webRuntime service and the fallback seat from
 * dsh-web-app's web-runtime row (which the shipped cordis.patch.yml disables):
 * it provides webRuntime (LAN trust for the /api trust fence, DSH_WEB_URL)
 * and serves the frontend dist through the authenticated gateway.
 *
 * First-time setup: when no password is configured, the /login page shows a
 * "set password" form instead of the login form. The /api/auth/setup
 * endpoint stores the password via the DSH credentials system. Once set,
 * the normal login flow takes over.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const store = new SessionStore(config.sessionTtl)
  const ref = credentialRef(config.password)
  const distIndex = config.distIndex === '' ? resolveDistIndex() : config.distIndex
  const gatewayConfig = { ...config, distIndex }

  if (config.takeOverWebRuntime) provideWebRuntime(ctx, config.trustedHosts)

  const loginPageRoute: WebRoute = {
    kind: 'exact',
    path: '/login',
    handler: async (_req, res) => {
      // Check if password is configured; show setup page on first use.
      const info = await ctx.credentials.describe(ref)
      const html = info.configured ? renderLoginPage() : renderSetupPage()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    },
  }

  const setupApiRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/setup',
    handler: createSetupHandler(ctx, config),
  }

  const loginApiRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/login',
    handler: createLoginHandler(ctx, config, store),
  }

  const logoutApiRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/logout',
    handler: createLogoutHandler(ctx, config, store),
  }

  const gatewayHandler = createGatewayHandler(ctx, gatewayConfig, store)

  ctx.effect(() => ctx.webServer.register(loginPageRoute), 'dsh-login: /login')
  ctx.effect(() => ctx.webServer.register(setupApiRoute), 'dsh-login: /api/auth/setup')
  ctx.effect(() => ctx.webServer.register(loginApiRoute), 'dsh-login: /api/auth/login')
  ctx.effect(() => ctx.webServer.register(logoutApiRoute), 'dsh-login: /api/auth/logout')
  // The gateway claims the fallback seat (not prefix /) because the
  // WebServer's prefix match only catches the exact path '/' for a '/'
  // prefix. The fallback catches everything no named route claims.
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), 'dsh-login: gateway fallback')
}
