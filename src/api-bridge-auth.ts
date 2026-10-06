/**
 * Session + authorization wall for the shared `/api` bridge (DSH ≥ 0.1.6-alpha.2).
 *
 * Under option A (DSH ≥ 0.1.5-alpha.1) the native `connection` row owns the
 * `/api` carrier and dsh-login no longer wraps it. That row fences requests by
 * Host/Origin and its process-wide browser-auth cookie — which every logged-in
 * dsh-login user receives through `authorizeIndex` on the SPA index, and which
 * outlives a dsh-login logout. So a browser that once obtained the browser-auth
 * cookie could keep calling the bridge after its dsh-login session ended, and
 * any logged-in user could call every wire method.
 *
 * DSH 0.1.6-alpha.2 added the `connection/request` waterfall on that bridge
 * ("admit or wrap an authenticated shared API request"): a listener runs
 * before the bridge and vetoes the request by not calling `next`. dsh-login
 * registers this wall:
 *
 * 1. Authentication — a valid `dsh_session` cookie admits the request;
 *    anything else answers 401 and stops the chain. Logout/expiry now actually
 *    revokes /api access, and /api access requires a dsh-login identity even
 *    though the browser-auth cookie itself stays process-wide.
 * 2. Method authorization — for an ordinary (non-admin) user, a POST whose
 *    wire endpoint (`/api/<endpoint>`, dotted like `session.create`) is not on
 *    the `USER_ALLOWED` allow-list is denied. With `quietDenials` (default)
 *    the denial is a wire-correct `server-response` envelope carrying
 *    `{ ok: false, code: 'forbidden' }` (the wall consumes the request body to
 *    echo the caller's rpcId — it owns the rejected request, the bridge never
 *    runs), so the browser surfaces an ordinary denied-RPC error instead of a
 *    transport-failure splash. With quiet denials off, the denial is a plain
 *    403 like the old physical takeover. This restores the old takeover's
 *    `isUserAllowed` enforcement (f0336e7) at the new seam.
 * 3. Default-workspace provisioning — the first admitted request of a
 *    non-admin user triggers the provisioner (fire-and-forget, best-effort).
 * 4. Ownership observation — an admitted non-admin POST to
 *    `session.create` / `session.fork` / `workspace.create` has its response
 *    observed (write/end tee) and the created id recorded into the ownership
 *    sidecar; `session.list` / `session.search` / `workspace.list` responses
 *    are narrowed to the caller's owned sessions (see bridge-list-filter.ts).
 *    Admin requests are never restricted, but an admin POST to a record
 *    endpoint is still observed record-only (no filtering): the sidecar then
 *    knows admin-created sessions/workspaces too, which is what lets the
 *    deployment-side remote guard (see glue.ts) resolve an admin session
 *    instead of failing closed on it.
 *
 * Deliberately NOT covered (unchanged boundaries):
 * - The connection row's own fence still runs first upstream (Host/Origin
 *   trust, then browser auth) — this wall only adds the dsh-login layer.
 * - Plugin-exact webServer routes (dsh-login's `/api/auth/*`, remote-web-ui's
 *   `/api/pair/*`) never reach the bridge, so pre-login pairing flows keep
 *   working.
 * - The Remote stream mux WebSocket upgrade (`registerUpgrade`) is fenced by
 *   upstream's `requestRejection` only; there is no per-request hook there,
 *   and event frames are not filtered per user yet.
 * - Plugin-exact `/api/...` routes a third-party plugin registers directly on
 *   the webServer bypass the bridge (the 2026-08-28 boundary note).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extractSessionToken } from './auth.ts'
import type { SessionStore } from './session.ts'
import type { OwnershipIndex } from './ownership.ts'
import { USER_ALLOWED } from './api-filter.ts'
import {
  FILTER_METHODS,
  RECORD_METHODS,
  filterSessionItemsValue,
  filterWorkspaceListValue,
  recordOwnershipFromResponse,
} from './bridge-list-filter.ts'

/** The `connection/request` waterfall listener shape (DSH ≥ 0.1.6-alpha.2). */
export type ApiBridgeAuthListener = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => Promise<void>,
) => Promise<void>

/** How the wall obtains the caller's owned-session set (see probeOwnedSessionIds). */
export type OwnedSetProvider = (username: string) => Promise<ReadonlySet<string>>

/** The default-workspace provisioner seam (only `ensure` is used). */
export interface BridgeProvisioner {
  ensure(user: { username: string; isAdmin: boolean }): Promise<void>
}

export interface ApiBridgeAuthDeps {
  /** The dsh-login session store (the same one the login wall and /api/auth routes use). */
  store: SessionStore
  /** The ownership sidecar the wall records created resources into. */
  ownership: OwnershipIndex
  /**
   * Deny shape for methods an ordinary user may not call: true (default)
   * answers a wire-correct forbidden envelope, false a plain 403.
   */
  quietDenials: boolean
  /** Lazily resolves the caller's owned-session set for response filtering. */
  ownedProvider?: OwnedSetProvider
  /** Fired (best-effort) on a non-admin user's first admitted request. */
  provisioner?: BridgeProvisioner
}

/**
 * The response surface the tee wraps. Node's ServerResponse methods are
 * captured and replayed; the structural record keeps the overrides assignable
 * without `any`.
 */
interface TeeResponse {
  writeHead(...args: unknown[]): unknown
  setHeader(name: string, value: unknown): unknown
  write(...args: unknown[]): unknown
  end(...args: unknown[]): unknown
  readonly headersSent: boolean
}

/** Upper bound for reading a denied request's body to recover its rpcId. */
const DENY_BODY_LIMIT_BYTES = 1 << 20

/**
 * Recover the wire endpoint (`session.create`, dotted) from the request URL,
 * or undefined when the request is not an `/api/...` bridge call. The
 * remainder is taken verbatim (no percent-decoding — encoded junk fails the
 * allow-list) with `/` normalized to `.` so two-segment spellings line up
 * with the allow-list and guard.
 */
export function endpointFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const path = url.split('?')[0]!.split('#')[0]!
  if (!path.startsWith('/api/')) return undefined
  return path.slice('/api/'.length).split('/').join('.')
}

/**
 * Build the bridge wall. Fail-closed: a missing, malformed, expired, or
 * revoked session cookie answers 401 (plain text, like the upstream fence)
 * and never calls `next`.
 */
export function createApiBridgeAuth(deps: ApiBridgeAuthDeps): ApiBridgeAuthListener {
  const deny403 = (response: ServerResponse): void => {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('forbidden')
  }

  /**
   * Quiet denial: the wall owns the rejected request (the bridge never runs),
   * so it can consume the body to recover the caller's rpcId and answer with
   * a valid `server-response` envelope — the same shape a composed Remote
   * guard denial produces, minus the transport failure.
   */
  const denyQuiet = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rpcId = await readRequestRpcId(request)
    if (rpcId === undefined) {
      deny403(response)
      return
    }
    const body = JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'forbidden', message: 'not permitted for this user', details: {} } },
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  }

  return async (request, response, next) => {
    const token = extractSessionToken(request.headers.cookie)
    const session = token === undefined ? undefined : store_verify(deps, token)
    if (session === undefined) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('unauthorized')
      return
    }
    deps.store.cleanup()
    const user = { username: session.user, isAdmin: session.isAdmin }

    // Enforcement gates only bridge RPCs: the wire is POST-only, so GET/SSE
    // paths (and WS upgrades, which do not ride this waterfall) pass through
    // to upstream.
    if (request.method !== 'POST') return next()

    // Admins are never restricted, but their created resources are still
    // recorded (record-only observation, no filtering) so the ownership
    // sidecar knows admin-created sessions/workspaces — that is what lets
    // the deployment-side remote guard resolve an admin session.
    if (user.isAdmin) {
      const adminEndpoint = endpointFromUrl(request.url)
      if (adminEndpoint !== undefined && RECORD_METHODS.has(adminEndpoint)) {
        attachResponseTee(response, {
          endpoint: adminEndpoint,
          username: user.username,
          ownership: deps.ownership,
          owned: undefined,
        })
      }
      return next()
    }

    if (deps.provisioner !== undefined) {
      void deps.provisioner.ensure(user).catch(() => { /* best-effort */ })
    }

    const endpoint = endpointFromUrl(request.url)
    if (endpoint === undefined) return next()
    if (!USER_ALLOWED.has(endpoint)) {
      if (deps.quietDenials) {
        await denyQuiet(request, response)
        return
      }
      deny403(response)
      return
    }

    // Admitted non-admin POST: observe the response when the method creates a
    // resource (record) or returns a per-user listing (filter).
    if (FILTER_METHODS.has(endpoint) || RECORD_METHODS.has(endpoint)) {
      const owned = FILTER_METHODS.has(endpoint) ? await resolveOwned(deps, user.username) : undefined
      attachResponseTee(response, {
        endpoint,
        username: user.username,
        ownership: deps.ownership,
        owned,
      })
    }
    return next()
  }
}

/** Session verify with the wall's own expiry/cleanup behavior (kept tiny for tests). */
function store_verify(deps: ApiBridgeAuthDeps, token: string) {
  return deps.store.verify(token)
}

async function resolveOwned(deps: ApiBridgeAuthDeps, username: string): Promise<ReadonlySet<string> | undefined> {
  if (deps.ownedProvider === undefined) return undefined
  try {
    return await deps.ownedProvider(username)
  } catch {
    return undefined
  }
}

/**
 * Read a denied request's body (bounded) and recover its rpcId. Returns
 * undefined when the body is absent, oversized, or not a valid
 * `client-request` envelope — the caller then falls back to a plain 403.
 */
async function readRequestRpcId(request: IncomingMessage): Promise<string | undefined> {
  try {
    const chunks: Buffer[] = []
    let size = 0
    request.setEncoding?.('utf8')
    for await (const chunk of request) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer)
      size += piece.length
      if (size > DENY_BODY_LIMIT_BYTES) return undefined
      chunks.push(piece)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      type?: unknown
      rpcId?: unknown
    }
    if (parsed.type !== 'client-request' || typeof parsed.rpcId !== 'string' || parsed.rpcId === '') {
      return undefined
    }
    return parsed.rpcId
  } catch {
    return undefined
  }
}

interface TeeContext {
  endpoint: string
  username: string
  ownership: OwnershipIndex
  owned: ReadonlySet<string> | undefined
}

/**
 * Tee the bridge's response: capture status/headers/chunks through wrapped
 * `writeHead`/`setHeader`/`write`/`end`, and at completion either record the
 * created resource id (record endpoints) or rewrite the JSON body down to the
 * caller's owned sessions (filter endpoints). Any parse/shape failure flushes
 * the original bytes unchanged — observation must never corrupt a response.
 */
function attachResponseTee(response: ServerResponse, context: TeeContext): void {
  const raw = response as unknown as TeeResponse
  const rawWriteHead = raw.writeHead.bind(response)
  const rawSetHeader = raw.setHeader.bind(response)
  const rawWrite = raw.write.bind(response)
  const rawEnd = raw.end.bind(response)

  const headers: Record<string, unknown> = {}
  let status: number | undefined
  let statusMessage: string | undefined
  const chunks: Array<{ data: Buffer; cb?: () => void }> = []
  let finalCallback: (() => void) | undefined
  let flushed = false

  const captureHeader = (name: string, value: unknown): void => {
    headers[String(name).toLowerCase()] = value
  }

  response.setHeader = function (this: ServerResponse, name: string, value: unknown) {
    captureHeader(name, value)
    return this
  } as typeof response.setHeader

  response.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    const first = args[0]
    if (typeof first === 'number') status = first
    for (const arg of args.slice(1)) {
      if (typeof arg === 'string' && statusMessage === undefined && status !== undefined && args.length === 2) {
        statusMessage = arg
        continue
      }
      if (typeof arg === 'object' && arg !== null) {
        for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
          captureHeader(key, value)
        }
      }
    }
    return this
  } as typeof response.writeHead

  response.write = function (this: ServerResponse, ...args: unknown[]) {
    captureChunk(args)
    return true
  } as typeof response.write

  response.end = function (this: ServerResponse, ...args: unknown[]) {
    captureChunk(args)
    flush()
    return this
  } as typeof response.end

  function captureChunk(args: unknown[]): void {
    let cb: (() => void) | undefined
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const arg = args[index]
      if (typeof arg === 'function') {
        cb = arg as () => void
        continue
      }
      if (arg !== undefined && arg !== null && arg !== (0 as unknown)) break
    }
    const first = args[0]
    if (typeof first === 'string' || first instanceof Buffer || first instanceof Uint8Array) {
      const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : 'utf8'
      const data = first instanceof Buffer ? first : Buffer.from(first as string, encoding)
      chunks.push({ data, cb })
    } else if (cb !== undefined && chunks.length > 0) {
      chunks[chunks.length - 1]!.cb = cb
    } else if (cb !== undefined) {
      finalCallback = cb
    }
  }

  function flush(): void {
    if (flushed) return
    flushed = true
    const original = Buffer.concat(chunks.map((chunk) => chunk.data))
    let body = original
    let replayHeaders = true
    try {
      if (status === 200 && isJsonBody(headers)) {
        const parsed = JSON.parse(original.toString('utf8')) as unknown
        if (FILTER_METHODS.has(context.endpoint)) {
          if (context.owned !== undefined) {
            const filtered = context.endpoint === 'workspace.list'
              ? filterWorkspaceListValue(parsed, context.owned)
              : filterSessionItemsValue(parsed, context.owned)
            if (filtered !== undefined) body = Buffer.from(JSON.stringify(filtered), 'utf8')
          }
        } else {
          recordOwnershipFromResponse(parsed, context.username, context.ownership)
        }
      }
    } catch { /* keep the original body */ }
    void replayHeaders
    if (!response.headersSent) {
      const outgoing: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) outgoing[key] = value
      }
      if (status !== undefined || chunks.length > 0) {
        outgoing['content-length'] = String(body.length)
        delete outgoing['transfer-encoding']
      }
      rawWriteHead(status ?? 200, statusMessage ?? '', outgoing)
    }
    if (body !== original) {
      // Rewritten: emit the single rewritten buffer (the original chunks are
      // stale). The last captured write callback stays attached so the
      // bridge's own completion bookkeeping still fires.
      const last = chunks[chunks.length - 1]
      if (last?.cb !== undefined) rawWrite(body, last.cb)
      else rawWrite(body)
    } else {
      for (const chunk of chunks) {
        if (chunk.cb !== undefined) {
          rawWrite(chunk.data, chunk.cb)
        } else {
          rawWrite(chunk.data)
        }
      }
    }
    if (finalCallback !== undefined) rawEnd(finalCallback)
    else rawEnd()
  }
}

function isJsonBody(headers: Readonly<Record<string, unknown>>): boolean {
  const type = headers['content-type']
  return typeof type === 'string' && type.includes('application/json')
}
