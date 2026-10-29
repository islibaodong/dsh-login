import type { ServerResponse, IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { serveStatic } from './serve-static.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import { extractSessionToken } from './auth.ts'
import { applyUiGate } from './ui-gate.ts'
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
    isAuthenticated?(request: { headers: IncomingMessage['headers'] }, secure?: boolean): boolean
    launchToken?: unknown
  }
  isAuthenticated?(request: { headers: IncomingMessage['headers'] }, secure?: boolean): boolean
  launchToken?: unknown
}

/**
 * What the core writes during the captured server-side exchange: the status
 * line and the response headers of a response that is never sent anywhere.
 */
interface ExchangeCapture {
  readonly status: number
  readonly headers: Record<string, string | string[]>
}

/**
 * A minimal ServerResponse stand-in that records what the connection writes
 * during the server-side launch-token exchange (issue #10). The core (and
 * the connection surface generally) only calls `writeHead(code, headers)`
 * and `end(body?)` on it.
 */
function createCaptureResponse(): ServerResponse & ExchangeCapture {
  const headers: Record<string, string | string[]> = {}
  let status = 0
  const capture = {
    get status() {
      return status
    },
    get headers() {
      return headers
    },
    writeHead(code: number, writeHeaders?: Record<string, string | string[]>): void {
      status = code
      if (writeHeaders !== undefined) {
        for (const [name, value] of Object.entries(writeHeaders)) {
          headers[name.toLowerCase()] = value
        }
      }
    },
    setHeader(name: string, value: string | string[]): void {
      headers[name.toLowerCase()] = value
    },
    end(..._: unknown[]): void {},
  }
  return capture as unknown as ServerResponse & ExchangeCapture
}

/**
 * Run the core launch-token exchange server-side (issue #10) and return the
 * minted browser cookie, or undefined when the exchange did not mint one.
 *
 * A synthesized root request carrying the token is fed through the
 * connection's own `authorizeIndex` — the same entry the browser would hit
 * at `/?token=…` — with a capture response. The connection therefore owns
 * the entire cookie format, authority binding, and Secure handling;
 * dsh-login only replays the resulting `set-cookie`. No redirect and no
 * token ever reach the client.
 */
function mintCoreCookie(
  connection: ConnectionAuth,
  launchToken: string,
  req: IncomingMessage,
): string | string[] | undefined {
  const synthesized = {
    method: 'GET',
    url: `/?token=${encodeURIComponent(launchToken)}`,
    headers: req.headers,
  } as unknown as IncomingMessage
  const capture = createCaptureResponse()
  try {
    connection.authorizeIndex(synthesized, capture)
  } catch {
    return undefined
  }
  const cookie = capture.headers['set-cookie']
  return typeof cookie === 'string' || Array.isArray(cookie) ? cookie : undefined
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
 * required").
 *
 * Issue #10: the original fix bounced the browser to `/?token=<token>`,
 * which handed the process launch token to the remote client (Location
 * header → history, proxy logs) — and the same token is accepted by the
 * core's `GET /connect` for an owner-principal API credential, so any
 * logged-in user could escalate. The bootstrap now runs the same exchange
 * server-side (`mintCoreCookie`): the minted cookie is replayed onto the
 * index response and no redirect is issued, so the token never leaves the
 * process (only the local console print, as upstream delivers it). When the
 * exchange mints nothing the request falls through to the connection's own
 * answer — never back to a token-bearing redirect.
 *
 * The cookie probe receives the listener's own protocol decision
 * (`webServer.protocol === 'https:'`, the same derivation the core's
 * service wrapper applies): native-TLS listeners mint cookies bound to the
 * https-origin audience, which a secure-blind probe would never match.
 * Requests already carrying a token always forward (the connection owns the
 * real exchange), and connections without the browserAuth surface keep the
 * plain forward semantics.
 *
 * @returns true when the SPA index may be served; false when an upstream
 *   redirect/401 has already been written.
 */
function createAuthorizeIndex(ctx: Context): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const connection = ctx.get('connection') as ConnectionAuth | undefined
    if (connection === undefined) return true
    const auth = connection.browserAuth ?? connection
    const secure = (ctx.webServer as { protocol?: string } | undefined)?.protocol === 'https:'
    const hasTokenParam = req.url !== undefined && /[?&]token=/.test(req.url)
    if (
      !hasTokenParam &&
      typeof auth.isAuthenticated === 'function' &&
      !auth.isAuthenticated(req, secure) &&
      typeof auth.launchToken === 'string' &&
      auth.launchToken.length > 0
    ) {
      const minted = mintCoreCookie(connection, auth.launchToken, req)
      if (minted !== undefined) {
        res.setHeader('set-cookie', minted)
        return true
      }
      // The exchange minted nothing (e.g. no usable Host authority): fall
      // through to the connection's own answer below.
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
    const session = token === undefined ? undefined : store.verify(token)
    if (session === undefined) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    store.cleanup()
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    // Whole-UI role gating (config.uiRoleGate): an ordinary user's index
    // ships with the admin-only client bundles removed from the boot graph,
    // so their shell never activates those plugins. renderIndex is invoked
    // by serveStatic only for the index document, and the session was just
    // verified above, so the per-request closure sees the live identity.
    // Admins (and deployments with the gate off) get the unmodified render.
    const render = config.uiRoleGate && !session.isAdmin
      ? async (): Promise<string> => applyUiGate(await renderIndex())
      : renderIndex
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      () => authorizeIndex(req, res),
      render,
    )
  }
}