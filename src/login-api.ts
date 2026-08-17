import type { ServerResponse, IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
