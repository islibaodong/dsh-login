import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'

/** Values of the `webRuntime` service dsh-login provides when taking over. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: string[]
}

/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Resolve one LAN-trust snapshot from the active server bind — the same
 * derivation dsh-web-app's resolveLanTrust performs (LAN IPv4 literals when
 * bound to all interfaces, plus the explicit extras).
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * Resolve the frontend dist anchor through @deepseek-ai/dsh-web-frontend's
 * package exports, exactly like dsh-web-app's internals.resolveDistIndex.
 * Throws with a build hint when the dist is not built.
 */
export function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    throw new Error('dsh-login: frontend dist not found; run pnpm run build from the deepseek-harness repository root first, or set config.distIndex explicitly')
  }
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL'

/**
 * Provide the `webRuntime` service and the DSH_WEB_URL shell variable —
 * the parts of dsh-web-app's web-runtime row the rest of the composition
 * depends on once that row is disabled in favor of dsh-login.
 */
export function provideWebRuntime(ctx: Context, trustedHosts: readonly string[]): WebRuntimeValues {
  const runtime = resolveLanTrust(ctx.webServer.host, trustedHosts)
  ctx.provide('webRuntime', runtime)
  // Keep the bash-visible web URL alive for agent sessions.
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv !== undefined) {
    ctx.effect(() => shellEnv.register({
      name: 'web-runtime',
      variables: {
        [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
      },
      resolve: () => {
        const port = ctx.get('webServer')?.port
        return { [DSH_WEB_URL]: port === undefined ? '' : `http://127.0.0.1:${String(port)}` }
      },
    }), 'dsh-login: DSH_WEB_URL shell variable')
  }
  return runtime
}
