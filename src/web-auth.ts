/**
 * Browser identity for the DSH 0.2.3-alpha.1 connection seam.
 *
 * Why this exists
 * ---------------
 * Under the rc.5-era connection service dsh-login handed the browser its /api
 * credential itself: the gateway replayed the core's `GET /?token=` exchange
 * server-side (`mintCoreCookie`) and then forwarded every index request to
 * `connection.authorizeIndex`. DSH 0.2.3-alpha.1 deleted that surface
 * (`browser-auth.ts` is gone; the browser cookie now belongs to the
 * `@deepseek-ai/dsh-host-authentication-token` plugin) and replaced it with
 * `connection.authentication`: an ordered registry of credential verifiers.
 * The webserver's admission path (`webserver/authorize` bail → HostConnection
 * source fence → `authentication.authenticate`) asks that registry who a
 * request speaks for, and the accepted `PeerScope` is what every carrier
 * (the `/api` Fetch route, the `/api/remote.mux` upgrade) hands to the RPC
 * dispatch layer.
 *
 * dsh-login therefore registers a provider of its own: a request carrying a
 * live `dsh_session` cookie authenticates to an owner Peer tagged with the
 * dsh-login user, and every other request falls through to the next provider
 * (the core browser/API-token providers keep working for CLI and SDK use).
 * No live session means no Peer, so the connection layer answers 401 before
 * any bridge or dispatch code runs — the login wall keeps its meaning.
 *
 * The claimed peer is cached per session token: the carrier, the dispatch
 * guard and the index render then all see the same Peer object for the same
 * browser session, which is what upstream identity checks (`client.peer !==
 * peer`) and dsh-login's own `peerUser()` tag expect.
 */

import type { Context } from '@deepseek-ai/cordis'
import { extractSessionToken } from './auth.ts'
import { tagPeer, type PeerUser } from './dispatch-guard.ts'
import type { SessionStore } from './session.ts'

/** Request headers as either the Fetch `Headers` or a node:http record. */
export type HeaderSource = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

/** Minimal Peer surface this module creates and reads (a superset is fine). */
export interface PeerScopeLike {
  readonly id: string
  readonly principal: unknown
  dispose(): Promise<void>
}

/** The connection-service surface this module feature-detects. */
export interface ConnectionLike {
  createPeer?(options: {
    readonly principal: { readonly kind: 'owner' }
    readonly interactions?: 'answer' | 'none'
  }): PeerScopeLike
  authentication?: {
    register(provider: {
      authenticate(request: { readonly headers: HeaderSource }): PeerScopeLike | undefined
    }): () => Promise<void>
  }
}

/** Identity cache bound: one Peer per live session token, oldest evicted first. */
const PEER_CACHE_LIMIT = 256

/**
 * Read one header from either header representation.
 * @param headers - Fetch `Headers` or a node:http header record.
 * @param name - lower-case header name.
 * @returns the header value, or undefined when absent.
 */
function readHeader(headers: HeaderSource | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const get = (headers as Headers).get
  if (typeof get === 'function') return get.call(headers, name) ?? undefined
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>
  const value = record[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join('; ')
  return undefined
}

/**
 * Resolve the dsh-login user behind a request's cookie header.
 * @param headers - request headers from the webserver or the connection fence.
 * @param store - dsh-login session store (the identity authority).
 * @returns the session token and its user, or undefined when unauthenticated.
 */
export function sessionFromHeaders(
  headers: HeaderSource | undefined,
  store: SessionStore,
): { token: string; user: PeerUser } | undefined {
  const token = extractSessionToken(readHeader(headers, 'cookie'))
  if (token === undefined) return undefined
  const session = store.verify(token)
  if (session === undefined) return undefined
  return { token, user: { username: session.user, isAdmin: session.isAdmin } }
}

/**
 * The per-plugin identity authority: session cookie → tagged owner Peer.
 *
 * One instance lives on the plugin fiber. It creates peers lazily (the
 * connection service may load after dsh-login) and drops them with the
 * plugin's own teardown; an evicted peer is disposed so its abort signal and
 * any connection-registration it carried are released.
 */
export interface WebIdentity {
  /**
   * Claim (or reuse) the tagged Peer for one live session token.
   * @param token - `dsh_session` cookie value already verified by the caller.
   * @param user - identity the Peer is tagged with.
   * @returns the Peer, or undefined when the connection seam is unavailable.
   */
  peerForSession(token: string, user: PeerUser): PeerScopeLike | undefined
  /**
   * Resolve a request to its Peer (provider body).
   * @param headers - request headers.
   * @returns the Peer for a live session, otherwise undefined.
   */
  authenticate(headers: HeaderSource | undefined): PeerScopeLike | undefined
  /**
   * Register the provider on the connection service.
   * @param connection - the loaded connection service.
   * @returns the disposer withdrawing the registration.
   */
  register(connection: ConnectionLike): () => void
  /** Dispose every cached Peer (plugin teardown). */
  disposeAll(): void
}

/**
 * Create the identity authority for one plugin fiber.
 * @param ctx - plugin context; the connection service is read lazily.
 * @param store - dsh-login session store.
 * @returns the identity authority.
 */
export function createWebIdentity(ctx: Context, store: SessionStore): WebIdentity {
  const peers = new Map<string, PeerScopeLike>()

  const connection = (): ConnectionLike | undefined => ctx.get('connection') as ConnectionLike | undefined

  function peerForSession(token: string, user: PeerUser): PeerScopeLike | undefined {
    const existing = peers.get(token)
    if (existing !== undefined) return existing
    const service = connection()
    if (typeof service?.createPeer !== 'function') return undefined
    if (peers.size >= PEER_CACHE_LIMIT) {
      const oldest = peers.keys().next()
      if (!oldest.done) {
        const evicted = peers.get(oldest.value)
        peers.delete(oldest.value)
        if (evicted !== undefined) void evicted.dispose().catch(() => {})
      }
    }
    const peer = service.createPeer({ principal: { kind: 'owner' } })
    tagPeer(peer, user)
    peers.set(token, peer)
    return peer
  }

  function authenticate(headers: HeaderSource | undefined): PeerScopeLike | undefined {
    const session = sessionFromHeaders(headers, store)
    if (session === undefined) return undefined
    return peerForSession(session.token, session.user)
  }

  function register(service: ConnectionLike): () => void {
    const authentication = service.authentication
    if (authentication === undefined) return () => {}
    const off = authentication.register({ authenticate: (request) => authenticate(request.headers) })
    return () => {
      void off().catch(() => {})
    }
  }

  function disposeAll(): void {
    const cached = [...peers.values()]
    peers.clear()
    for (const peer of cached) void peer.dispose().catch(() => {})
  }

  return { peerForSession, authenticate, register, disposeAll }
}
