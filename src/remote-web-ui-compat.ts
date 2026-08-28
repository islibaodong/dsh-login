/**
 * Compatibility with `@linxin666/dsh-remote-web-ui`.
 *
 * That plugin gates its `/remote/api` desktop channel behind a **device-pairing**
 * gate (`requirePairingForLan`, default true): opening the Web GUI from a
 * non-loopback origin (a public FRP host) rewrites the client onto `/remote`,
 * and an unpaired device gets `401 authentication required` — independent of
 * dsh-login's own multi-user `/api` auth (which is working).
 *
 * Instead of requiring that popular community plugin to change, dsh-login flips
 * one of its own settings values: `requirePairingForLan` is a **live,
 * settings-backed** config on remote-web-ui (`settingsNamespace('remote-web-ui')`),
 * re-read per request by its gate and `/remote` routes. Writing
 * `requirePairingForLan: false` makes non-loopback desktop traffic stay on the
 * ordinary `/api` channel — which dsh-login takes over and gates by the
 * `dsh_session` cookie — so ordinary users can use the model dialog / history /
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
  async apply(enabled: boolean): Promise<CompatApplyResult> {
    const settings = this.deps.getSettings()
    if (settings === undefined) return 'skipped'
    try {
      await settings.update(REMOTE_WEB_UI_NAMESPACE, { requirePairingForLan: !enabled })
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