import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * Vendored static file server for the gateway fallback seat.
 *
 * This is the node:http-flavored `serveStatic` that used to be exported by
 * `@deepseek-ai/dsh-host-frontend-static` (harness ≤ 0.2.1-rc.2). DSH commit
 * 73931626be (PR #6901, "feat(webserver): add resource routes and
 * in-process readResource") rewrote the package as a self-claiming cordis
 * plugin over the new Fetch-style `WebResource` API and dropped the export
 * entirely, which broke this plugin's import at startup. dsh-login keeps the
 * handler-form fallback (it must run the login wall before any static byte
 * is served, and `registerFallback`'s handler form is still supported), so it
 * vendors the removed helper here instead of reaching into the host package.
 * Copy kept in sync with the upstream semantics: traversal outside the dist
 * root is 403, missing/non-file targets are 404, other filesystem failures
 * propagate to the webserver's request-failure handling, unknown extensions
 * ship as octet-stream.
 */

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Launchers require an image Content-Type for the install icons.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}
