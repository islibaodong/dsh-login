import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'
import { Config as ConfigSchema } from './config.ts'
import { SessionStore } from './session.ts'
import { createGatewayHandler } from './gateway.ts'
import { createLoginHandler, createLogoutHandler } from './login-api.ts'
import { renderLoginPage } from './login-page.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-login'

/** Hard dependencies: the web server and credentials services. */
export const inject = ['webServer', 'credentials']

export { ConfigSchema as Config }

/**
 * Register the authentication gateway, login page, and login/logout API
 * routes on the web server. All route disposers are owned by the plugin
 * fiber via ctx.effect for clean teardown on stop/update/undefine.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const store = new SessionStore(config.sessionTtl)

  const loginPageRoute: WebRoute = {
    kind: 'exact',
    path: '/login',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderLoginPage())
    },
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

  const gatewayHandler = createGatewayHandler(ctx, config, store)

  ctx.effect(() => ctx.webServer.register(loginPageRoute), 'dsh-login: /login')
  ctx.effect(() => ctx.webServer.register(loginApiRoute), 'dsh-login: /api/auth/login')
  ctx.effect(() => ctx.webServer.register(logoutApiRoute), 'dsh-login: /api/auth/logout')
  // The gateway claims the fallback seat (not prefix /) because the
  // WebServer's prefix match only catches the exact path '/' for a '/'
  // prefix. The fallback catches everything no named route claims.
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), 'dsh-login: gateway fallback')
}
