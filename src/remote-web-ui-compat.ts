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
 * `{ enabled: true, requirePairingForLan: false }` under
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
 * Force remote-web-ui's `requirePairingForLan` to the given value. Hot-applies
 * (the plugin re-reads it per request) and persists through the settings
 * provider. Best-effort: absent settings or an unregistered namespace is a
 * graceful skip, never a boot failure.
 */
export class RemoteWebUiCompat {
  constructor(private readonly deps: RemoteWebUiCompatDeps) {}

  /** Write `requirePairingForLan` to `enabled` (i.e. `false` = keep /api open). */
  async apply(compatEnabled: boolean): Promise<CompatApplyResult> {
    const settings = this.deps.getSettings()
    if (settings === undefined) return 'skipped'
    // remote-web-ui only registers its host routes (/remote, /api/pair/*) when
    // its own `enabled` is true; a compat-ON toggle must therefore BOTH mount
    // the host AND open the pairing gate — otherwise the server answers nothing
    // and the client fail-closes onto a dead /remote (405 wall). Compat-OFF
    // restores the pairing requirement (route registration is not our concern).
    const patch = compatEnabled
      ? { enabled: true, requirePairingForLan: false }
      : { requirePairingForLan: true }
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

/**
 * Call `apply` now and, if the target is not yet writable — the settings
 * service may not be mounted yet (`skipped`) or remote-web-ui may apply after
 * dsh-login (`unregistered`) — retry on a short interval until one lands or
 * the budget is spent, so the boot-time default reaches remote-web-ui's
 * settings snapshot reliably. Returns the last non-`ok` outcome on exhaustion.
 */
export async function applyWithRetry(compat: RemoteWebUiCompat, enabled: boolean, attempts = 60, delayMs = 250): Promise<CompatApplyResult> {
  let last: CompatApplyResult = 'unregistered'
  for (let i = 0; i < attempts; i++) {
    const result = await compat.apply(enabled)
    if (result === 'ok') return 'ok'
    last = result
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
  }
  return last
}