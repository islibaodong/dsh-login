import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Maximum bytes read from a JSON request body (login + admin routes). */
export const MAX_JSON_BODY_BYTES = 8192

/** Read the request body as a string, capped at `maxBytes`. */
export async function readBody(req: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.concat(chunks).length > maxBytes) {
      throw new Error('body too large')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** End a JSON response in one call (status, content-type, body). */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Resolve the DSH home directory: `DSH_HOME` when set, else `~/.dsh`.
 * (Extracted from the old login-api credentialsStoragePath pattern.)
 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.length > 0 ? env : join(homedir(), '.dsh')
}
