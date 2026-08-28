/**
 * Compatibility with `@linxin666/dsh-remote-web-ui`.
 *
 * That plugin gates its `/remote/api` desktop channel behind a **device-pairing**
 * gate (`requirePairingForLan`, default true): opening the Web GUI from a
 * non-loopback origin (a public FRP host) rewrites the client onto `/remote`,
 * and an unpaired device gets `401 authentication required` — independent of
 * dsh-login's own multi-user `/api` auth (which is working).
 *
 * Instead of requiring that popular community plugin to change, dsh-login writes
 * one of its settings documents: when the compat toggle is on it sets
 * `{ enabled: true, requirePairingForLan: false, publicBaseUrl? }` under
 * `settingsNamespace('remote-web-ui')` (merged, live, re-read per request).
 * `enabled:true` is what actually makes remote-web-ui register its host routes
 * (`/remote` prefix, `/api/pair/*`) — without it the server answers nothing and
 * the client fail-closes onto a dead `/remote` (405 wall) — while
 * `requirePairingForLan:false` keeps non-loopback desktop traffic on the
 * ordinary `/api` channel that dsh-login takes over and gates by the
 * `dsh_session` cookie. So ordinary users can use the model dialog / history /
 * composer over a public tunnel without pairing, and with no change to the
 * remote-web-ui plugin.
 *
 * A public FRP / tunnel host also needs `publicBaseUrl` set in that plugin so
 * its phone-facing `/api/pair/*` fence (Host-header based) trusts the public
 * origin — otherwise the browser at that origin gets 403 on `/api/pair/status`
 * and the client still fail-closes onto `/remote`. dsh-login writes it too when
 * the admin configures `remoteWebUiPublicBaseUrl`.
 *
 * This module is a no-op whenever remote-web-ui is not installed (its settings
 * namespace is not registered) or the settings service is absent.
 */
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'

/** The settings namespace remote-web-ui registers its own config into. */
export const REMOTE_WEB_UI_NAMESPACE = settingsNamespace('remote-web-ui')

/** Outcome of one attempted write to the remote-web-ui namespace. */
export type CompatApplyResult = 'ok' | 'skipped' | 'unregistered'

/** The minimal settings surface this module needs (narrow seam for tests). */
export interface RemoteWebUiCompatDeps {
  /** Resolve the live settings service; undefined => nothing to write to. */
  getSettings: () => Pick<SettingsProvider, 'update'> | undefined
}

/**
 * Force remote-web-ui's pairing configuration to the given value. Hot-applies
 * (the plugin re-reads it per request) and persists through the settings
 * provider. Best-effort: absent settings or an unregistered namespace is a
 * graceful skip, never a boot failure.
 */
export class RemoteWebUiCompat {
  constructor(private readonly deps: RemoteWebUiCompatDeps) {}

  /**
   * Apply the compat document to remote-web-ui's settings namespace.
   * @param compatEnabled - when true, mount the host routes and open the pairing
   * gate; when false, restore the pairing requirement only.
   * @param publicBaseUrl - optional public base URL (e.g. `http://host:port`) to
   * write so remote-web-ui's `/api/pair/*` fence trusts the public origin. Only
   * written when compat is on and the value is a non-empty http(s) URL.
   */
  async apply(compatEnabled: boolean, publicBaseUrl?: string): Promise<CompatApplyResult> {
    const settings = this.deps.getSettings()
    if (settings === undefined) return 'skipped'
    // remote-web-ui only registers its host routes (/remote, /api/pair/*) when
    // its own `enabled` is true; a compat-ON toggle must therefore BOTH mount
    // the host AND open the pairing gate — otherwise the server answers nothing
    // and the client fail-closes onto a dead /remote (405 wall). Compat-OFF
    // restores the pairing requirement (route registration is not our concern).
    let patch: Record<string, unknown>
    if (compatEnabled) {
      patch = { enabled: true, requirePairingForLan: false }
      if (typeof publicBaseUrl === 'string' && isHttpUrl(publicBaseUrl)) patch.publicBaseUrl = publicBaseUrl
    } else {
      patch = { requirePairingForLan: true }
    }
    try {
      // settings.update merges, so `enabled:true` layers over without clobbering
      // remote-web-ui's other settings.
      await settings.update(REMOTE_WEB_UI_NAMESPACE, patch)
      return 'ok'
    } catch (error) {
      // The namespace exists only while remote-web-ui is installed and applied.
      if (String(error instanceof Error ? error.message : error).includes('not registered')) return 'unregistered'
      throw error
    }
  }
}

/** Whether a string is a parseable http(s) URL with a host (mirror of remote-web-ui). */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Call `apply` now and, if the target is not yet writable — the settings
 * service may not be mounted yet (`skipped`) or remote-web-ui may apply after
 * dsh-login (`unregistered`) — retry on a short interval until one lands or
 * the budget is spent, so the boot-time default reaches remote-web-ui's
 * settings snapshot reliably. Returns the last non-`ok` outcome on exhaustion.
 */
export async function applyWithRetry(compat: RemoteWebUiCompat, enabled: boolean, publicBaseUrl?: string, attempts = 60, delayMs = 250): Promise<CompatApplyResult> {
  let last: CompatApplyResult = 'unregistered'
  for (let i = 0; i < attempts; i++) {
    const result = await compat.apply(enabled, publicBaseUrl)
    if (result === 'ok') return 'ok'
    last = result
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
  }
  return last
}