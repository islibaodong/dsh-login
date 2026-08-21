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
 * Render index.html through the webserver's injection pipeline.
 *
 * Harness 0.1.1-rc.1 moved the boot manifest (the window.__ModuleLoader__ queue
 * facade, its parser preloads, and window.__DSH_BOOT__) from raw tapIndex
 * transforms into the structured injection table rendered only by
 * webServer.renderIndex. applyIndexTaps still exists but runs just the raw
 * taps, so calling it alone would serve an index with no module loader - the
 * shell then fails with "web boot: window.__ModuleLoader__ bootstrap facade is
 * missing". Prefer renderIndex and fall back to applyIndexTaps on harness
 * 0.1.0-rc.x, where it is the full pipeline.
 */
function indexRenderer(ctx: Context, distIndex: string): () => Promise<string> {
  return async (): Promise<string> => {
    const body = await readFile(distIndex, 'utf8')
    const webServer = ctx.webServer as {
      renderIndex?: (html: string) => string
      applyIndexTaps: (html: string) => string
    }
    const render = webServer.renderIndex ?? webServer.applyIndexTaps.bind(webServer)
    return render.call(webServer, body)
  }
}

/**
 * Create the gateway handler used as the webserver fallback. Unauthenticated
 * requests are redirected to /login; authenticated requests are served static
 * files via the frontend-static serveStatic function.
 *
 * Uses registerFallback (not prefix /) because the WebServer's prefix match
 * checks 'pathname.startsWith(prefix + '/')' - for prefix '/' that becomes
 * '//', which no normal path starts with. A prefix '/' route only matches the
 * exact path '/'. The fallback handler catches everything no named route
 * claims, which is the correct catch-all behavior for the gateway.
 */
export function createGatewayHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  const distRoot = dirname(config.distIndex)
  const renderIndex = indexRenderer(ctx, config.distIndex)

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const token = extractSessionToken(req.headers.cookie)
    if (token === undefined || store.verify(token) === undefined) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    store.cleanup()
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, config.distIndex, renderIndex)
  }
}
