/**
 * dsh-login-connection — the /api carrier takeover with per-user dispatch.
 *
 * Replaces the shipped client-connection host half: same trust fence and
 * bridge, but the shared fetch resolves the caller from the session cookie
 * (401 without one), rejects non-allowed methods for ordinary users at the
 * physical layer (isUserAllowed), guards the physical session.export channel
 * by ownership, and dispatches every surviving request through a cached
 * per-user wrapped ApiProxy (createUserProxy). WebSocket downlinks carry the
 * cookie session too and stream through the same per-user proxy.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '@deepseek-ai/dsh-client-connection/src/api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from '@deepseek-ai/dsh-client-connection/src/http-bridge.ts'
import { isTrustedApiRequest, assertTrustedAuthority } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from '@deepseek-ai/dsh-client-connection/src/websocket-downlink.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import { extractSessionToken } from './auth.ts'
import { createUserProxy, isUserAllowed, ownedSessionIds } from './api-filter.ts'
import { isReadProbe } from './capabilities.ts'
import type { AuthUser } from './api-filter.ts'
import type { OwnershipIndex } from './ownership.ts'
import type { SessionStore } from './session.ts'
import { DefaultWorkspaceProvisioner, type WorkspaceRegistryLike } from './provision.ts'

/** Factory dependencies: live instances owned by the dsh-login plugin. */
export interface TakeoverDeps {
  store: SessionStore
  ownership: OwnershipIndex
  /** config.trustedHosts — asserted at boot and used as the static base. */
  trustedHosts: string[]
  /**
   * Live effective trusted-authorities evaluator for the /api fence
   * (LAN literals + config.trustedHosts + auto-learned/manager hosts).
   * Defaults to the static trustedHosts list.
   */
  effectiveTrustedHosts?: () => string[]
  /**
   * When defaultWorkspace is on: the root that holds each non-admin user's
   * automatic default workspace (see config.workspaceRoot, resolved to an
   * absolute path by index.ts). Propied to the provisioner so every /api
   * request can lazily ensure a per-user sandbox+starter session.
   */
  defaultWorkspaceRoot?: string
  /**
   * Live enabled-flag accessor for the "默认用户工作空间" toggle (from the
   * persisted DefaultWorkspaceSetting). Consulted per request so an admin
   * toggle takes effect immediately; defaults to the presence of
   * defaultWorkspaceRoot.
   */
  isDefaultWorkspaceEnabled?: () => boolean
  maxRequestBodyBytes?: number
  /**
   * Quietly deny side-effect-free discovery probes for ordinary users (from
   * config.quietDenials, default true). When on, an unauthorized read probe is
   * answered 204 No Content instead of 403 so UI-plugin startup enumeration
   * does not error/retry in the browser; side-effecting writes keep 403. Never
   * loosens authorization — only the denial's shape for read probes.
   */
  quietDenials?: boolean
  /**
   * Test seam: when provided, replaces `toFetchHandler(downlinks)` as the
   * per-user fetch construction, so tests can observe which user proxy
   * handled a request (wrap or stub it). Never set in production.
   */
  fetchForTest?: (downlinks: ApiProxy, user: AuthUser) => { fetch: typeof fetch }
}

export function createConnectionPlugin(deps: TakeoverDeps) {
  return {
    name: 'dsh-login-connection',
    inject: ['webServer'],
    apply(ctx: Context): void {
      for (const entry of deps.trustedHosts) assertTrustedAuthority(entry)
      const maxBytes = deps.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
      const proxyCache = new Map<string, { fetch: typeof fetch; downlinks: ApiProxy }>()
      // The shipped connection row is disabled while this takeover is active,
      // which also removes the `connection` service its host half provided —
      // and with it the Typert Remote gateway (`dsh-api-gateway`), which only
      // registers its shared `/api` interceptor once `ctx.inject(['connection'])`
      // resolves. Every browser-side UI plugin (SSH host management, task
      // board, command palette, plugin inventory, …) calls its host methods
      // through that interceptor as `POST /api/<namespace>/<method>`, so the
      // service must be re-provided here or those plugins die after login.
      const connection = new HostConnectionService(ctx, deps.trustedHosts)
      // Interceptor-aware dispatch for two-segment Typert endpoints. The
      // 404 fallback keeps unclaimed `a/b` shapes from leaking into the
      // RpcMethodMap handler below; interceptor-claimed endpoints dispatch
      // natively (per-user ownership filtering cannot apply to them — the
      // harness itself fences privileged Typert domains at the host side).
      const typertDispatch = connection.createSharedFetchHandler(API_PATH, {
        fetch: () => Promise.resolve(new Response('not found', { status: 404 })),
      })

      const userProxy = (api: ApiProxy, user: AuthUser): ApiProxy => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username
        let entry = proxyCache.get(key)
        if (entry === undefined) {
          entry = { fetch: undefined as never, downlinks: createUserProxy(api, user, deps.ownership, { workspaceRoot: deps.defaultWorkspaceRoot }) }
          entry.fetch = deps.fetchForTest !== undefined
            ? deps.fetchForTest(entry.downlinks, user).fetch
            : toFetchHandler(entry.downlinks).fetch
          proxyCache.set(key, entry)
        }
        return entry.downlinks
      }
      const userFetch = (api: ApiProxy, user: AuthUser): typeof fetch => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username
        userProxy(api, user)
        return proxyCache.get(key)!.fetch
      }

      // Lazy default-workspace provisioner: built once, resolves the durable
      // workspace registry from the fiber on first use so a missing service
      // disables it without failing boot. Provisioning should never block or
      // fail the request that triggered it — DefaultWorkspaceProvisioner.ensure
      // is idempotent and swallows its own errors.
      const provisioner = deps.defaultWorkspaceRoot === undefined
        ? undefined
        : new DefaultWorkspaceProvisioner({
            workspaceRoot: deps.defaultWorkspaceRoot,
            getApi: () => ctx.get('apiProxy')!,
            ownership: deps.ownership,
            get workspaceRegistry(): WorkspaceRegistryLike | undefined {
              return ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
            },
            enabled: deps.isDefaultWorkspaceEnabled,
          })
      const ensureProvisioned = async (user: AuthUser): Promise<void> => {
        if (provisioner !== undefined) await provisioner.ensure(user)
      }

      const sharedFetch = (api: ApiProxy): { fetch: typeof fetch } => ({
        fetch: async (request: Request): Promise<Response> => {
          const url = new URL(request.url)
          const token = extractSessionToken(request.headers.get('cookie') ?? undefined)
          const session = token === undefined ? undefined : deps.store.verify(token)
          if (session === undefined) return new Response('authentication required', { status: 401 })
          const user: AuthUser = { username: session.user, isAdmin: session.isAdmin }
          // Lazy per-user default-workspace provisioning (non-admin first
          // access). Best-effort + idempotent; must not fail the request.
          await ensureProvisioned(user)
          // Plain GET on the two event paths answers 426 verbatim from the
          // upstream carrier (upgrades never reach this handler; the GET shape
          // is the SSE fallback browsers must not use over the web transport).
          if (request.method === 'GET' && (url.pathname === MUX_EVENTS_PATH || url.pathname === HOST_EVENTS_PATH)) {
            return new Response('upgrade required', {
              status: 426,
              headers: { connection: 'Upgrade', upgrade: 'websocket' },
            })
          }
          // The physical session.export channel carries its target in the
          // query string, outside the envelope — guarded here by ownership
          // (lineage-inclusive, same predicate the wrapped proxy uses).
          if (url.pathname === '/api/session.export') {
            const sid = url.searchParams.get('sessionId')
            if (!user.isAdmin && sid !== null) {
              const owned = await ownedSessionIds(api, user, deps.ownership)
              if (!owned.has(sid)) return new Response('forbidden', { status: 403 })
            }
            return userFetch(api, user)(request)
          }
          const method = url.pathname.startsWith(`${API_PATH}/`) ? url.pathname.slice(API_PATH.length + 1) : undefined
          // RpcMethodMap names are single-segment (`session.list`, dots only);
          // Typert Remote endpoints carry exactly one slash (`namespace/method`).
          // Two-segment endpoints are UI-plugin territory: dispatch them
          // through the Typert interceptor (authentication above already
          // applies; admin-only legacy domains stay fenced by the single-
          // segment allow-list below).
          if (method !== undefined && method.includes('/')) {
            return typertDispatch.fetch(request)
          }
          // Non-admin methods the decorator rejects are rejected at the
          // physical layer too (cheaper than round-tripping an envelope) —
          // the wrapped proxy remains the authority; both stay in sync via
          // isUserAllowed.
          if (!user.isAdmin && method !== undefined && !isUserAllowed(method)) {
            // Side-effect-free discovery probes are denied quietly (204) when
            // quietDenials is on: a read-verb method name (e.g. credentials.list
            // POSTed as an RPC) or a plain GET/HEAD on a forbidden path are both
            // inherently probes. Mutating writes always keep 403.
            const quiet = deps.quietDenials !== false && (isReadProbe(method) || reqReadOnlyContext(request))
            return new Response(quiet ? undefined : 'forbidden', { status: quiet ? 204 : 403 })
          }
          return userFetch(api, user)(request)
        },
      })

      const route: WebRoute = {
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, deps.effectiveTrustedHosts?.() ?? deps.trustedHosts)) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          const api = ctx.get('apiProxy')
          if (api === undefined) {
            res.writeHead(404)
            res.end('not found')
            return
          }
          await bridge(req, res, sharedFetch(api), maxBytes)
        },
      }
      ctx.effect(() => ctx.webServer.register(route), 'dsh-login-connection: /api route')

      const downlinkSet = new Set<WebSocketDownlinks>()
      const registerDownlink = (path: string, kind: 'mux' | 'host'): void => {
        ctx.effect(() => ctx.webServer.registerUpgrade({
          path,
          handler: (req, socket, head) => {
            if (!isTrustedApiRequest(req, deps.effectiveTrustedHosts?.() ?? deps.trustedHosts)) {
              rejectWebSocketUpgrade(socket)
              return
            }
            const token = extractSessionToken(req.headers.cookie)
            const session = token === undefined ? undefined : deps.store.verify(token)
            if (session === undefined) {
              rejectWebSocketUpgrade(socket)
              return
            }
            const api = ctx.get('apiProxy')
            if (api === undefined) {
              rejectWebSocketUpgrade(socket)
              return
            }
            // One WebSocketDownlinks per socket over the cached per-user
            // proxy: frames are ownership-filtered per user, and the instance
            // is disposed with the socket (and at plugin teardown below).
            const downlinks = new WebSocketDownlinks(userProxy(api, { username: session.user, isAdmin: session.isAdmin }))
            downlinkSet.add(downlinks)
            socket.once('close', () => {
              void downlinks.close()
              downlinkSet.delete(downlinks)
            })
            if (kind === 'mux') downlinks.handleMux(req, socket, head)
            else downlinks.handleHost(req, socket, head)
          },
        }), `dsh-login-connection: ${path} WebSocket`)
      }
      registerDownlink(MUX_EVENTS_PATH, 'mux')
      registerDownlink(HOST_EVENTS_PATH, 'host')
      ctx.effect(() => () => {
        for (const d of downlinkSet) void d.close()
      }, 'dsh-login-connection: downlinks close')
    },
  }
}

/**
 * Whether an HTTP request is read-only from the transport's perspective,
 * independent of the wire-method name. A GET/HEAD on a forbidden single-segment
 * method is inherently a discovery probe (no side effects over HTTP GET), so it
 * qualifies for a quiet 204 denial alongside read-verb method names.
 */
function reqReadOnlyContext(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD'
}
