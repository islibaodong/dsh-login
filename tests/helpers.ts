import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

/** Fresh temp path for one OwnershipIndex data file. */
export function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-login-own-')), 'ownership.json')
}

/**
 * Structural webServer fake recording both route registries (modeled on the
 * upstream fixture in packages/client/connection/tests/node-half.host.spec.ts).
 */
export function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): { register: (route: WebRoute) => () => void; registerUpgrade: (route: WebUpgradeRoute) => () => void; registerFallback: (handler: WebRoute['handler']) => () => void; tapIndex: (transform: (html: string) => string) => () => void; port: number } {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    registerFallback() {
      return () => {}
    },
    tapIndex: () => () => {},
    port: 0,
  }
}
