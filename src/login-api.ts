import type { ServerResponse, IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import {
  verifyPassword,
  buildCookieHeader,
  buildClearCookieHeader,
  extractSessionToken,
} from './auth.ts'
import type { Config } from './config.ts'

/** Maximum bytes to read from the login request body. */
const MAX_BODY_BYTES = 8192

/** Credentials filename used by the dsh-credentials-local provider. */
const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * Best-effort resolution of the local credentials file path. The local
 * provider keeps it on its private spec; when unavailable (a different
 * provider or an unknown shape), fall back to the default harness home.
 */
function credentialsStoragePath(ctx: Context): string {
  const spec = (ctx.credentials as unknown as { spec?: { filename?: string } }).spec
  if (spec !== undefined && typeof spec.filename === 'string' && spec.filename.length > 0) return spec.filename
  const dshHome = process.env.DSH_HOME
  return join(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'), CREDENTIALS_FILENAME)
}

/**
 * Announce a freshly set password on the console: the value and where it is
 * durably stored. Local single-user convenience — the console is the owner's.
 */
function announcePasswordSet(ctx: Context, ref: CredentialRef): void {
  const path = credentialsStoragePath(ctx)
  void ctx.credentials.resolve(ref).then((resolved) => {
    const value = resolved === undefined ? '<unresolved>' : resolved.value
    const source = resolved === undefined ? '' : ` (source: ${resolved.source})`
    console.log(`dsh login: password set — value: ${value}`)
    console.log(`dsh login: stored at ${path}${source}`)
  }, () => {
    console.log(`dsh login: password set — stored at ${path}`)
  })
}

/** Read the request body as a string, capped at MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.concat(chunks).length > MAX_BODY_BYTES) {
      throw new Error('body too large')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Create the POST /api/auth/login handler. Reads a JSON body, resolves the
 * expected password from the credentials system, verifies it, and on match
 * creates a session and sets the cookie.
 */
export function createLoginHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let body: string
    try {
      body = await readBody(req)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    let parsed: { password?: unknown }
    try {
      parsed = JSON.parse(body) as { password?: unknown }
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    if (typeof parsed.password !== 'string') {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    const resolved = await ctx.credentials.resolve(credentialRef(config.password))
    if (resolved === undefined) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'password not configured' }))
      return
    }
    if (!verifyPassword(parsed.password, resolved.value)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'invalid credentials' }))
      return
    }
    const session = store.create()
    res.setHeader('Set-Cookie', buildCookieHeader(session.token, config.sessionTtl))
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  }
}

/**
 * Create the POST /api/auth/logout handler. Revokes the session (if present)
 * and clears the cookie.
 */
export function createLogoutHandler(
  _ctx: Context,
  _config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const token = extractSessionToken(req.headers.cookie)
    if (token !== undefined) store.revoke(token)
    res.setHeader('Set-Cookie', buildClearCookieHeader())
    res.writeHead(200)
    res.end()
  }
}

/**
 * Create the POST /api/auth/setup handler. Only callable when no password
 * is configured yet (first-time setup). Stores the password via the DSH
 * credentials system. Returns 403 if a password is already set.
 */
export function createSetupHandler(
  ctx: Context,
  config: Config,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Security gate: only allow setup when no password is configured.
    const info = await ctx.credentials.describe(credentialRef(config.password))
    if (info.configured) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'password already set' }))
      return
    }
    let body: string
    try {
      body = await readBody(req)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    let parsed: { password?: unknown }
    try {
      parsed = JSON.parse(body) as { password?: unknown }
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    if (typeof parsed.password !== 'string' || parsed.password.length === 0) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    try {
      await ctx.credentials.set(credentialRef(config.password), parsed.password)
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'failed to store password' }))
      return
    }
    announcePasswordSet(ctx, credentialRef(config.password))
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  }
}
