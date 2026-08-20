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
 * Create the gateway handler used as the webserver fallback. Unauthenticated
 * requests are redirected to /login; authenticated requests are served static
 * files via the frontend-static serveStatic function.
 *
 * Uses registerFallback (not prefix /) because the WebServer's prefix match
 * checks `pathname.startsWith(prefix + '/')` - for prefix '/' that becomes
 * '//', which no normal path starts with. A prefix '/' route only matches
 * the exact path '/'. The fallback handler catches everything no named route
 * claims, which is the correct catch-all behavior for the gateway.
 */
export function createGatewayHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  const distRoot = dirname(config.distIndex)
  // Minimal fixed-position logout button injected into every served HTML
  // index: revokes the session via POST /api/auth/logout, then returns to
  // the login page. The main GUI has no logout affordance of its own, so
  // this is the universal entry point for every logged-in user.
  const logoutWidget = `<script>(function(){function ready(fn){if(document.readyState!=='loading'){fn()}else{document.addEventListener('DOMContentLoaded',fn)}}ready(function(){var b=document.createElement('button');b.textContent='Log out';b.setAttribute('aria-label','Log out');b.style.cssText='position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:6px 14px;border-radius:8px;border:1px solid #2a2a4a;background:#16213e;color:#8f9bb3;font-size:13px;cursor:pointer;opacity:0.55;transition:opacity .2s';b.onmouseenter=function(){b.style.opacity='1';b.style.color='#ff6b6b';b.style.borderColor='#ff6b6b'};b.onmouseleave=function(){b.style.opacity='0.55';b.style.color='#8f9bb3';b.style.borderColor='#2a2a4a'};b.onclick=function(){b.disabled=true;b.textContent='…';fetch('/api/auth/logout',{method:'POST'}).catch(function(){}).finally(function(){window.location.href='/login'})};document.body.appendChild(b)})})();</script>`
  const renderIndex = async (): Promise<string> => {
    const html = ctx.webServer.applyIndexTaps(await readFile(config.distIndex, 'utf8'))
    return html.includes('</body>') ? html.replace('</body>', `${logoutWidget}</body>`) : html + logoutWidget
  }

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
