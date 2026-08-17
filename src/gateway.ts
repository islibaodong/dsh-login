import type { ServerResponse, IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import { extractSessionToken } from './auth.ts'
import type { Config } from './config.ts'

/**
 * Create the gateway handler used as the webserver fallback. Unauthenticated
 * requests are redirected to /login; authenticated requests are served static
 * files via the frontend-static serveStatic function.
 *
 * Uses registerFallback (not prefix /) because the WebServer's prefix match
 * checks `pathname.startsWith(prefix + '/')` - for prefix '/' that becomes
 * '//', which no normal path starts with. A prefix '/' route only matches
 * the exact path '/'. The fallback handler catches everything no named route
 * claims, which is the correct catch-all behavior for the gateway.
 */
export function createGatewayHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  const distRoot = dirname(config.distIndex)
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.applyIndexTaps(await readFile(config.distIndex, 'utf8'))

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const token = extractSessionToken(req.headers.cookie)
    if (token === undefined || !store.verify(token)) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    store.cleanup()
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, config.distIndex, renderIndex)
  }
}
