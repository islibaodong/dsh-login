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
 * The upstream Connection service surface the index handshake relies on.
 * The core dsh-client-connection provides HostConnectionService, which keeps
 * the real BrowserAuth in its `browserAuth` field (its `launchToken` is a
 * plain runtime field despite the private TS annotation); alternative or
 * test connections may expose the same surface directly on the service.
 */
interface ConnectionAuth {
  authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean
  browserAuth?: {
    isAuthenticated?(request: { headers: IncomingMessage['headers'] }): boolean
    launchToken?: unknown
  }
  isAuthenticated?(request: { headers: IncomingMessage['headers'] }): boolean
  launchToken?: unknown
}

/**
 * The index `authorizeIndex` callback handed to `serveStatic` (DSH ≥
 * 0.1.5-alpha.1 requires it). dsh-login validates its login wall in the
 * handler, so this forwards to the upstream Connection service's
 * `authorizeIndex`, which hands the browser its /api browser-session cookie
 * (the enabled `connection` row owns /api transport). When Connection is
 * absent from the fiber we accept, so a boot without it still serves.
 *
 * Fresh-device bootstrap (issue #3): the core BrowserAuth mints its
 * authority-bound cookie ONLY during the `GET /?token=<launchToken>`
 * exchange, and dsh-login's login wall never routes the browser through it —
 * a device that just logged in holds only `dsh_session`, so a bare index
 * forward would return the core's plain-text 401 ("dsh web authentication
 * required"). When the core cookie is missing/expired and the request does
 * not already carry the exchange token, bounce it once to `/?token=<token>`:
 * the core mints the cookie and 303s back to the clean `./`, from where the
 * index is served normally. Requests already carrying a token always forward
 * (the core owns the exchange; a second bounce would loop), and connections
 * without the browserAuth surface keep the plain forward semantics.
 *
 * @returns true when the SPA index may be served; false when an upstream
 *   redirect/401 has already been written.
 */
function createAuthorizeIndex(ctx: Context): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const connection = ctx.get('connection') as ConnectionAuth | undefined
    if (connection === undefined) return true
    const auth = connection.browserAuth ?? connection
    const hasTokenParam = req.url !== undefined && /[?&]token=/.test(req.url)
    if (
      !hasTokenParam &&
      typeof auth.isAuthenticated === 'function' &&
      !auth.isAuthenticated(req) &&
      typeof auth.launchToken === 'string' &&
      auth.launchToken.length > 0
    ) {
      res.writeHead(302, {
        Location: `/?token=${encodeURIComponent(auth.launchToken)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return false
    }
    return connection.authorizeIndex(req, res)
  }
}

/**
 * Create the gateway handler used as the webserver fallback. The dsh-login
 * login wall runs first: no valid dsh-login cookie → 302 to /login for any
 * fallback path (pages, assets, SPA routes). Authenticated requests are served
 * static files via the frontend-static `serveStatic`, whose `authorizeIndex`
 * runs the upstream Connection browser-session handshake so the restored
 * `connection` row accepts the SPA's /api calls.
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
  const authorizeIndex = createAuthorizeIndex(ctx)

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
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      () => authorizeIndex(req, res),
      renderIndex,
    )
  }
}